import fs from 'node:fs/promises';
import path from 'node:path';
import {ExecutionPolicyManager,type ExecutionPolicy} from './execution-policy.js';
import {EvidenceSanitizer} from './evidence.js';
import {KnowledgeLearningStore} from './knowledge-learning.js';
import {InteractionStore,type InteractionListInput,type InteractionListResult} from './interactions.js';
import {readJson,resolveRealSubPath} from './legacy/command-os-utils.js';
import {
  SecurityGateStoredReceiptSchema,
  SecurityPublicationResultReceiptSchema,
} from './security-report-publisher.js';
import {SecurityIntegrationStoredReceiptSchema} from './security-integration.js';
import {StateStore,type JobStatus} from './state.js';
import {WorkflowStore} from './workflow.js';

type NullableSource<T>=T|null;
type ActiveWorker={id:string;projectId:string;status:JobStatus;attempts:number;ownerPid:number|null;
  executionKind:'checks'|'codex';resourceKey:string};
type WorkflowSummary={id:string;objective:string;revision:number;state:'preparing'|'prepared'|'superseded';
  nodes:{id:string;jobId:string|null;status:JobStatus|null}[];evidence:string};
type LearningSummary={id:string;title:string;projectId:string;status:string;review:string|null;shadow:string|null;
  promotionPath:string|null;evidence:string[];originJobId:string|null;originInteractionId:string|null;originInteractionRevision:number|null};
type SecuritySummary={receiptId:string;projectId:string;stage:string;decision:string;effectiveExit:0|2|3|null;
  feedStatus:'DISABLED'|'READY'|'UNKNOWN'|null;publicationStatus:string|null;evidence:string[]};

export interface OperationsObservationResult {
  policy:NullableSource<ExecutionPolicy>;
  activeWorkers:NullableSource<ActiveWorker[]>;
  workflows:NullableSource<WorkflowSummary[]>;
  learning:NullableSource<LearningSummary[]>;
  interactions:NullableSource<InteractionListResult>;
  security:NullableSource<SecuritySummary[]>;
  warnings:string[];
}

/** Read-only operational projection for dashboards. It never resolves registered product roots. */
export class OperationsObservation {
  private readonly root:string;
  constructor(root:string){this.root=path.resolve(root);}

  async read(projectId?:string,interactionOptions:Pick<InteractionListInput,'offset'|'limit'|'status'>={}):Promise<OperationsObservationResult>{
    const warnings:string[]=[];
    const [policy,stateProjection,learning,security,interactions]=await Promise.all([
      this.policy(warnings),this.stateProjection(projectId,warnings),this.learning(projectId,warnings),this.security(projectId,warnings),
      this.interactions(projectId,interactionOptions,warnings),
    ]);
    const {activeWorkers,workflows}=stateProjection;
    return {policy,activeWorkers,workflows,learning,security,interactions,warnings:[...new Set(warnings)]};
  }

  private async interactions(projectId:string|undefined,options:Pick<InteractionListInput,'offset'|'limit'|'status'>,warnings:string[]):Promise<InteractionListResult|null>{
    try{
      const result=await new InteractionStore(this.root).list({projectId,...options,limit:options.limit??50});
      warnings.push(...result.warnings.map(message=>'interactions:'+EvidenceSanitizer.text(message,300)));
      return result;
    }catch{warnings.push('interactions:unavailable');return null;}
  }

  private async stateProjection(projectId:string|undefined,warnings:string[]):Promise<{
    activeWorkers:ActiveWorker[]|null;workflows:WorkflowSummary[]|null;
  }>{
    let state:StateStore|null=null,activeWorkers:ActiveWorker[]|null=null;
    try{
      const stateFile=await this.ownedFile('state/jobs.sqlite');
      if(!stateFile)activeWorkers=[];
      else{
        try{
          state=new StateStore(stateFile,{readOnly:true});
          activeWorkers=state.list().filter(job=>['running','validating'].includes(job.status)&&(!projectId||job.projectId===projectId))
            .map(job=>({id:job.id,projectId:job.projectId,status:job.status,attempts:job.attempts,ownerPid:job.ownerPid,...state!.resource(job.id)}));
        }catch{warnings.push('state:unavailable');activeWorkers=null;state?.close();state=null;}
      }
      return {activeWorkers,workflows:await this.workflows(state,projectId,warnings)};
    }finally{
      state?.close();
    }
  }

  private async policy(warnings:string[]):Promise<ExecutionPolicy|null>{
    try{
      const profiles=await this.ownedDirectory('profiles');
      if(!profiles)return ExecutionPolicyManager.read(this.root);
      return await ExecutionPolicyManager.read(this.root);
    }catch{warnings.push('policy:unavailable');return null;}
  }

  private async workflows(state:StateStore|null,projectId:string|undefined,warnings:string[]):Promise<WorkflowSummary[]|null>{
    try{
      if(!await this.ownedDirectory('artifacts/workflows'))return [];
      const plans=await new WorkflowStore(this.root).list();
      const eligible=plans.filter(plan=>!projectId||plan.nodes.some(node=>{
        if(node.jobId&&state){try{return state.get(node.jobId).projectId===projectId;}catch{return false;}}
        return node.task.project===projectId;
      })).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      if(eligible.length>100)warnings.push(`workflows:truncated:${eligible.length}-to-100`);
      return eligible.slice(0,100).map(plan=>({id:plan.id,objective:EvidenceSanitizer.text(plan.objective,500),
        revision:plan.revision,state:plan.state,nodes:plan.nodes.map(node=>({id:node.id,jobId:node.jobId??null,
          status:node.jobId&&state?this.jobStatus(state,node.jobId,warnings):null})),
        evidence:`artifacts/workflows/${plan.id}/revision-${plan.revision}.json`}));
    }catch{warnings.push('workflows:unavailable');return null;}
  }

  private async learning(projectId:string|undefined,warnings:string[]):Promise<LearningSummary[]|null>{
    try{
      if(!await this.ownedDirectory('artifacts/learning'))return [];
      const inventory=await new KnowledgeLearningStore(this.root).list(projectId);
      warnings.push(...inventory.warnings.map(item=>'learning:'+EvidenceSanitizer.text(item,300)));
      const items=[...inventory.items].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
      if(items.length>100)warnings.push(`learning:truncated:${items.length}-to-100`);
      return items.slice(0,100).map(item=>({id:item.id,title:EvidenceSanitizer.text(item.title,300),projectId:item.projectId,
        status:item.status,review:item.review?.decision??null,shadow:item.shadow?.status??null,
        promotionPath:this.relativeEvidence(item.promotion?.path)??null,
        evidence:[item.artifactPath,...item.originEvidence.refs].map(ref=>this.relativeEvidence(ref))
          .filter((ref):ref is string=>Boolean(ref)).filter((ref,index,all)=>all.indexOf(ref)===index).slice(0,20),
        originJobId:'jobId' in item.origin?item.origin.jobId:null,
        originInteractionId:'interactionId' in item.origin?item.origin.interactionId:null,
        originInteractionRevision:'interactionId' in item.origin?item.origin.revision:null}));
    }catch{warnings.push('learning:unavailable');return null;}
  }

  private async security(projectId:string|undefined,warnings:string[]):Promise<SecuritySummary[]|null>{
    try{
      const directory=await this.ownedDirectory('artifacts/security-gates');
      if(!directory)return [];
      const publications=await this.ownedDirectory('artifacts/security-publications');
      const names=(await fs.readdir(directory)).filter(name=>/^[0-9a-f-]{36}\.json$/i.test(name));
      const gates=[];
      for(const name of names){
        try{
          const file=path.join(directory,name),relative=this.relative(file);
          const gate=SecurityGateStoredReceiptSchema.parse(await this.boundedJson(file));
          if(gate.artifactPath!==relative)throw new Error('binding');
          if(!projectId||gate.projectId===projectId)gates.push({gate,file,relative});
        }catch{warnings.push(`security:${path.basename(name,'.json')}:gate_unavailable`);}
      }
      gates.sort((a,b)=>b.gate.recordedAt.localeCompare(a.gate.recordedAt));
      if(gates.length>50)warnings.push(`security:truncated:${gates.length}-to-50`);
      const summaries:SecuritySummary[]=[];
      for(const entry of gates.slice(0,50))summaries.push(await this.securitySummary(entry.gate,entry.file,entry.relative,publications,warnings));
      return summaries;
    }catch{warnings.push('security:unavailable');return null;}
  }

  private async securitySummary(
    gate:ReturnType<typeof SecurityGateStoredReceiptSchema.parse>,gateFile:string,gateEvidence:string,
    publications:string|null,warnings:string[],
  ):Promise<SecuritySummary>{
    const evidence=[gateEvidence];let decision:string=gate.decision,effectiveExit:0|2|3|null=gate.localGate.exitCode;
    let feedStatus:'DISABLED'|'READY'|'UNKNOWN'|null=null,validIntegration=false,publicationStatus:string|null=null;
    const integrationFile=path.join(path.dirname(gateFile),gate.receiptId+'.integration.json');
    const integrationExists=await this.ownedFile(this.relative(integrationFile));
    if(integrationExists){
      try{
        const integration=SecurityIntegrationStoredReceiptSchema.parse(await this.boundedJson(integrationExists));
        const relative=this.relative(integrationExists);
        if(integration.gateReceiptId!==gate.receiptId||integration.projectId!==gate.projectId
          ||integration.reportHash!==gate.reportHash||integration.reportArtifactPath!==gate.artifactPath
          ||integration.artifactPath!==relative)throw new Error('binding');
        validIntegration=true;decision=integration.effective.decision;effectiveExit=integration.effective.commandExitCode;
        feedStatus=integration.feed.status;evidence.push(relative);
      }catch{warnings.push(`security:${gate.receiptId}:integration_invalid`);}
    }
    if(gate.integrationRequired&&!validIntegration){
      decision='UNKNOWN';effectiveExit=null;feedStatus='UNKNOWN';warnings.push(`security:${gate.receiptId}:integration_missing`);
    }
    if(publications){
      const publicationFile=await this.ownedFile(this.relative(path.join(publications,gate.receiptId+'.result.json')));
      if(publicationFile){
        try{
          const publication=SecurityPublicationResultReceiptSchema.parse(await this.boundedJson(publicationFile));
          const relative=this.relative(publicationFile);
          if(publication.gateReceiptId!==gate.receiptId||publication.artifactPath!==relative)throw new Error('binding');
          publicationStatus=publication.status;evidence.push(relative);
        }catch{warnings.push(`security:${gate.receiptId}:publication_invalid`);}
      }
    }
    return {receiptId:gate.receiptId,projectId:gate.projectId,stage:gate.subject.stage,decision,effectiveExit,
      feedStatus,publicationStatus,evidence};
  }

  private jobStatus(state:StateStore,id:string,warnings:string[]):JobStatus|null{
    try{return state.get(id).status;}catch{warnings.push(`workflows:${id}:job_unavailable`);return null;}
  }

  private relativeEvidence(value:string|undefined):string|null{
    if(!value||path.isAbsolute(value))return null;
    const normalized=value.replaceAll('\\','/');
    return normalized.split('/').includes('..')?null:normalized;
  }

  private relative(file:string):string{return path.relative(this.root,file).split(path.sep).join('/');}

  private async ownedDirectory(relative:string):Promise<string|null>{
    const candidate=path.join(this.root,relative);
    let stat;
    try{stat=await fs.lstat(candidate);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('unsafe directory');
    return await resolveRealSubPath(candidate,this.root)??Promise.reject(new Error('unsafe directory'));
  }

  private async ownedFile(relative:string):Promise<string|null>{
    const candidate=path.join(this.root,relative);
    let stat;
    try{stat=await fs.lstat(candidate);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('unsafe file');
    return await resolveRealSubPath(candidate,this.root)??Promise.reject(new Error('unsafe file'));
  }

  private async boundedJson(file:string):Promise<unknown>{
    const stat=await fs.stat(file);if(stat.size>2*1024*1024)throw new Error('record too large');
    return readJson(file,null);
  }

}
