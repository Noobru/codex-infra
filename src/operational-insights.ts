import path from 'node:path';
import { z } from 'zod';
import { EvaluationStore, type EvaluationComparison, type EvaluationInput, type EvaluationReceipt } from './evaluation.js';
import { ObservationReader } from './observability.js';
import { StateStore, type JobEvent } from './state.js';
import { KnowledgeFiles } from './knowledge-store.js';
import { EvidenceSanitizer } from './evidence.js';

const policyVersion = 'operational-insights/v1';
const optionsSchema = z.object({projectId:z.string().min(1).optional(),limit:z.number().int().min(1).max(100).default(50)});
// Only receipt metadata is inspected. Executables, arguments and CWD are hashed, never executed or exposed.
const commandReceipts = z.array(z.object({checkId:z.string(),executable:z.string().optional(),args:z.array(z.string()).optional(),cwd:z.string().optional()}));
type Run = Awaited<ReturnType<ObservationReader['run']>>;
type Attempt = Run['attempts'][number];
type AttemptWindow = {start:string;end:string;eventIds:number[]};
export interface AttemptExecutionEvidence {
  jobId:string;attempt:number;projectId:string;window:AttemptWindow|null;contractFingerprint:string;
  performanceScope:NonNullable<Attempt['taskContract']>['performanceScope'];
  checks:{checkId:string;cohort:string|null}[];evidence:string[];
}
export interface InsightCapture {evaluationIds:string[];created:number;reused:number;warnings:string[]}
export interface InsightComparison {id:string;projectId:string;metricLabel:string;baselineJobId:string;treatmentJobId:string;reason:string;evidence:string[];comparison:EvaluationComparison}
export interface OperationalSignal {
  id:string;projectId:string;jobId:string;kind:'recovery'|'repeated-failure';reason:string;evidence:string[];attempts:number[];
}
export interface InsightObservation {comparisons:InsightComparison[];signals:OperationalSignal[];warnings:string[];truncated:boolean}

/** Post-execution evidence processing. Reads never dispatch work, infer owner acceptance or create learning proposals. */
export class OperationalInsights {
  private readonly evaluations:EvaluationStore;
  private readonly files:KnowledgeFiles;
  constructor(readonly root:string) { this.evaluations=new EvaluationStore(root);this.files=new KnowledgeFiles(root); }

  /** Read the captured execution boundary and check identities without creating an evaluation. */
  async executionEvidence(jobId:string) {
    z.uuid().parse(jobId);const reader=new ObservationReader(this.root);let run:Run;
    try{run=await reader.run(jobId);}finally{reader.close();}
    const state=new StateStore(path.join(this.root,'state/jobs.sqlite'),{readOnly:true});let windows:Map<number,AttemptWindow>;
    try{windows=this.attemptWindows(state.events(jobId));}finally{state.close();}
    const attempts:AttemptExecutionEvidence[]=[],warnings=[...run.warnings];
    for(const attempt of run.attempts) {
      try {
        const captured=await this.commandContext(run,attempt);if(!captured)continue;
        const window=windows.get(attempt.attempt)??null;
        attempts.push({jobId,attempt:attempt.attempt,projectId:run.summary.projectId,window,contractFingerprint:KnowledgeFiles.hash(JSON.stringify(captured.signature)),
          performanceScope:(attempt.taskContract??run.prepared.taskContract)?.performanceScope??null,checks:captured.checks,
          evidence:[captured.evidencePath,...run.evidence.filter(ref=>ref.endsWith('/task-contract.json')&&ref.includes(`/attempt-${attempt.attempt}/`)),
            ...(window?[`state/jobs.sqlite:job_events:${window.eventIds.join(',')}`]:[])]});
      }catch(error){warnings.push(`${jobId}/attempt-${attempt.attempt}: ${this.error(error)}`);}
    }
    return {attempts,warnings,truncated:run.observations.attemptsTruncated};
  }

  async captureJob(jobId:string):Promise<InsightCapture> {
    z.uuid().parse(jobId);
    const result:InsightCapture={evaluationIds:[],created:0,reused:0,warnings:[]};
    const reader=new ObservationReader(this.root);
    let run:Run;
    try {run=await reader.run(jobId);} finally {reader.close();}
    const state=new StateStore(path.join(this.root,'state/jobs.sqlite'),{readOnly:true});
    let windows:Map<number,AttemptWindow>;
    try {windows=this.attemptWindows(state.events(jobId));} finally {state.close();}
    // A previous processing warning is displayed by the reader, not fed back into its next capture.
    result.warnings.push(...run.warnings.filter(warning=>!warning.includes('insights.json:')));
    for(const attempt of run.attempts) {
      const window=windows.get(attempt.attempt);
      // A current validating/running attempt is not a final snapshot, even if checks.json already exists.
      if(!window||!attempt.checks?.length)continue;
      if(attempt.checksTruncated){result.warnings.push(`${jobId}/attempt-${attempt.attempt}: checks truncated; automatic capture skipped.`);continue;}
      try {
        const input=await this.evaluationInput(run,attempt,window);
        if(!input){result.warnings.push(`${jobId}/attempt-${attempt.attempt}: immutable named-check contract unavailable.`);continue;}
        const sourceKey=KnowledgeFiles.hash(JSON.stringify({policyVersion,jobId,attempt:attempt.attempt,
          contract:attempt.taskContract??run.prepared.taskContract,checks:attempt.checks,input}));
        const saved=await this.evaluations.recordOnce(input,`${policyVersion}:${sourceKey}`);
        result.evaluationIds.push(saved.receipt.id);
        if(saved.created)result.created++;else result.reused++;
      } catch(error) {result.warnings.push(`${jobId}/attempt-${attempt.attempt}: ${this.error(error)}`);}
    }
    result.warnings=[...new Set(result.warnings)];
    return result;
  }

  async reconcile(raw:{projectId?:string;limit?:number}={}) {
    const options=optionsSchema.parse(raw),reader=new ObservationReader(this.root);
    let overview;
    try {overview=await reader.overview({projectId:options.projectId,limit:options.limit});} finally {reader.close();}
    const result:InsightCapture & {jobsInspected:number;truncated:boolean}={evaluationIds:[],created:0,reused:0,warnings:[],
      jobsInspected:overview.runs.length,truncated:overview.page.nextOffset!==null};
    for(const job of overview.runs) {
      try {
        const captured=await this.captureJob(job.id);
        result.evaluationIds.push(...captured.evaluationIds);result.created+=captured.created;result.reused+=captured.reused;result.warnings.push(...captured.warnings);
      }catch(error){result.warnings.push(`${job.id}: ${this.error(error)}`);}
    }
    result.warnings=[...new Set(result.warnings)];
    return result;
  }

  async observations(raw:{projectId?:string;limit?:number}={}):Promise<InsightObservation> {
    const options=optionsSchema.parse(raw),inventory=await this.inventory(options.projectId);
    const result:InsightObservation={comparisons:[],signals:[],warnings:inventory.warnings,truncated:inventory.truncated};
    // Preserve manual evaluations. For automatic re-captures, only the latest receipt for each source attempt is current.
    const current=new Map<string,EvaluationReceipt>();
    for(const receipt of inventory.items) {
      const identity=receipt.source===policyVersion?`${receipt.jobId}/${receipt.attempt}/${receipt.source}`:receipt.id;
      if(!current.has(identity))current.set(identity,receipt);
    }
    const ordered=[...current.values()].sort((a,b)=>this.measurementTime(a).localeCompare(this.measurementTime(b))||a.recordedAt.localeCompare(b.recordedAt)||a.id.localeCompare(b.id));
    const previous=new Map<string,{receipt:EvaluationReceipt;metricId:string}>();
    for(const treatment of ordered) {
      for(const metric of treatment.metrics) {
        if(metric.classification!=='observed'||treatment.technical.criticalGateStatus!=='passed')continue;
        const key=KnowledgeFiles.hash(JSON.stringify({projectId:treatment.projectId,taskClass:treatment.taskClass,rubric:treatment.rubric,
          id:metric.id,classification:metric.classification,cohort:metric.cohort,unit:metric.unit,method:metric.method,version:metric.version}));
        const baseline=previous.get(key)?.receipt;
        if(baseline&&(baseline.jobId!==treatment.jobId||baseline.attempt!==treatment.attempt)) {
          try {
            const comparison=await this.evaluations.compare({baselineId:baseline.id,treatmentId:treatment.id,metricId:metric.id});
            if(comparison.status==='compared')result.comparisons.push({
              id:KnowledgeFiles.hash(JSON.stringify({baseline:baseline.id,treatment:treatment.id,metric:metric.id})),projectId:treatment.projectId,
              metricLabel:this.metricLabel(treatment,metric.id),
              baselineJobId:baseline.jobId,treatmentJobId:treatment.jobId,
              reason:'Previous compatible observed receipt in measurement-window order (ties use recording time); descriptive difference, not a causal improvement or quota saving.',
              evidence:[baseline.artifactPath,treatment.artifactPath,...baseline.evidence,...treatment.evidence].filter((ref,index,all)=>all.indexOf(ref)===index),comparison,
            });
          }catch(error){result.warnings.push(`comparison:${treatment.id}: ${this.error(error)}`);}
        }
        previous.set(key,{receipt:treatment,metricId:metric.id});
      }
    }
    // Operational outcomes are distinct from metric comparisons: a failed gate remains failed in its original receipt.
    const jobs=new Map<string,EvaluationReceipt[]>();
    for(const receipt of current.values())if(receipt.source===policyVersion)jobs.set(receipt.jobId,[...(jobs.get(receipt.jobId)??[]),receipt]);
    for(const attempts of jobs.values()) {
      attempts.sort((a,b)=>a.attempt-b.attempt);
      for(let index=1;index<attempts.length;index++) {
        const prior=attempts[index-1]!,next=attempts[index]!;
        if(prior.attempt+1!==next.attempt||prior.technical.criticalGateStatus!=='failed'||prior.rubric.id!==next.rubric.id)continue;
        const failed=prior.technical.criteria.filter(criterion=>criterion.status==='failed').map(criterion=>criterion.checkId);
        const recovered=next.technical.status==='passed';
        const repeated=failed.filter(checkId=>next.technical.criteria.some(criterion=>criterion.checkId===checkId&&criterion.status==='failed'));
        if(!recovered&&!repeated.length)continue;
        const kind=recovered?'recovery' as const:'repeated-failure' as const;
        result.signals.push({id:KnowledgeFiles.hash(`${policyVersion}:${kind}:${prior.id}:${next.id}`),projectId:next.projectId,jobId:next.jobId,kind,
          reason:recovered?`Attempt ${prior.attempt} failed checks (${failed.join(', ')}); attempt ${next.attempt} passed the same named-check contract. Cause and reusable fix require review.`
            :`Attempts ${prior.attempt} and ${next.attempt} both failed checks (${repeated.join(', ')}). Inspect the recorded failure before choosing another retry.`,
          evidence:[prior.artifactPath,next.artifactPath,...prior.evidence,...next.evidence].filter((ref,index,all)=>all.indexOf(ref)===index),attempts:[prior.attempt,next.attempt]});
      }
    }
    result.truncated ||= result.comparisons.length>options.limit||result.signals.length>options.limit;
    result.comparisons=result.comparisons.reverse().slice(0,options.limit);result.signals=result.signals.reverse().slice(0,options.limit);
    result.warnings=[...new Set(result.warnings)];
    return result;
  }

  private async evaluationInput(run:Run,attempt:Attempt,window:AttemptWindow):Promise<EvaluationInput|null> {
    const contract=attempt.taskContract??run.prepared.taskContract;
    const captured=await this.commandContext(run,attempt);if(!captured)return null;
    const {signature,evidencePath}=captured,{kind,checkIds}=signature;
    const rubricId='named-checks-'+KnowledgeFiles.hash(JSON.stringify(signature)).slice(0,24);
    const metrics:NonNullable<EvaluationInput['metrics']>=[];
    for(const checkId of checkIds) {
      const matches=attempt.checks!.filter(check=>check.checkId===checkId),check=matches.length===1?matches[0]:null;
      const id=this.metricId(checkId);
      if(!check||check.durationMs===null) {metrics.push({id,classification:'unknown',reason:`No unambiguous duration receipt for check ${checkId}.`});continue;}
      // Unknown command identity gets an attempt-specific cohort, so its observed number cannot imply compatible workloads.
      metrics.push({id,classification:'observed',value:check.durationMs,unit:'ms',method:'ProcessRunner CommandResult.durationMs/v1',
        source:evidencePath,cohort:captured.checks.find(check=>check.checkId===checkId)!.cohort??KnowledgeFiles.hash(JSON.stringify({...signature,checkId,command:{unverifiedCommand:`${run.summary.id}/${attempt.attempt}/${checkId}`}})),version:'1',window:{start:window.start,end:window.end},
        sample:{size:1,representative:false,selection:`Single recorded execution of ${checkId}. Window is the containing attempt claim-to-terminal interval, not the check interval; no controlled representative sampling.`}});
    }
    return {jobId:run.summary.id,attempt:attempt.attempt,taskClass:contract?.performanceScope?.taskClass??`named-checks-${kind}`,author:{name:'CodexInfra deterministic evidence processor',role:'reviewer'},
      source:policyVersion,evidence:[evidencePath,...run.evidence.filter(ref=>ref.endsWith('/task-contract.json')&&ref.includes(`/attempt-${attempt.attempt}/`)),
        `state/jobs.sqlite:job_events:${window.eventIds.join(',')}`],rubric:{id:rubricId,version:'1',criteria:checkIds.map(checkId=>({id:checkId,checkId,critical:true}))},metrics};
  }

  private async commandContext(run:Run,attempt:Attempt) {
    const contract=attempt.taskContract??run.prepared.taskContract,checkIds=contract?.checkIds??run.prepared.checkIds,kind=contract?.kind??run.prepared.kind;
    if(!kind||!checkIds?.length||new Set(checkIds).size!==checkIds.length)return null;
    const evidencePath=`artifacts/jobs/${run.summary.id}/attempt-${attempt.attempt}/checks.json`,commands=await this.files.read(evidencePath,commandReceipts);
    // Keep the historical no-scope signature byte-for-byte stable; declared scopes add a new boundary.
    const signature={projectId:run.summary.projectId,kind,mode:contract?.mode??run.summary.mode,checkIds,...(contract?.performanceScope?{performanceScope:contract.performanceScope}:{})};
    const checks=checkIds.map(checkId=>{
      const matches=commands.filter(command=>command.checkId===checkId),command=matches.length===1?matches[0]:null;
      const identity=command?.executable&&command.args&&command.cwd?{executable:command.executable,args:command.args,cwd:command.cwd}:null;
      return {checkId,cohort:identity?KnowledgeFiles.hash(JSON.stringify({...signature,checkId,command:identity})):null};
    });
    return {signature,evidencePath,checks};
  }

  private attemptWindows(events:JobEvent[]):Map<number,AttemptWindow> {
    const windows=new Map<number,AttemptWindow>();let attempt=0,claim:JobEvent|undefined;
    for(const event of events) {
      if(event.detail.action==='claim'){attempt++;claim=event;continue;}
      if(claim&&!['ready','running','validating'].includes(event.toStatus)) {
        windows.set(attempt,{start:claim.createdAt,end:event.createdAt,eventIds:[claim.id,event.id]});claim=undefined;
      }
    }
    return windows;
  }
  private async inventory(projectId?:string) {
    const items:EvaluationReceipt[]=[],warnings:string[]=[];let offset=0,truncated=false;
    do {
      const page=await this.evaluations.list({projectId,limit:100,offset});items.push(...page.items);warnings.push(...page.warnings);truncated ||= page.truncated;
      if(page.nextOffset===null)break;offset=page.nextOffset;
    }while(offset<500);
    return {items,warnings:[...new Set(warnings)],truncated};
  }
  private measurementTime(receipt:EvaluationReceipt):string {return receipt.metrics.find(metric=>metric.window)?.window?.end??receipt.recordedAt;}
  metricLabel(receipt:EvaluationReceipt,metricId:string):string {return receipt.rubric.criteria.find(criterion=>this.metricId(criterion.checkId)===metricId)?.checkId??metricId;}
  private metricId(checkId:string):string {return 'check-duration-'+KnowledgeFiles.hash(checkId).slice(0,16);}
  private error(error:unknown):string {return EvidenceSanitizer.text(error instanceof Error?error.message:'Evidence processing unavailable.',500);}
}
