import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {StateStore,type Job,type JobEvent} from './state.js';
import {ObservationReader} from './observability.js';
import {EvaluationStore,type EvaluationReceipt} from './evaluation.js';
import {InteractionStore,InteractionIdSchema,type InteractionRecord} from './interactions.js';
import {KnowledgeLearningStore,type KnowledgeCandidate} from './knowledge-learning.js';
import {KnowledgeFiles} from './knowledge-store.js';
import {ProjectRegistry} from './registry.js';
import {OperationalInsights} from './operational-insights.js';
import {EvidenceSanitizer} from './evidence.js';
import {InteractionTelemetry,type InteractionTelemetryReceipt} from './interaction-telemetry.js';

export const EfficiencyHistoryInputSchema=z.object({projectId:z.string().min(1).optional(),days:z.union([z.literal(7),z.literal(14),z.literal(30),z.literal(90)]).default(14)});
type Kind='codex'|'checks';
type Run=Awaited<ReturnType<ObservationReader['run']>>;
type Worker=NonNullable<Run['attempts'][number]['worker']>;
export interface HistoryInventory {available:number|null;inspected:number;limit:number;truncated:boolean}
export interface JobHistoryPoint {
  classification:'observed';finished:number;completed:number;firstPassCompleted:number;firstPassRate:number|null;
  failed:number;failedRate:number|null;cancelled:number;retries:number;jobIds:string[];evidence:string[];
}
export interface DirectHistoryPoint {
  classification:'reported';completedCycles:number;timedCycles:number;elapsedWallClockMsTotal:number|null;elapsedWallClockMsMean:number|null;interactionIds:string[];evidence:string[];
}
export interface EfficiencyHistoryPoint {day:string;jobs:Record<Kind,JobHistoryPoint>;direct:DirectHistoryPoint}
export interface CheckDurationSeries {
  id:string;projectId:string;executionKind:Kind;metricId:string;metricLabel:string;unit:string;method:string;cohort:string;
  points:{day:string;n:number;mean:number|null;min:number|null;max:number|null;evaluationIds:string[]}[];
}
export interface HistoryChange {
  id:string;at:string;day:string;kind:'model'|'effort'|'routing-policy'|'context'|'profile'|'promotion'|'reversal'|'knowledge-use';
  scope:string;projectId:string;jobId:string|null;label:string;before:string|null;after:string|null;evidence:string[];
}
export interface KnowledgeBinding {
  bindingKind:'context-inclusion';candidateId:string;projectId:string;jobId:string;attempt:number;at:string;day:string;contentHash:string;releasePath:string;contextPackPath:string;evidence:string[];
}
export interface TokenObservation {
  projectId:string;jobId:string;attempt:number;at:string;day:string;scope:string|null;usage:NonNullable<Worker['tokenUsage']>;evidence:string[];
}
export type TokenHistoryMetric='totalTokens'|'inputTokens'|'uncachedInputTokens'|'cachedInputTokens'|'outputTokens'|'reasoningOutputTokens'|'cacheWriteInputTokens';
export type TokenHistoryPoint={day:string;n:number;metricSamples:Record<TokenHistoryMetric,number>;interactionIds:string[];turnIds:string[];evidence:string[]}&Record<TokenHistoryMetric,number|null>;
export interface TokenHistorySeries {
  id:string;projectId:string;performanceScope:NonNullable<InteractionTelemetryReceipt['performanceScope']>;classification:'observed';unit:'tokens';scope:'complete-turn-delta';points:TokenHistoryPoint[];
}
export interface EfficiencyHistoryResult {
  version:1;observedAt:string;timeZone:string;window:{days:7|14|30|90;startDay:string;endDay:string};points:EfficiencyHistoryPoint[];
  projects:{id:string;name:string;declaredStack:string[];languages:string[];source:'profiles/registry.json'}[];
  durationSeries:CheckDurationSeries[];changes:HistoryChange[];knowledgeBindings:KnowledgeBinding[];tokenObservations:TokenObservation[];
  tokenSeries:TokenHistorySeries[];
  telemetry:{enabled:boolean;inspected:number;completeTurns:number;incompleteTurns:number;unassignedTurns:number;truncated:boolean;warnings:string[]};
  coverage:Record<'jobs'|'attempts'|'evaluations'|'interactions'|'interactionRevisions'|'learningCandidates'|'candidateRevisions',HistoryInventory>&{warnings:string[];truncated:boolean};
  limitations:string[];
}
interface HistoryLimits {jobs:number;eventsPerJob:number;attempts:number;interactions:number;interactionRevisions:number;candidates:number;candidateRevisions:number;evaluations:number;changes:number;series:number}
const defaultLimits:HistoryLimits={jobs:500,eventsPerJob:5000,attempts:1000,interactions:300,interactionRevisions:200,candidates:200,candidateRevisions:100,evaluations:500,changes:300,series:100};
type Snapshot={jobId:string;projectId:string;attempt:number;kind:Kind;at:string;scope:string;model:string|null;effort:string|null;routing:string|null;profile:string|null;context:string|null;contextIdentity:string|null;evidence:string[]};
type Release={candidateId:string;projectId:string;path:string;contentHash:string;at:string;evidence:string[]};
const capturedSources=z.object({sources:z.array(z.object({path:z.string(),sha256:z.string(),label:z.string().optional(),selectionReason:z.string().optional()}))});
const tokenMetrics:TokenHistoryMetric[]=['totalTokens','inputTokens','uncachedInputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','cacheWriteInputTokens'];

/** Daily evidence history. No dispatch, product-root resolution, attribution score or quota estimation. */
export class EfficiencyHistory {
  private readonly files:KnowledgeFiles;
  private readonly calendar:Intl.DateTimeFormat;
  private readonly limits:HistoryLimits;
  private readonly now:()=>Date;
  private readonly includeProject:(id:string|null|undefined)=>boolean;
  readonly timeZone:string;
  constructor(readonly root:string,options:{clock?:()=>Date;timeZone?:string;limits?:Partial<HistoryLimits>;includeProject?:(id:string|null|undefined)=>boolean}={}) {
    this.includeProject=options.includeProject??(()=>true);
    this.files=new KnowledgeFiles(root);this.timeZone=options.timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone;this.now=options.clock??(()=>new Date());
    this.calendar=new Intl.DateTimeFormat('en-CA',{timeZone:this.timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
    this.limits={...defaultLimits,...options.limits};
    for(const [name,value] of Object.entries(this.limits))z.number().int().min(1).max(defaultLimits[name as keyof HistoryLimits]).parse(value);
  }

  async history(raw:z.input<typeof EfficiencyHistoryInputSchema>):Promise<EfficiencyHistoryResult> {
    const input=EfficiencyHistoryInputSchema.parse(raw),observedAt=this.now().toISOString(),endDay=this.day(observedAt);
    const days=Array.from({length:input.days},(_,index)=>new Date(Date.parse(endDay+'T00:00:00Z')-(input.days-1-index)*86400000).toISOString().slice(0,10));
    const inventory=(limit:number):HistoryInventory=>({available:0,inspected:0,limit,truncated:false});
    const result:EfficiencyHistoryResult={version:1,observedAt,timeZone:this.timeZone,window:{days:input.days,startDay:days[0]!,endDay},
      points:days.map(day=>({day,jobs:{checks:this.emptyJob(),codex:this.emptyJob()},direct:{classification:'reported',completedCycles:0,timedCycles:0,elapsedWallClockMsTotal:null,elapsedWallClockMsMean:null,interactionIds:[],evidence:[]}})),
      projects:[],durationSeries:[],changes:[],knowledgeBindings:[],tokenObservations:[],tokenSeries:[],telemetry:{enabled:false,inspected:0,completeTurns:0,incompleteTurns:0,unassignedTurns:0,truncated:false,warnings:[]},coverage:{jobs:inventory(this.limits.jobs),attempts:inventory(this.limits.attempts),evaluations:inventory(this.limits.evaluations),interactions:inventory(this.limits.interactions),interactionRevisions:inventory(this.limits.interactions*this.limits.interactionRevisions),learningCandidates:inventory(this.limits.candidates),candidateRevisions:inventory(this.limits.candidates*this.limits.candidateRevisions),warnings:[],truncated:false},
      limitations:[
        'Daily job rates use the last recorded terminal outcome per job/day. A retry on a later day does not erase the earlier failure; the same job can occur on multiple days.',
        'First-pass completion is a recorded completed outcome at attempt 1, divided by finished jobs; cancellations are shown separately and remain in the denominator. No owner acceptance is inferred.',
        'Retries are claims after the first claim, counted on their start day. Across full history this is attempts minus one; it is not inferred active effort.',
        'Direct-work cycles use declared interaction-origin timestamps and revision transitions. Elapsed wall clock includes waiting and is neither human active time nor model execution time.',
        'Check-duration series are separate by project, execution kind and compatible metric/rubric/cohort. Only passed gates and observed single-execution measurements enter the series; N is shown and does not establish representativeness.',
        'Token receipts retain their original scope individually. Thread-cumulative or unknown-scope counts are never added or attributed as per-task consumption.',
        'Token series sum only complete, distinct observed turn deltas within the same project and declared performance scope. Every metric has its own sample count; missing fields remain unknown. Uncached input is input minus cached input only when both are observed.',
        'Change markers show differences between adjacent captured snapshots in the same project/kind/check/performance scope, or explicit knowledge lifecycle records. Context inclusion does not prove execution, causality or benefit.',
        'Empty-day counts mean no qualifying record in the inspected inventory; incomplete coverage is disclosed. No future values, combined efficiency score, quota saving or cost estimate is produced.',
      ]};
    const [releases]=await Promise.all([this.learning(result,input.projectId),this.projects(result,input.projectId),this.direct(result,input.projectId),this.tokens(result,input.projectId)]);
    const kinds=await this.jobs(result,input.projectId,releases);
    await this.durations(result,input.projectId,kinds);
    for(const point of result.points)for(const kind of ['checks','codex'] as const) {
      const value=point.jobs[kind];value.firstPassRate=value.finished?value.firstPassCompleted/value.finished:null;value.failedRate=value.finished?value.failed/value.finished:null;
    }
    result.changes.sort((a,b)=>b.at.localeCompare(a.at)||a.id.localeCompare(b.id));
    if(result.changes.length>this.limits.changes){result.changes=result.changes.slice(0,this.limits.changes);this.warn(result,'Change markers truncated to '+this.limits.changes+'.',true);}
    result.coverage.warnings=[...new Set(result.coverage.warnings)];
    result.coverage.truncated ||= Object.values(result.coverage).some(value=>typeof value==='object'&&value!==null&&'truncated'in value&&value.truncated);
    return result;
  }

  private async projects(result:EfficiencyHistoryResult,projectId?:string) {
    try {
      const profiles=await new ProjectRegistry(path.join(this.root,'profiles/registry.json')).list();
      const languages=new Set(['javascript','typescript','python','go','rust','java','c','c++','c#','ruby','php','kotlin','swift','scala','elixir','erlang','dart','sql']);
      result.projects=profiles.filter(profile=>this.includeProject(profile.id)&&(!projectId||profile.id===projectId)).map(profile=>({id:profile.id,name:EvidenceSanitizer.text(profile.name,240),declaredStack:profile.stack.map(value=>EvidenceSanitizer.text(value,100)),
        languages:profile.stack.filter(value=>languages.has(value.trim().toLowerCase())),source:'profiles/registry.json'}));
    }catch(error){this.warn(result,'Project metadata: '+this.error(error));}
  }

  private async jobs(result:EfficiencyHistoryResult,projectId:string|undefined,releases:Release[]) {
    const kinds=new Map<string,Kind>(),snapshots:Snapshot[]=[];let state:StateStore|undefined,reader:ObservationReader|undefined,legacyKindOverrides=0;
    try {
      state=new StateStore(path.join(this.root,'state/jobs.sqlite'),{readOnly:true});reader=new ObservationReader(this.root);
      const all=state.list().filter(job=>this.includeProject(job.projectId)&&(!projectId||job.projectId===projectId)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
      const selected=all.slice(0,this.limits.jobs);Object.assign(result.coverage.jobs,{available:all.length,inspected:selected.length,truncated:all.length>selected.length});
      result.coverage.attempts.available=selected.reduce((sum,job)=>sum+job.attempts,0);
      for(const job of selected) {
        if(result.coverage.attempts.inspected+job.attempts>this.limits.attempts){result.coverage.attempts.truncated=true;continue;}
        const events=state.events(job.id);
        if(events.length>this.limits.eventsPerJob){this.warn(result,`${job.id}: event history exceeds ${this.limits.eventsPerJob}; daily outcomes omitted.`,true);continue;}
        try {
          const run=await reader.run(job.id);run.warnings.forEach(warning=>this.warn(result,`${job.id}: ${warning}`));
          const storedKind=state.resource(job.id).executionKind,capturedKind=run.prepared.kind??run.attempts.find(attempt=>attempt.taskContract)?.taskContract?.kind;
          const kind=capturedKind??storedKind;kinds.set(job.id,kind);
          if(capturedKind&&capturedKind!==storedKind)legacyKindOverrides++;
          const starts=this.jobEvents(result,job,kind,events);
          if(run.observations.attemptsTruncated)result.coverage.attempts.truncated=true;
          for(const attempt of run.attempts) {
            if(result.coverage.attempts.inspected>=this.limits.attempts){result.coverage.attempts.truncated=true;break;}
            result.coverage.attempts.inspected++;
            const at=attempt.worker?.finishedAt??attempt.contextPack?.capturedAt??starts.get(attempt.attempt);
            if(!at||!Number.isFinite(Date.parse(at)))continue;
            const base=`artifacts/jobs/${job.id}/attempt-${attempt.attempt}/`,refs=run.evidence.filter(ref=>ref.startsWith(base));
            const performance=attempt.taskContract?.performanceScope;
            snapshots.push({jobId:job.id,projectId:job.projectId,attempt:attempt.attempt,kind,at,scope:JSON.stringify({projectId:job.projectId,kind,checkIds:attempt.taskContract?.checkIds??run.prepared.checkIds??[],taskClass:performance?.taskClass??null,language:performance?.language??null,problemCategory:performance?.problemCategory??null}),
              model:attempt.worker?.model??null,effort:attempt.worker?.reasoningEffort??null,routing:attempt.routing?.policyHash??null,profile:attempt.contextPack?.profileHash??null,context:attempt.contextPack?.hash??null,
              contextIdentity:attempt.contextPack?KnowledgeFiles.hash(JSON.stringify(attempt.contextPack.provenance.map(source=>({label:source.label,sha256:source.sha256,selectionReason:source.selectionReason})))):null,evidence:refs});
            if(this.inWindow(result,at)&&attempt.worker?.tokenUsage)result.tokenObservations.push({projectId:job.projectId,jobId:job.id,attempt:attempt.attempt,at,day:this.day(at),scope:attempt.worker.tokenUsageScope,usage:attempt.worker.tokenUsage,evidence:[base+'worker.json']});
            if(releases.length&&attempt.contextPack&&this.inWindow(result,at)) {
              try {
                const contextPackPath=base+'context-pack.json',pack=await this.files.read(contextPackPath,capturedSources);
                for(const release of releases.filter(release=>release.projectId===job.projectId&&Date.parse(release.at)<=Date.parse(at))) {
                  if(!pack.sources.some(source=>source.sha256===release.contentHash&&KnowledgeFiles.samePath(source.path,path.resolve(this.root,release.path))))continue;
                  const binding:KnowledgeBinding={bindingKind:'context-inclusion',candidateId:release.candidateId,projectId:job.projectId,jobId:job.id,attempt:attempt.attempt,at,day:this.day(at),contentHash:release.contentHash,releasePath:release.path,contextPackPath,evidence:[contextPackPath,...release.evidence]};
                  result.knowledgeBindings.push(binding);
                  this.change(result,{at,kind:'knowledge-use',scope:`${job.projectId}/${kind}`,projectId:job.projectId,jobId:job.id,label:'Learned content included in attempt context',before:null,after:release.candidateId,evidence:binding.evidence});
                }
              }catch(error){this.warn(result,`${base}context-pack.json: ${this.error(error)}`);}
            }
          }
        }catch(error){this.warn(result,`${job.id}: ${this.error(error)}`);}
      }
    }catch(error){result.coverage.jobs.available=null;this.warn(result,'Jobs: '+this.error(error));}
    finally{reader?.close();state?.close();}
    if(result.coverage.attempts.truncated)this.warn(result,'Attempt inventory is bounded; jobs beyond the attempt budget and unavailable older attempts do not contribute measurements.',true);
    if(legacyKindOverrides)result.limitations.push(`${legacyKindOverrides} historical jobs use captured contract/preparation kind instead of the legacy scheduling default; check jobs stay separate from model work.`);
    const previous=new Map<string,Snapshot>();
    for(const next of snapshots.sort((a,b)=>a.at.localeCompare(b.at)||a.jobId.localeCompare(b.jobId)||a.attempt-b.attempt)) {
      const prior=previous.get(next.scope);previous.set(next.scope,next);if(!prior)continue;
      for(const [property,kind,label] of [['model','model','Recorded worker model changed'],['effort','effort','Recorded reasoning effort changed'],['routing','routing-policy','Captured routing policy hash changed'],['profile','profile','Captured project profile hash changed'],['context','context','Selected context sources changed']] as const) {
        const before=prior[property],after=next[property];if(!before||!after||before===after)continue;
        if(property==='context'&&prior.contextIdentity===next.contextIdentity)continue;
        this.change(result,{at:next.at,kind,scope:next.scope,projectId:next.projectId,jobId:next.jobId,label,before,after,evidence:[...prior.evidence,...next.evidence]});
      }
    }
    return kinds;
  }

  private jobEvents(result:EfficiencyHistoryResult,job:Job,kind:Kind,events:JobEvent[]) {
    const starts=new Map<number,string>(),daily=new Map<string,{event:JobEvent;attempt:number}>();let attempt=0;
    for(const event of events) {
      if(event.detail.action==='claim') {
        starts.set(++attempt,event.createdAt);
        const point=this.point(result,event.createdAt);
        if(point&&attempt>1){point.jobs[kind].retries++;this.references(point.jobs[kind],job.id,[`state/jobs.sqlite:job_events/${event.id}`]);}
      }
      if(['completed','failed','cancelled'].includes(event.toStatus)&&this.inWindow(result,event.createdAt))daily.set(this.day(event.createdAt),{event,attempt});
    }
    for(const [day,{event,attempt}] of daily) {
      const value=result.points.find(point=>point.day===day)!.jobs[kind];value.finished++;
      if(event.toStatus==='completed'){value.completed++;if(attempt===1)value.firstPassCompleted++;}
      else if(event.toStatus==='failed')value.failed++;else value.cancelled++;
      this.references(value,job.id,[`state/jobs.sqlite:job_events/${event.id}`]);
    }
    return starts;
  }

  private async direct(result:EfficiencyHistoryResult,projectId?:string) {
    const store=new InteractionStore(this.root);
    let names:string[];
    try {names=(await this.files.names('artifacts/interactions')).filter(name=>InteractionIdSchema.safeParse(name).success);}
    catch(error){result.coverage.interactions.available=null;this.warn(result,'Interactions: '+this.error(error));return;}
    const selected=await this.latestDirectories(result,'artifacts/interactions',names,this.limits.interactions);
    Object.assign(result.coverage.interactions,{available:names.length,inspected:selected.length,truncated:names.length>selected.length});
    for(const id of selected) {
      try {
        const latest=await store.read(id),start=Math.max(1,latest.revision-this.limits.interactionRevisions+1);
        result.coverage.interactionRevisions.available!+=latest.revision;
        if(start>1)result.coverage.interactionRevisions.truncated=true;
        let previous:InteractionRecord|undefined,opened:InteractionRecord|undefined;
        for(let revision=start;revision<=latest.revision;revision++) {
          let record:InteractionRecord;
          try {record=revision===latest.revision?latest:await store.read(id,revision);result.coverage.interactionRevisions.inspected++;}
          catch(error){opened=undefined;previous=undefined;this.warn(result,`${id}/revision-${revision}: ${this.error(error)}`);continue;}
          if(record.change.kind==='import'||record.status==='imported')continue;
          if(record.route!=='direct'||!this.includeProject(record.projectId)||(projectId&&record.projectId!==projectId)){opened=undefined;previous=undefined;continue;}
          if(previous&&previous.projectId!==record.projectId){opened=undefined;previous=undefined;}
          if(record.status==='open'&&(!previous||['completed','cancelled'].includes(previous.status))) {
            opened=revision===1||record.change.kind==='begin'||previous?record:undefined;
          }
          if(record.status==='completed'&&previous&&previous.status!=='completed') {
            const at=record.change.origin.observedAt,point=this.point(result,at);
            if(point){const value=point.direct;value.completedCycles++;value.interactionIds=[...new Set([...value.interactionIds,id])];value.evidence.push(record.artifactPath);
              if(opened){const elapsed=Date.parse(at)-Date.parse(opened.change.origin.observedAt);
                if(elapsed>=0&&Number.isFinite(elapsed)){value.timedCycles++;value.elapsedWallClockMsTotal=(value.elapsedWallClockMsTotal??0)+elapsed;value.elapsedWallClockMsMean=value.elapsedWallClockMsTotal/value.timedCycles;value.evidence.push(opened.artifactPath);}
                else this.warn(result,`${id}/revision-${revision}: declared cycle timestamps are not ordered; duration omitted.`);
              }
            }
            opened=undefined;
          }
          if(record.status==='cancelled')opened=undefined;
          previous=record;
        }
      }catch(error){this.warn(result,`${id}: ${this.error(error)}`);}
    }
  }

  private async learning(result:EfficiencyHistoryResult,projectId?:string):Promise<Release[]> {
    const store=new KnowledgeLearningStore(this.root),releases:Release[]=[];
    let names:string[];
    try {names=(await this.files.names('artifacts/learning/candidates')).filter(name=>z.uuid().safeParse(name).success);}
    catch(error){result.coverage.learningCandidates.available=null;this.warn(result,'Learning candidates: '+this.error(error));return releases;}
    const selected=await this.latestDirectories(result,'artifacts/learning/candidates',names,this.limits.candidates);
    Object.assign(result.coverage.learningCandidates,{available:names.length,inspected:selected.length,truncated:names.length>selected.length});
    for(const id of selected) {
      try {
        const latest=await store.read(id);if(!this.includeProject(latest.projectId)||(projectId&&latest.projectId!==projectId))continue;
        const start=Math.max(1,latest.revision-this.limits.candidateRevisions+1);result.coverage.candidateRevisions.available!+=latest.revision;
        if(start>1)result.coverage.candidateRevisions.truncated=true;
        let prior:KnowledgeCandidate|undefined;
        for(let revision=start;revision<=latest.revision;revision++) {
          try {
            const record=revision===latest.revision?latest:await store.read(id,revision);result.coverage.candidateRevisions.inspected++;
            if(record.status==='promoted'&&record.promotion) {
              const promotion=record.promotion;
              releases.push({candidateId:id,projectId:record.projectId,path:promotion.path,contentHash:promotion.contentHash,at:promotion.recordedAt,evidence:[record.artifactPath,promotion.path,...promotion.evidence]});
              if(prior?.status!=='promoted')this.change(result,{at:promotion.recordedAt,kind:'promotion',scope:record.projectId,projectId:record.projectId,jobId:null,label:'Explicit knowledge promotion recorded',before:prior?.status??null,after:record.title,evidence:[record.artifactPath,promotion.path,...promotion.evidence]});
            }
            if(record.status==='reverted'&&record.reversal&&prior?.status!=='reverted')this.change(result,{at:record.reversal.recordedAt,kind:'reversal',scope:record.projectId,projectId:record.projectId,jobId:null,label:'Knowledge release reverted',before:prior?.status??null,after:record.title,evidence:[record.artifactPath,...record.reversal.evidence]});
            prior=record;
          }catch(error){prior=undefined;this.warn(result,`${id}/revision-${revision}: ${this.error(error)}`);}
        }
      }catch(error){this.warn(result,`${id}: ${this.error(error)}`);}
    }
    return [...new Map(releases.map(release=>[JSON.stringify([release.candidateId,release.path,release.contentHash,release.at]),release])).values()];
  }

  private async tokens(result:EfficiencyHistoryResult,projectId?:string) {
    const telemetry=result.telemetry,series=new Map<string,TokenHistorySeries>(),seen=new Set<string>();
    try {
      // Parsing, counter-reset detection and per-turn delta derivation stay in the canonical producer.
      const observed=await new InteractionTelemetry(this.root).read({projectId});
      telemetry.enabled=observed.enabled;telemetry.inspected=observed.turnReceipts.filter(receipt=>this.includeProject(receipt.projectId)).length;telemetry.truncated=observed.truncated;
      telemetry.warnings.push(...observed.warnings);if(observed.truncated)this.warn(result,'Derived turn-token inventory is incomplete.',true);
      for(const receipt of observed.turnReceipts) {
        if(!this.includeProject(receipt.projectId))continue;
        const at=receipt.finishedAt??receipt.startedAt;if(!this.inWindow(result,at))continue;
        const key=`${receipt.interactionId}/${receipt.turnId}`;if(seen.has(key))continue;seen.add(key);
        if(receipt.status!=='complete'||!receipt.finishedAt||!receipt.tokens||!receipt.coverage.baselineObserved||!receipt.coverage.terminalObserved||receipt.coverage.counterResets||receipt.coverage.limited){telemetry.incompleteTurns++;continue;}
        telemetry.completeTurns++;
        if(!receipt.projectId||!receipt.performanceScope||receipt.assignment!=='interaction-revision'){telemetry.unassignedTurns++;continue;}
        const scope=receipt.performanceScope;
        const id=KnowledgeFiles.hash(JSON.stringify({projectId:receipt.projectId,taskClass:scope.taskClass,language:scope.language??null,problemCategory:scope.problemCategory??null}));
        if(!series.has(id)) {
          if(series.size>=this.limits.series){telemetry.truncated=true;this.warn(result,'Token performance-scope series truncated to '+this.limits.series+'.',true);continue;}
          series.set(id,{id,projectId:receipt.projectId,performanceScope:scope,classification:'observed',unit:'tokens',scope:'complete-turn-delta',points:result.points.map(point=>({day:point.day,n:0,totalTokens:null,inputTokens:null,uncachedInputTokens:null,cachedInputTokens:null,outputTokens:null,reasoningOutputTokens:null,cacheWriteInputTokens:null,metricSamples:{totalTokens:0,inputTokens:0,uncachedInputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,cacheWriteInputTokens:0},interactionIds:[],turnIds:[],evidence:[]}))});
        }
        const point=series.get(id)!.points.find(point=>point.day===this.day(at))!,tokens=receipt.tokens;
        const uncached=tokens.inputTokens!==null&&tokens.cachedInputTokens!==null&&tokens.inputTokens>=tokens.cachedInputTokens?tokens.inputTokens-tokens.cachedInputTokens:null;
        for(const metric of tokenMetrics) {
          const value=metric==='uncachedInputTokens'?uncached:tokens[metric];
          if(value!==null){point[metric]=(point[metric]??0)+value;point.metricSamples[metric]++;}
        }
        point.n++;point.interactionIds=[...new Set([...point.interactionIds,receipt.interactionId])];point.turnIds.push(receipt.turnId);point.evidence.push(receipt.artifactPath);
      }
    }catch(error){telemetry.warnings.push('Turn tokens: '+this.error(error));}
    telemetry.warnings=[...new Set(telemetry.warnings)];telemetry.warnings.forEach(warning=>this.warn(result,warning));result.tokenSeries=[...series.values()];
  }

  private async durations(result:EfficiencyHistoryResult,projectId:string|undefined,kinds:Map<string,Kind>) {
    const store=new EvaluationStore(this.root),labels=new OperationalInsights(this.root),receipts:EvaluationReceipt[]=[];
    try {
      let offset=0;
      do {const page=await store.list({projectId,offset,limit:Math.min(100,this.limits.evaluations-offset)});receipts.push(...page.items);result.coverage.evaluations.available=page.truncated?null:page.total;
        result.coverage.evaluations.truncated ||= page.truncated;page.warnings.forEach(warning=>this.warn(result,warning));if(page.nextOffset===null)break;offset=page.nextOffset;
      }while(offset<this.limits.evaluations);
      result.coverage.evaluations.inspected=receipts.length;if((result.coverage.evaluations.available??receipts.length)>receipts.length)result.coverage.evaluations.truncated=true;
    }catch(error){result.coverage.evaluations.available=null;this.warn(result,'Evaluations: '+this.error(error));return;}
    const series=new Map<string,CheckDurationSeries>(),seen=new Set<string>();
    for(const receipt of receipts) {
      const kind=kinds.get(receipt.jobId);if(!kind||receipt.technical.status!=='passed'||receipt.technical.criticalGateStatus!=='passed')continue;
      for(const metric of receipt.metrics) {
        if(metric.classification!=='observed'||metric.unit!=='ms'||metric.sample.size!==1||!metric.method.includes('ProcessRunner')||!metric.method.includes('durationMs'))continue;
        if(!this.inWindow(result,metric.window.end))continue;
        const id=KnowledgeFiles.hash(JSON.stringify({projectId:receipt.projectId,kind,taskClass:receipt.taskClass,rubric:receipt.rubric,metricId:metric.id,unit:metric.unit,method:metric.method,cohort:metric.cohort,version:metric.version}));
        const observationKey=`${id}/${receipt.jobId}/${receipt.attempt}`;if(seen.has(observationKey))continue;seen.add(observationKey);
        if(!series.has(id)) {
          if(series.size>=this.limits.series){this.warn(result,'Compatible duration series truncated to '+this.limits.series+'.',true);continue;}
          series.set(id,{id,projectId:receipt.projectId,executionKind:kind,metricId:metric.id,metricLabel:labels.metricLabel(receipt,metric.id),unit:metric.unit,method:metric.method,cohort:metric.cohort,
            points:result.points.map(point=>({day:point.day,n:0,mean:null,min:null,max:null,evaluationIds:[]}))});
        }
        const point=series.get(id)!.points.find(point=>point.day===this.day(metric.window.end))!;
        point.mean=((point.mean??0)*point.n+metric.value)/(point.n+1);point.min=Math.min(point.min??metric.value,metric.value);point.max=Math.max(point.max??metric.value,metric.value);point.n++;point.evaluationIds.push(receipt.id);
      }
    }
    result.durationSeries=[...series.values()];
  }

  private async latestDirectories(result:EfficiencyHistoryResult,relative:string,names:string[],limit:number) {
    const inspected=await Promise.allSettled(names.map(async name=>({name,mtime:(await fs.stat(await this.files.file(`${relative}/${name}`))).mtimeMs})));
    const modified=inspected.flatMap((entry,index)=>{if(entry.status==='fulfilled')return [entry.value];this.warn(result,`${relative}/${names[index]}: ${this.error(entry.reason)}`);return [];});
    return modified.sort((a,b)=>b.mtime-a.mtime||a.name.localeCompare(b.name)).slice(0,limit).map(entry=>entry.name);
  }
  private emptyJob():JobHistoryPoint {return {classification:'observed',finished:0,completed:0,firstPassCompleted:0,firstPassRate:null,failed:0,failedRate:null,cancelled:0,retries:0,jobIds:[],evidence:[]};}
  private references(point:JobHistoryPoint,jobId:string,evidence:string[]) {point.jobIds=[...new Set([...point.jobIds,jobId])];point.evidence=[...new Set([...point.evidence,...evidence])];}
  private change(result:EfficiencyHistoryResult,value:Omit<HistoryChange,'id'|'day'>) {
    if(!this.inWindow(result,value.at))return;
    result.changes.push({...value,id:KnowledgeFiles.hash(JSON.stringify(value)),day:this.day(value.at),evidence:[...new Set(value.evidence)]});
  }
  private day(at:string) {const parts=this.calendar.formatToParts(new Date(at));return ['year','month','day'].map(type=>parts.find(part=>part.type===type)!.value).join('-');}
  private inWindow(result:EfficiencyHistoryResult,at:string) {return Number.isFinite(Date.parse(at))&&Date.parse(at)<=Date.parse(result.observedAt)&&this.day(at)>=result.window.startDay&&this.day(at)<=result.window.endDay;}
  private point(result:EfficiencyHistoryResult,at:string) {return this.inWindow(result,at)?result.points.find(point=>point.day===this.day(at)):undefined;}
  private warn(result:EfficiencyHistoryResult,warning:string,truncated=false) {result.coverage.warnings.push(EvidenceSanitizer.text(warning,1000));result.coverage.truncated ||= truncated;}
  private error(error:unknown) {return this.errorText(error instanceof Error?error.message:String(error));}
  private errorText(value:string) {return EvidenceSanitizer.text(value,500);}
}
