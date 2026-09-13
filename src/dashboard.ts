import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {ObservationReader, type ObservationOverviewOptions} from './observability.js';
import {ProjectRegistry} from './registry.js';
import {EvaluationStore, type EvaluationCompareInput} from './evaluation.js';
import {RecoveryManager} from './recovery.js';
import {EvidenceSanitizer} from './evidence.js';
import {OperationsObservation} from './operations-observation.js';
import type {InteractionRecord} from './interactions.js';
import {OperationalInsights} from './operational-insights.js';
import {RuntimeObservation} from './runtime-observation.js';
import {EfficiencyHistory,EfficiencyHistoryInputSchema} from './efficiency-history.js';
import {ImprovementImpactReader} from './improvement-impact.js';
import {LearningApplications} from './learning-applications.js';
import {LearningRuntimeStore} from './learning-runtime.js';
import {AutonomousLearning} from './autonomous-learning.js';
import {LearningRuntimeEffects} from './learning-runtime-effects.js';
import {WorkPopulations,WorkPopulationSchema} from './work-population.js';

export const DashboardViewSchema = z.enum(['overview','live','efficiency','project','evidence','learning']);
export type DashboardView = z.output<typeof DashboardViewSchema>;
export interface DashboardOptions extends ObservationOverviewOptions {
  view?:DashboardView; jobId?:string; afterEventId?:number; comparison?:EvaluationCompareInput;
  evaluationOffset?:number;
  historyDays?:7|14|30|90;
  interactionOffset?:number; interactionLimit?:number; interactionStatus?:InteractionRecord['status'];
}
type SourceState = 'ready'|'empty'|'partial'|'unavailable';
export interface Source<T> {state:SourceState; data:T|null; warnings:string[]}

/** One aggregate per screen. Registry metadata never resolves or visits product roots. */
export class DashboardReader {
  readonly reader:ObservationReader;
  private readonly registry:ProjectRegistry;
  private readonly evaluations:EvaluationStore;
  private readonly runtime:RuntimeObservation;
  constructor(readonly root:string) {
    this.reader=new ObservationReader(root);
    this.registry=new ProjectRegistry(path.join(root,'profiles/registry.json'));
    this.evaluations=new EvaluationStore(root);
    this.runtime=new RuntimeObservation(root);
  }
  async screen(options:DashboardOptions={}) {
    const view=DashboardViewSchema.parse(options.view??'overview');
    const groups=await WorkPopulations.read(this.root),population=WorkPopulationSchema.parse(options.population??'all');
    const includeProject=(id:string|null|undefined)=>groups.includes(id,population);
    const historyOptions=EfficiencyHistoryInputSchema.parse({projectId:options.projectId,days:options.historyDays});
    const [overview,profiles,activity,operations,learningRuntime,learningCycle]=await Promise.all([
      this.reader.overview(options),
      this.source(async()=>{await fs.access(this.registry.registryPath);return this.registry.list();},'Project registry'),
      Promise.resolve(this.reader.projectActivity()),
      this.source(()=>new OperationsObservation(this.root).read(options.projectId,{offset:options.interactionOffset,limit:options.interactionLimit,status:options.interactionStatus}),'Operational receipts'),
      view==='learning'||view==='efficiency'?this.source(async()=>{
        const result=await new LearningRuntimeStore(this.root).list(options.projectId);
        return {warnings:result.warnings.map(message=>EvidenceSanitizer.text(message,400)),items:result.items.map(({manifest,state})=>({
          manifest:{hash:manifest.hash,candidateId:manifest.candidateId,projectId:manifest.projectId,
            title:EvidenceSanitizer.text(manifest.title,240),kind:manifest.kind,capabilityVersion:manifest.capabilityVersion,
            createdAt:manifest.createdAt,artifactPath:manifest.artifactPath,
            entrypoints:manifest.entrypoints.map(entry=>({id:entry.id,runtime:entry.runtime,path:entry.path})),testCount:manifest.tests.length},
          state:{status:state.status,revision:state.revision,updatedAt:state.updatedAt,artifactPath:state.artifactPath,
            validation:state.validation,
            activation:state.activation?{recordedAt:state.activation.recordedAt,policyHash:state.activation.policyHash,
              source:EvidenceSanitizer.text(state.activation.source,600),evidence:state.activation.evidence.map(ref=>EvidenceSanitizer.text(ref,600))}:null,
            disabled:state.disabled?{recordedAt:state.disabled.recordedAt,source:EvidenceSanitizer.text(state.disabled.source,600),
              evidence:state.disabled.evidence.map(ref=>EvidenceSanitizer.text(ref,600))}:null,
          },
        })).sort((a,b)=>(b.state.disabled?.recordedAt??b.state.updatedAt).localeCompare(a.state.disabled?.recordedAt??a.state.updatedAt)||a.manifest.hash.localeCompare(b.manifest.hash))};
      },'Executable learning capabilities'):Promise.resolve(null),
      view==='learning'||view==='overview'?this.source(async()=>{
        const result=await new AutonomousLearning(this.root).list(options.projectId);
        return {warnings:result.warnings.map(message=>EvidenceSanitizer.text(message,400)),items:result.items.map(item=>({
          id:item.id,projectId:item.projectId,status:item.status,title:EvidenceSanitizer.text(item.title,240),kind:item.kind,
          attempts:item.attempts,hash:item.hash,candidateId:item.candidateId,updatedAt:item.updatedAt,
          lastError:item.lastError?EvidenceSanitizer.text(item.lastError,1200):null,jobIds:item.jobIds,
          originJobId:'jobId' in item.origin?item.origin.jobId:null,
          evidence:item.evidence.map(ref=>EvidenceSanitizer.text(ref,600)),artifactPath:item.artifactPath,
        }))};
      },'Automatic learning cycle'):Promise.resolve(null),
    ]);
    if(operations.data){operations.warnings=operations.data.warnings;operations.state=operations.warnings.length?'partial':'ready';}
    if(learningRuntime?.data){learningRuntime.warnings=learningRuntime.data.warnings;learningRuntime.state=learningRuntime.warnings.length?'partial':learningRuntime.data.items.length?'ready':'empty';}
    if(learningCycle?.data){learningCycle.warnings=learningCycle.data.warnings;learningCycle.state=learningCycle.warnings.length?'partial':learningCycle.data.items.length?'ready':'empty';}
    const projects=profiles.data?.map(profile=>({id:profile.id,name:EvidenceSanitizer.text(profile.name,160),status:profile.status,
      stack:profile.stack.map(item=>EvidenceSanitizer.text(item,80)),checks:profile.checks.map(item=>item.id),sourceCount:profile.sources.length,
      activity:activity.find(item=>item.projectId===profile.id)??{projectId:profile.id,total:0,active:0,completed:0,latestId:null,updatedAt:null}}))??[];
    const evaluations=await this.source(()=>this.evaluations.list({projectId:options.projectId,includeProject,limit:50,offset:options.evaluationOffset}),'Evaluation receipts');
    if(evaluations.data){evaluations.warnings=evaluations.data.warnings; evaluations.state=evaluations.warnings.length||evaluations.data.truncated?'partial':evaluations.data.total?'ready':'empty';}
    const needsRun=view==='live'||view==='evidence';
    const selectedId=options.jobId??overview.runs[0]?.id;
    const run=needsRun&&selectedId?await this.source(()=>this.reader.run(selectedId,{afterEventId:options.afterEventId}),'Run receipts'):null;
    const recovery=view==='evidence'?await this.source(()=>new RecoveryManager(this.root).observations(),'Recovery metadata'):null;
    if(recovery?.data){recovery.warnings=recovery.data.warnings;recovery.state=recovery.warnings.length?'partial':recovery.data.snapshots.length||recovery.data.verifications.length?'ready':'empty';}
    const comparison=view==='efficiency'&&options.comparison?await this.source(()=>this.evaluations.compare(options.comparison!),'Evaluation comparison'):null;
    const insights=view==='efficiency'||view==='learning'?await this.source(()=>new OperationalInsights(this.root).observations({projectId:options.projectId,includeProject}),'Automatic findings'):null;
    if(insights?.data){insights.warnings=insights.data.warnings;insights.state=insights.warnings.length||insights.data.truncated?'partial':insights.data.comparisons.length||insights.data.signals.length?'ready':'empty';}
    const history=view==='efficiency'?await this.source(()=>new EfficiencyHistory(this.root,{includeProject}).history(historyOptions),'Efficiency history'):null;
    if(history?.data){history.warnings=history.data.coverage.warnings;history.state=history.warnings.length||history.data.coverage.truncated?'partial':'ready';}
    const [improvements,runtimeEffects]=await Promise.all([
      history?.data?this.source(()=>new ImprovementImpactReader(this.root).read(history.data!,options.projectId),'Improvement effects'):Promise.resolve(null),
      history?.data?this.source(()=>new LearningRuntimeEffects(this.root).read({projectId:options.projectId,history:history.data!}),'Capability execution effects'):Promise.resolve(null),
    ]);
    if(improvements?.data){improvements.warnings=improvements.data.warnings;improvements.state=improvements.warnings.length||improvements.data.truncated?'partial':improvements.data.cases.length?'ready':'empty';}
    if(runtimeEffects?.data){runtimeEffects.warnings=runtimeEffects.data.warnings;runtimeEffects.state=runtimeEffects.warnings.length||runtimeEffects.data.coverage.truncated?'partial':runtimeEffects.data.items.length?'ready':'empty';}
    if(runtimeEffects?.data)runtimeEffects.data.items=runtimeEffects.data.items.filter(item=>includeProject(item.projectId));
    if(improvements?.data)improvements.data.cases=improvements.data.cases.filter(item=>includeProject(item.projectId));
    const learningEffects=improvements?.data?await this.source(()=>new LearningApplications(this.root).readEffects(improvements.data!.cases.map(candidate=>candidate.candidateId)),'Learning token effects'):null;
    if(learningEffects?.data){learningEffects.warnings=learningEffects.data.warnings;learningEffects.state=learningEffects.warnings.length?'partial':'ready';}
    const learning=view==='learning'?{
      state:profiles.state,
      signalsState:profiles.state==='unavailable'||evaluations.state==='unavailable'?'partial' as const:evaluations.state,
      candidates:profiles.data?.filter(p=>!options.projectId||p.id===options.projectId).flatMap(p=>p.sources.filter(s=>s.knowledgeClass==='candidate'||s.knowledgeStatus==='candidate').map(s=>({
        projectId:p.id,label:EvidenceSanitizer.text(s.label,240),status:s.knowledgeStatus??'candidate',
        decisionRefs:s.decisionRefs?.map(ref=>EvidenceSanitizer.text(ref,300))??[], evidence:'profiles/registry.json',
        review:'not-recorded',shadow:'not-recorded',proposal:'Not recorded in this source',
      })))??null,
      signals:[
        ...(evaluations.data?.items.filter(e=>e.technical.criticalGateStatus!=='passed').map(e=>({projectId:e.projectId,jobId:e.jobId,kind:'evaluation',
          reason:`${e.projectId} · ${e.technical.criticalGateStatus}: ${e.technical.criteria.filter(c=>c.status!=='passed').map(c=>c.checkId+' ('+c.status+')').join(', ')||'missing check evidence'} · run ${e.jobId.slice(0,8)}, attempt ${e.attempt}`,evidence:e.artifactPath}))??[]),
        ...(profiles.data?.filter(p=>!options.projectId||p.id===options.projectId).flatMap(p=>p.sources.filter(s=>s.conflictsWith?.length).map(s=>({
          projectId:p.id,jobId:null,kind:'declared conflict',reason:EvidenceSanitizer.text(`${s.label}: ${s.conflictsWith!.join(', ')}`,400),evidence:'profiles/registry.json'})))??[]),
      ],
      promotions:null,
      limitations:['Registry references are declarations, not executable capabilities.', 'No registered product root was opened.', 'Automatic activation requires matching review, validation and policy receipts.'],
    }:null;
    return {observedAt:new Date().toISOString(),view,overview,projects:{state:profiles.state,items:projects,warnings:profiles.warnings},
      evaluations,run,recovery,comparison,learning,learningRuntime,learningCycle,operations,insights,history,improvements,learningEffects,runtimeEffects,runtime:this.runtime.read()};
  }
  close(){this.reader.close();}
  private async source<T>(read:()=>Promise<T>,label:string):Promise<Source<T>> {
    try {return {state:'ready',data:await read(),warnings:[]};}
    catch {return {state:'unavailable',data:null,warnings:[`${label} could not be read. No empty or passing result was inferred.`]};}
  }
}
export type DashboardObservation=Awaited<ReturnType<DashboardReader['screen']>>;
