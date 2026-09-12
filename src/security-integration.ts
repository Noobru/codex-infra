import {z} from 'zod';
import path from 'node:path';
import {EvidenceSanitizer} from './evidence.js';
import {atomicWriteJson,resolveRealSubPath} from './legacy/command-os-utils.js';
import {ProjectRegistry} from './registry.js';
import {
  CisaKevSecurityFeed,
  OsvSecurityFeed,
  SecurityFeedCorrelationService,
  SecurityFeedFindingSchema,
  SecurityFeedHttpClient,
} from './security-feeds.js';
import {GitHubCommitStatusPublisher} from './security-github-publisher.js';
import {
  LocalSecurityGateAdapter,
  LocalSecurityGateReceiptSchema,
  type LocalSecurityGateReceipt,
} from './security-report-publisher.js';
import {
  SecurityReportRequestSchema,
  SecurityReportService,
  type SecurityReportResult,
} from './security-report-service.js';
import {SecurityGateReceiptSchema,SecurityIsoDateSchema,type SecurityGateDecision} from './security-gate.js';

export const GITHUB_TOKEN_ENVIRONMENT_VARIABLE='CODEX_INFRA_GITHUB_TOKEN' as const;

const FeedRequestSchema=z.discriminatedUnion('mode',[
  z.object({mode:z.literal('disabled')}).strict(),
  z.object({mode:z.literal('enrich'),findings:z.array(SecurityFeedFindingSchema).min(1).max(50)}).strict(),
]);

/** Shared CLI/MCP input: feeds run only when mode=enrich is present explicitly. */
export const SecurityIntegrationRequestSchema=SecurityReportRequestSchema.extend({
  feeds:FeedRequestSchema.default({mode:'disabled'}),
});
export type SecurityIntegrationRequest=z.input<typeof SecurityIntegrationRequestSchema>;

const SecurityFeedProvenanceSchema=z.object({
  source:z.enum(['osv','cisa-kev']),url:z.string().url(),fetchedAt:SecurityIsoDateSchema,expiresAt:SecurityIsoDateSchema,
  bodySha256:z.string().regex(/^[0-9a-f]{64}$/),cacheHit:z.boolean(),etag:z.string().nullable(),lastModified:z.string().nullable(),
});

const SecurityFeedCorrelationReceiptSchema=z.object({
  version:z.literal(1),generatedAt:SecurityIsoDateSchema,expiresAt:SecurityIsoDateSchema,
  findings:z.array(z.object({findingId:z.string(),packageName:z.string(),installedVersion:z.string(),
    status:z.enum(['matched','not-matched']),osvIds:z.array(z.string()),cves:z.array(z.string()),knownExploited:z.boolean().nullable()})),
  assertions:z.array(z.object({findingId:z.string(),kind:z.literal('applicability'),value:z.literal(true),
    source:z.literal('scanner'),evidence:z.string()})),
  enrichments:z.array(z.object({findingId:z.string(),knownExploited:z.boolean(),source:z.string(),evidence:z.string(),expiresAt:SecurityIsoDateSchema})),
  provenance:z.object({osv:z.array(SecurityFeedProvenanceSchema),kev:SecurityFeedProvenanceSchema.nullable()}),
  unknowns:z.array(z.string()),
});

export const SecurityFeedIntegrationReceiptSchema=z.object({
  version:z.literal(1),
  mode:z.enum(['disabled','enrich']),
  status:z.enum(['DISABLED','READY','UNKNOWN']),
  unknowns:z.array(z.string()),
  error:z.string().nullable(),
  publicationSuppressed:z.boolean(),
  correlation:SecurityFeedCorrelationReceiptSchema.nullable(),
});
export type SecurityFeedIntegrationReceipt=z.output<typeof SecurityFeedIntegrationReceiptSchema>;

const EffectiveSecurityGateSchema=z.object({
  decision:SecurityGateReceiptSchema.shape.decision,
  blocking:z.boolean(),
  localGate:LocalSecurityGateReceiptSchema,
  commandExitCode:z.union([z.literal(0),z.literal(2),z.literal(3)]),
});

export const SecurityIntegrationStoredReceiptSchema=z.object({
  schemaVersion:z.literal(1),
  receiptType:z.literal('security-integration'),
  gateReceiptId:z.uuid(),
  projectId:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  reportHash:SecurityGateReceiptSchema.shape.reportHash,
  reportArtifactPath:z.string().regex(/^artifacts\/security-gates\//),
  artifactPath:z.string().regex(/^artifacts\/security-gates\//),
  recordedAt:SecurityIsoDateSchema,
  feed:SecurityFeedIntegrationReceiptSchema,
  effective:EffectiveSecurityGateSchema,
});
export type SecurityIntegrationStoredReceipt=z.output<typeof SecurityIntegrationStoredReceiptSchema>;

export interface SecurityIntegrationResult extends SecurityReportResult {
  report:SecurityReportResult;
  feed:SecurityFeedIntegrationReceipt;
  integrationArtifactPath:string;
  effective:{
    decision:SecurityGateDecision;
    blocking:boolean;
    localGate:LocalSecurityGateReceipt;
    commandExitCode:0|2|3;
  };
}

export interface SecurityIntegrationOptions {
  environment?:Readonly<Record<string,string|undefined>>;
  feeds?:SecurityFeedCorrelationService;
  feedHttpClient?:SecurityFeedHttpClient;
  githubBaseUrl?:string;
  githubApiVersion?:string;
  githubContext?:string;
}

/** Canonical composition boundary for feed enrichment, local gating and optional status publication. */
export class SecurityIntegrationFacade {
  private readonly environment:Readonly<Record<string,string|undefined>>;
  private readonly feeds:SecurityFeedCorrelationService;
  private readonly localGate=new LocalSecurityGateAdapter();

  constructor(
    private readonly root:string,
    private readonly registry:ProjectRegistry,
    private readonly options:SecurityIntegrationOptions={},
  ){
    this.environment=options.environment??process.env;
    const http=options.feedHttpClient??new SecurityFeedHttpClient();
    this.feeds=options.feeds??new SecurityFeedCorrelationService(new OsvSecurityFeed(http),new CisaKevSecurityFeed(http));
  }

  async evaluate(project:string,rawInput:SecurityIntegrationRequest):Promise<SecurityIntegrationResult>{
    const request=SecurityIntegrationRequestSchema.parse(rawInput);
    const profile=await this.registry.resolve(project);
    const feed=await this.enrich(request.feeds);
    const publicationSuppressed=feed.status==='UNKNOWN'&&request.publication.mode==='publish';
    const publishers=profile.securityPublisher?[new GitHubCommitStatusPublisher({
      id:profile.securityPublisher.id,
      token:this.environment[GITHUB_TOKEN_ENVIRONMENT_VARIABLE],
      ...(this.options.githubBaseUrl?{baseUrl:this.options.githubBaseUrl}:{}),
      ...(this.options.githubApiVersion?{apiVersion:this.options.githubApiVersion}:{}),
      ...(this.options.githubContext?{context:this.options.githubContext}:{}),
    })]:[];
    const {feeds:_feeds,...baseRequest}=request;
    const merged={
      ...baseRequest,
      assertions:[...baseRequest.assertions,...(feed.correlation?.assertions??[])],
      enrichments:[...baseRequest.enrichments,...(feed.correlation?.enrichments??[])],
      publication:publicationSuppressed?{...baseRequest.publication,mode:'dry-run' as const}:baseRequest.publication,
    };
    const report=await new SecurityReportService(this.root,this.registry,{publishers,integrationRequired:true}).evaluate(project,merged);
    const preserveKnownBlock=['BLOCK','EXCEPTION_REQUIRED'].includes(report.decision);
    const decision=feed.status==='UNKNOWN'&&!preserveKnownBlock?'UNKNOWN':report.decision;
    const blocking=report.blocking||(feed.status==='UNKNOWN'&&report.subject.stage==='deploy-production');
    const effectiveChanged=decision!==report.decision||blocking!==report.blocking;
    const localGate=effectiveChanged?this.localGate.map({...report,decision,blocking}):report.localGate;
    const completeFeed=SecurityFeedIntegrationReceiptSchema.parse({...feed,publicationSuppressed});
    const effective=EffectiveSecurityGateSchema.parse({decision,blocking,localGate,commandExitCode:publicationSuppressed?3
      :feed.status==='UNKNOWN'?localGate.exitCode:report.commandExitCode});
    const integration=await this.recordIntegration(report,completeFeed,effective);
    return {
      ...report,...effective,
      report,
      feed:completeFeed,
      integrationArtifactPath:integration.artifactPath,
      effective,
    };
  }

  private async enrich(request:z.output<typeof FeedRequestSchema>):Promise<Omit<SecurityFeedIntegrationReceipt,'publicationSuppressed'>>{
    if(request.mode==='disabled')return {version:1,mode:'disabled',status:'DISABLED',unknowns:[],error:null,correlation:null};
    try{
      const correlation=await this.feeds.correlate(request.findings);
      return {version:1,mode:'enrich',status:correlation.unknowns.length?'UNKNOWN':'READY',
        unknowns:correlation.unknowns,error:null,correlation};
    }catch(error){
      return {version:1,mode:'enrich',status:'UNKNOWN',unknowns:['security_feeds_unavailable'],
        error:EvidenceSanitizer.text(error instanceof Error?error.message:String(error),2000),correlation:null};
    }
  }

  private async recordIntegration(
    report:SecurityReportResult,
    feed:SecurityFeedIntegrationReceipt,
    effective:z.output<typeof EffectiveSecurityGateSchema>,
  ):Promise<SecurityIntegrationStoredReceipt>{
    const reportDirectory=path.dirname(path.resolve(this.root,report.artifactPath));
    const ownedDirectory=await resolveRealSubPath(reportDirectory,this.root);
    if(!ownedDirectory)throw new Error('Security integration receipt directory must remain inside the infrastructure root');
    const file=path.join(ownedDirectory,report.receiptId+'.integration.json');
    const artifactPath=path.relative(this.root,file).split(path.sep).join('/');
    const receipt=SecurityIntegrationStoredReceiptSchema.parse({schemaVersion:1,receiptType:'security-integration',
      gateReceiptId:report.receiptId,projectId:report.projectId,reportHash:report.reportHash,
      reportArtifactPath:report.artifactPath,artifactPath,recordedAt:new Date().toISOString(),feed,effective});
    await atomicWriteJson(file,receipt);
    return receipt;
  }
}
