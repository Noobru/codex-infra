import {z} from 'zod';
import {KnowledgeFiles,KnowledgeProjectSchema} from './knowledge-store.js';
import {LearningRuntimeStore,LearningRunReceiptSchema,type LearningRunReceipt} from './learning-runtime.js';
import {EvaluationMetricSchema,type EvaluationMetric} from './evaluation.js';
import {EvidenceSanitizer} from './evidence.js';
import type {EfficiencyHistoryResult} from './efficiency-history.js';

type HistoryWindow=Pick<EfficiencyHistoryResult,'observedAt'|'timeZone'|'window'>;
export interface LearningRuntimeEffectsInput {projectId?:string;history?:HistoryWindow}
export interface LearningRuntimeInvocation {
  id:string;entrypoint:string;recordedAt:string;day:string;status:'passed'|'failed';durationMs:number;
  artifactPath:string;disabledDuringExecution:boolean;attribution:{threadId:string;turnId:string}|null;
  outputs:{path:string;sha256:string;bytes:number}[];
}
export interface LearningRuntimeUsage {
  hash:string;candidateId:string;projectId:string;title:string;kind:string;capabilityVersion:string;status:string;
  activatedAt:string|null;disabledAt:string|null;executions:number;passed:number;failed:number;
  metrics:{totalDuration:EvaluationMetric;meanDuration:EvaluationMetric};
  days:{day:string;executions:number;passed:number;failed:number;totalDurationMs:number;meanDurationMs:number;runIds:string[]}[];
  attributedExecutions:number;runs:LearningRuntimeInvocation[];evidence:string[];
}
export interface LearningRuntimeEffectsResult {
  version:1;observedAt:string;timeZone:string;window:HistoryWindow['window']|null;items:LearningRuntimeUsage[];
  coverage:{available:number;inspected:number;included:number;limit:number;truncated:boolean};warnings:string[];
  tokenComparison:{status:'not-established';reason:string;metrics:null};limitations:string[];
}

/** Read-only execution evidence. It reads owned receipts, never runs a capability or opens a product root. */
export class LearningRuntimeEffects {
  private readonly files:KnowledgeFiles;
  constructor(readonly root:string){this.files=new KnowledgeFiles(root);}

  async read(input:LearningRuntimeEffectsInput={}):Promise<LearningRuntimeEffectsResult>{
    if(input.projectId)KnowledgeProjectSchema.parse(input.projectId);
    const observedAt=input.history?.observedAt??new Date().toISOString(),timeZone=input.history?.timeZone??'UTC';
    const calendar=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
    const day=(at:string)=>calendar.format(new Date(at));
    const [bundles,names]=await Promise.all([new LearningRuntimeStore(this.root).list(input.projectId),
      this.files.names('artifacts/learning/runtime/runs')]);
    const files=names.filter(name=>name.endsWith('.json')&&z.uuid().safeParse(name.slice(0,-5)).success);
    const limit=2000,selected=files.slice(0,limit),warnings=[...bundles.warnings],byHash=new Map<string,LearningRunReceipt[]>();
    let included=0;
    const registered=new Map(bundles.items.map(item=>[item.manifest.hash,item.manifest]));
    for(const name of selected){
      const relative=`artifacts/learning/runtime/runs/${name}`;
      try{
        const run=await this.files.read(relative,LearningRunReceiptSchema);
        if(run.id!==name.slice(0,-5)||run.artifactPath!==relative)throw new Error('Run identity mismatch');
        if(input.projectId&&run.projectId!==input.projectId)continue;
        const manifest=registered.get(run.hash);
        if(!manifest||manifest.projectId!==run.projectId||!manifest.entrypoints.some(entry=>entry.id===run.entrypoint))throw new Error('Bundle identity unavailable');
        const passed=run.result.exitCode===0&&!run.result.error&&!run.result.cleanupFailed;
        if((run.status==='passed')!==passed||run.outputs.some(output=>KnowledgeFiles.hash(output.content)!==output.sha256))throw new Error('Run outcome or output differs from evidence');
        const recordedDay=day(run.recordedAt);
        if(Date.parse(run.recordedAt)>Date.parse(observedAt)||input.history&&(recordedDay<input.history.window.startDay||recordedDay>input.history.window.endDay))continue;
        byHash.set(run.hash,[...(byHash.get(run.hash)??[]),run]);included++;
      }catch{warnings.push(`Execution receipt ${name} could not be verified.`);}
    }
    if(selected.length<files.length)warnings.push('Capability execution inventory exceeded the read limit; totals cover inspected receipts only.');
    const items=bundles.items.map(({manifest,state}):LearningRuntimeUsage=>{
      const receipts=(byHash.get(manifest.hash)??[]).sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.id.localeCompare(b.id));
      const runs=receipts.map((run):LearningRuntimeInvocation=>({id:run.id,entrypoint:run.entrypoint,recordedAt:run.recordedAt,day:day(run.recordedAt),
        status:run.status,durationMs:run.result.durationMs,artifactPath:run.artifactPath,disabledDuringExecution:run.disabledDuringExecution,
        attribution:run.attribution??null,outputs:run.outputs.map(output=>({path:EvidenceSanitizer.text(output.path,240),sha256:output.sha256,bytes:Buffer.byteLength(output.content)}))}));
      const evidence=[manifest.artifactPath,state.artifactPath,...runs.map(run=>run.artifactPath)];
      const grouped=new Map<string,LearningRuntimeInvocation[]>();
      for(const run of runs)grouped.set(run.day,[...(grouped.get(run.day)??[]),run]);
      return {hash:manifest.hash,candidateId:manifest.candidateId,projectId:manifest.projectId,title:EvidenceSanitizer.text(manifest.title,240),kind:manifest.kind,
        capabilityVersion:manifest.capabilityVersion,status:state.status,activatedAt:state.activation?.recordedAt??null,disabledAt:state.disabled?.recordedAt??null,
        executions:runs.length,passed:runs.filter(run=>run.status==='passed').length,failed:runs.filter(run=>run.status==='failed').length,
        metrics:{totalDuration:this.durationMetric('totalDuration',runs,manifest.hash),meanDuration:this.durationMetric('meanDuration',runs,manifest.hash)},
        days:[...grouped].map(([day,entries])=>{const totalDurationMs=entries.reduce((sum,run)=>sum+run.durationMs,0);return {day,executions:entries.length,
          passed:entries.filter(run=>run.status==='passed').length,failed:entries.filter(run=>run.status==='failed').length,totalDurationMs,
          meanDurationMs:totalDurationMs/entries.length,runIds:entries.map(run=>run.id)};}),
        attributedExecutions:runs.filter(run=>run.attribution!==null).length,runs,evidence};
    }).sort((a,b)=>b.executions-a.executions||a.title.localeCompare(b.title)||a.hash.localeCompare(b.hash));
    return {version:1,observedAt,timeZone,window:input.history?.window??null,items,
      coverage:{available:files.length,inspected:selected.length,included,limit,truncated:selected.length<files.length},warnings:[...new Set(warnings)].map(warning=>EvidenceSanitizer.text(warning,600)),
      tokenComparison:{status:'not-established',metrics:null,reason:'Turn attribution is retained, but model identity is not recorded in the current turn telemetry contract. A comparison requiring the same model is not established.'},
      limitations:['Counts and durations describe verified execution receipts in the selected window; they are not measures of improvement or quality.',
        'Deterministic execution does not invoke a model. Interaction, synthesis and build costs are not zero and are not measured by these durations.',
        'Returned output hashes prove the recorded result, not that a caller applied it to another project. No causal or quota savings are inferred.']};
  }

  private durationMetric(id:'totalDuration'|'meanDuration',runs:LearningRuntimeInvocation[],hash:string):EvaluationMetric{
    if(!runs.length)return EvaluationMetricSchema.parse({id,classification:'unknown',value:null,unit:'ms',reason:'No verified execution duration in this window.'});
    const total=runs.reduce((sum,run)=>sum+run.durationMs,0);
    return EvaluationMetricSchema.parse({id,classification:'observed',value:id==='totalDuration'?total:total/runs.length,unit:'ms',
      method:`${id==='totalDuration'?'sum':'arithmetic mean'} of LearningRunReceipt.result.durationMs`,source:'artifacts/learning/runtime/runs',cohort:`capability:${hash}`,version:'1',
      window:{start:runs[0]!.recordedAt,end:runs.at(-1)!.recordedAt},sample:{size:runs.length,representative:false,selection:'Verified receipts for this exact capability hash in the inspected inventory and requested window.'}});
  }
}
