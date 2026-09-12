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

export const DashboardViewSchema = z.enum(['overview','live','efficiency','project','evidence','learning']);
export type DashboardView = z.output<typeof DashboardViewSchema>;
export interface DashboardOptions extends ObservationOverviewOptions {
  view?:DashboardView; jobId?:string; afterEventId?:number; comparison?:EvaluationCompareInput;
  evaluationOffset?:number;
  interactionOffset?:number; interactionLimit?:number; interactionStatus?:InteractionRecord['status'];
}
type SourceState = 'ready'|'empty'|'partial'|'unavailable';
export interface Source<T> {state:SourceState; data:T|null; warnings:string[]}

/** One aggregate per screen. Registry metadata never resolves or visits product roots. */
export class DashboardReader {
  readonly reader:ObservationReader;
  private readonly registry:ProjectRegistry;
  private readonly evaluations:EvaluationStore;
  constructor(readonly root:string) {
    this.reader=new ObservationReader(root);
    this.registry=new ProjectRegistry(path.join(root,'profiles/registry.json'));
    this.evaluations=new EvaluationStore(root);
  }
  async screen(options:DashboardOptions={}) {
    const view=DashboardViewSchema.parse(options.view??'overview');
    const [overview,profiles,activity,operations]=await Promise.all([
      this.reader.overview(options),
      this.source(async()=>{await fs.access(this.registry.registryPath);return this.registry.list();},'Project registry'),
      Promise.resolve(this.reader.projectActivity()),
      this.source(()=>new OperationsObservation(this.root).read(options.projectId,{offset:options.interactionOffset,limit:options.interactionLimit,status:options.interactionStatus}),'Operational receipts'),
    ]);
    if(operations.data){operations.warnings=operations.data.warnings;operations.state=operations.warnings.length?'partial':'ready';}
    const projects=profiles.data?.map(profile=>({id:profile.id,name:EvidenceSanitizer.text(profile.name,160),status:profile.status,
      stack:profile.stack.map(item=>EvidenceSanitizer.text(item,80)),checks:profile.checks.map(item=>item.id),sourceCount:profile.sources.length,
      activity:activity.find(item=>item.projectId===profile.id)??{projectId:profile.id,total:0,active:0,completed:0,latestId:null,updatedAt:null}}))??[];
    const evaluations=await this.source(()=>this.evaluations.list({projectId:options.projectId,limit:50,offset:options.evaluationOffset}),'Evaluation receipts');
    if(evaluations.data){evaluations.warnings=evaluations.data.warnings; evaluations.state=evaluations.warnings.length||evaluations.data.truncated?'partial':evaluations.data.total?'ready':'empty';}
    const needsRun=view==='live'||view==='evidence';
    const selectedId=options.jobId??overview.runs[0]?.id;
    const run=needsRun&&selectedId?await this.source(()=>this.reader.run(selectedId,{afterEventId:options.afterEventId}),'Run receipts'):null;
    const recovery=view==='evidence'?await this.source(()=>new RecoveryManager(this.root).observations(),'Recovery metadata'):null;
    if(recovery?.data){recovery.warnings=recovery.data.warnings;recovery.state=recovery.warnings.length?'partial':recovery.data.snapshots.length||recovery.data.verifications.length?'ready':'empty';}
    const comparison=view==='efficiency'&&options.comparison?await this.source(()=>this.evaluations.compare(options.comparison!),'Evaluation comparison'):null;
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
          reason:`Attempt ${e.attempt}: critical gate ${e.technical.criticalGateStatus}`,evidence:e.artifactPath}))??[]),
        ...(profiles.data?.filter(p=>!options.projectId||p.id===options.projectId).flatMap(p=>p.sources.filter(s=>s.conflictsWith?.length).map(s=>({
          projectId:p.id,jobId:null,kind:'declared conflict',reason:EvidenceSanitizer.text(`${s.label}: ${s.conflictsWith!.join(', ')}`,400),evidence:'profiles/registry.json'})))??[]),
      ],
      promotions:null,
      limitations:['Signals do not create or promote candidates.', 'Candidate metadata is a registry declaration; no source file or product root was opened.', 'Review, shadow and promotion decisions require their own evidence.'],
    }:null;
    return {observedAt:new Date().toISOString(),view,overview,projects:{state:profiles.state,items:projects,warnings:profiles.warnings},
      evaluations,run,recovery,comparison,learning,operations};
  }
  close(){this.reader.close();}
  private async source<T>(read:()=>Promise<T>,label:string):Promise<Source<T>> {
    try {return {state:'ready',data:await read(),warnings:[]};}
    catch {return {state:'unavailable',data:null,warnings:[`${label} could not be read. No empty or passing result was inferred.`]};}
  }
}
export type DashboardObservation=Awaited<ReturnType<DashboardReader['screen']>>;
