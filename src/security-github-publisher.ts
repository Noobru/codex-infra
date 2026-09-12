import { z } from 'zod';
import {
  SecurityExternalPublicationReceiptSchema,
  SecurityStatusProposalSchema,
  type SecurityExternalPublicationReceipt,
  type SecurityStatusProposal,
  type SecurityStatusPublisher,
} from './security-report-publisher.js';
import {readBoundedHttpBody} from './security-feeds.js';

type FetchLike=typeof fetch;
const GitHubResponseSchema=z.object({
  id:z.union([z.number().int(),z.string().min(1)]),url:z.string().url(),created_at:z.string().refine(value=>Number.isFinite(Date.parse(value))),
});

/** GitHub Commit Status transport. SecurityReportService remains the authorization and dry-run boundary. */
export class GitHubCommitStatusPublisher implements SecurityStatusPublisher {
  readonly kind='github-check' as const;
  readonly id:string;
  private readonly token:string|undefined;
  private readonly baseUrl:string;
  private readonly apiVersion:string;
  private readonly context:string;
  private readonly timeoutMs:number;
  private readonly fetcher:FetchLike;

  constructor(options:{id?:string;token?:string;baseUrl?:string;apiVersion?:string;context?:string;timeoutMs?:number;fetcher?:FetchLike}={}){
    this.id=options.id??'github-status';
    this.token=options.token;
    this.baseUrl=(options.baseUrl??'https://api.github.com').replace(/\/$/,'');
    this.apiVersion=options.apiVersion??'2026-03-10';
    this.context=options.context??'codex-infra/security-policy';
    this.timeoutMs=Math.min(Math.max(options.timeoutMs??10_000,100),30_000);
    this.fetcher=options.fetcher??fetch;
    this.assertBaseUrl(this.baseUrl);
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(this.id))throw new Error('github_status_publisher_id_invalid');
    if(!this.context.trim()||this.context.length>100)throw new Error('github_status_context_invalid');
  }

  propose({projectId,config,gate}:Parameters<SecurityStatusPublisher['propose']>[0]):SecurityStatusProposal{
    if(config.id!==this.id||config.kind!==this.kind)throw new Error('github_status_publisher_config_mismatch');
    this.parseTarget(config.target);
    return SecurityStatusProposalSchema.parse({
      version:1,publisherId:this.id,kind:this.kind,target:config.target,projectId,
      sha:gate.subject.sha,stage:gate.subject.stage,decision:gate.decision,blocking:gate.blocking,
      reportHash:gate.reportHash,summary:('security-policy-v1 '+gate.decision+'; local exit '+gate.localGate.exitCode).slice(0,140),
    });
  }

  async publish(proposal:SecurityStatusProposal,options:{idempotencyKey:string;intentArtifactPath:string}):Promise<SecurityExternalPublicationReceipt>{
    const parsed=SecurityStatusProposalSchema.parse(proposal);
    if(parsed.publisherId!==this.id||parsed.kind!==this.kind)throw new Error('github_status_proposal_mismatch');
    if(!this.token)throw new Error('github_status_token_missing');
    if(!options.idempotencyKey||!options.intentArtifactPath)throw new Error('github_status_intent_missing');
    const {owner,repo}=this.parseTarget(parsed.target);
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    let response:Response;let bytes:Uint8Array;
    try{
      response=await this.fetcher(this.baseUrl+'/repos/'+encodeURIComponent(owner)+'/'+encodeURIComponent(repo)+'/statuses/'+parsed.sha,{
        method:'POST',signal:controller.signal,redirect:'error',headers:{accept:'application/vnd.github+json',authorization:'Bearer '+this.token,
          'content-type':'application/json','user-agent':'CodexInfra-SecurityPublisher/1','x-github-api-version':this.apiVersion},
        body:JSON.stringify({state:parsed.blocking?'failure':'success',description:parsed.summary.slice(0,140),context:this.context}),
      });
      if(response.status!==201)throw new Error('github_status_http_'+response.status);
      bytes=await readBoundedHttpBody(response,1024*1024,'github_status_response_too_large');
    }finally{clearTimeout(timer);}
    let raw:unknown;
    try{raw=JSON.parse(Buffer.from(bytes).toString('utf8'));}catch{throw new Error('github_status_invalid_json');}
    const result=GitHubResponseSchema.parse(raw);
    return SecurityExternalPublicationReceiptSchema.parse({externalId:String(result.id),publishedAt:result.created_at,url:result.url});
  }

  private parseTarget(target:string):{owner:string;repo:string}{
    const match=/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(target);
    if(!match)throw new Error('github_status_target_invalid');
    return {owner:match[1]!,repo:match[2]!};
  }

  private assertBaseUrl(value:string):void{
    const url=new URL(value);const loopback=['127.0.0.1','localhost','::1'].includes(url.hostname);
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))throw new Error('github_status_url_not_allowed');
  }
}
