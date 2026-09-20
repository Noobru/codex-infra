import path from 'node:path';
import {z} from 'zod';
import {TaskEngine} from './engine.js';
import {WorkUnitStore,WorkUnitInputSchema,type WorkUnitRecord} from './work-unit.js';
import {WorkUnitIdSchema} from './work-unit-contract.js';
import {InteractionStore,InteractionIdSchema} from './interactions.js';
import {InteractionTelemetry} from './interaction-telemetry.js';
import {readJson} from './legacy/command-os-utils.js';

export const WorkUnitKeySchema=z.object({interactionId:InteractionIdSchema,unitId:WorkUnitIdSchema}).strict();
export const WorkUnitRunSchema=WorkUnitKeySchema.extend({background:z.boolean().default(true),timeoutMs:z.number().int().min(1000).max(1800000).default(300000)}).superRefine((v,c)=>{if(!v.background&&v.timeoutMs>240000)c.addIssue({code:'custom',message:'Use background execution for more than 240000 ms'});});
export const WorkUnitDirectSchema=WorkUnitKeySchema.extend({summary:z.string().trim().min(1).max(4000),evidence:z.array(z.string().trim().min(1).max(2000)).min(1).max(40)});
const bindingSchema=z.object({jobId:z.uuid(),contractHash:z.string()});
const directSchema=z.object({summary:z.string(),evidence:z.array(z.string()),contractHash:z.string()});

/** Coordinates existing contracts/jobs; this is neither a second executor nor a Desktop interceptor. */
export class WorkCoordinator {
  readonly units:WorkUnitStore;
  constructor(readonly engine:TaskEngine){this.units=new WorkUnitStore(engine.root);}
  async prepare(raw:z.input<typeof WorkUnitInputSchema>){
    const unit=await this.units.plan(raw);
    if(unit.route!=='coordinator')await this.bind(unit);
    return this.status(unit.input);
  }
  private async binding(unit:WorkUnitRecord){
    const dir=this.units.directory(unit.input.interactionId,unit.input.unitId);
    if(!(await this.units.files.names(dir)).includes('binding.json'))return null;
    const binding=await this.units.files.read(dir+'/binding.json',bindingSchema);
    if(binding.contractHash!==unit.contractHash)throw new Error('Job binding differs from the work-unit contract');
    const manifest=await readJson(path.join(this.engine.artifactDir(binding.jobId),'manifest.json'),null);
    if(manifest?.taskContract?.details.workUnit?.contractHash!==unit.contractHash)throw new Error('Job is not bound to this work unit');
    return binding;
  }
  private async bind(unit:WorkUnitRecord){
    await this.units.assertActive(unit);
    const existing=await this.binding(unit);if(existing)return this.engine.state.get(existing.jobId);
    const input=unit.input,ref=this.units.ref(unit);
    const job=await this.engine.prepare({project:unit.projectId,objective:input.objective,
      idempotencyKey:`work-unit:${input.interactionId}:${input.unitId}`,mode:input.mode,kind:unit.route==='worker'?'codex':'checks',
      checkIds:input.checkIds,requirementIds:input.requirementIds,workspace:input.workspace,...(input.baseRef?{baseRef:input.baseRef}:{}),
      taskDetails:{...input.taskDetails,workUnit:ref},...(unit.route==='worker'?{routing:input.routing}:{})});
    await this.units.files.writeVerified(this.units.directory(input.interactionId,input.unitId)+'/binding.json',JSON.stringify({jobId:job.id,contractHash:unit.contractHash},null,2)+'\n');
    return job;
  }
  async recordDirect(raw:z.input<typeof WorkUnitDirectSchema>){
    const input=WorkUnitDirectSchema.parse(raw),unit=await this.units.read(input.interactionId,input.unitId);
    if(unit.route!=='coordinator')throw new Error('Only a coordinator unit accepts a direct-work declaration');
    await this.units.assertActive(unit);
    await this.units.files.writeVerified(this.units.directory(input.interactionId,input.unitId)+'/direct-result.json',JSON.stringify({summary:input.summary,evidence:input.evidence,contractHash:unit.contractHash},null,2)+'\n');
    await this.bind(unit);return this.status(input);
  }
  async run(raw:z.input<typeof WorkUnitRunSchema>){
    const input=WorkUnitRunSchema.parse(raw),unit=await this.units.read(input.interactionId,input.unitId);
    const job=await this.bind(unit);
    const supervisor=input.background?await this.engine.startPrepared(job.id,input.timeoutMs):null;
    if(!input.background)await this.engine.run(job.id,input.timeoutMs);
    return {...await this.status(input),supervisor};
  }
  async status(raw:z.input<typeof WorkUnitKeySchema>){
    const input=WorkUnitKeySchema.parse({interactionId:raw.interactionId,unitId:raw.unitId});
    const unit=await this.units.read(input.interactionId,input.unitId),binding=await this.binding(unit);
    const dir=this.units.directory(input.interactionId,input.unitId);
    const direct=(await this.units.files.names(dir)).includes('direct-result.json')?await this.units.files.read(dir+'/direct-result.json',directSchema):null;
    return {unit,job:binding?this.engine.state.get(binding.jobId):null,delivery:binding?await this.engine.delivery(binding.jobId):null,
      directExecution:unit.route==='coordinator'?{coverage:'reported-not-intercepted',declaration:direct}:null,
      scope:unit.route==='coordinator'?'Outcome validation is governed; Desktop execution and actual model are not enforced.':'Execution and validation use the governed TaskEngine.',
      recovery:unit.input.taskDetails.resolution?'contracted':'not-contracted',recoveryReason:unit.input.recoveryReason};
  }
  async summary(interactionId:string){
    const parent=await new InteractionStore(this.engine.root).read(interactionId),units=await this.units.list(interactionId);
    const statuses=[];for(const unit of units)statuses.push(await this.status(unit.input));
    const jobs=new Set(statuses.flatMap(s=>s.job?[s.job.id]:[])),workerThreads=new Map<string,{model:string|null;usage:Record<string,number|null>;evidence:string;finishedAt:string|null;turnIds:string[]}>();
    const missing:string[]=[];
    // A resumed thread reports cumulative counts: retain its final snapshot once, never sum attempts.
    for(const id of jobs){const job=this.engine.state.get(id);for(let attempt=1;attempt<=job.attempts;attempt++){
      const file=path.join(this.engine.artifactDir(id),`attempt-${attempt}`,'worker.json'),worker=await readJson(file,null);
      if(!worker)continue;
      if(!worker.threadId||worker.receipt?.tokenUsageScope!=='thread-cumulative'||!worker.receipt?.tokenUsage){missing.push(`${id}/attempt-${attempt}`);continue;}
      const usage=worker.receipt.tokenUsage,previous=workerThreads.get(worker.threadId);
      if(previous&&typeof usage.totalTokens==='number'&&typeof previous.usage.totalTokens==='number'&&usage.totalTokens<previous.usage.totalTokens){missing.push(`counter-reset:${worker.threadId}`);continue;}
      workerThreads.set(worker.threadId,{model:worker.receipt.model??null,usage,evidence:file,finishedAt:worker.receipt.finishedAt??null,turnIds:[...new Set([...(previous?.turnIds??[]),...(worker.turnId?[worker.turnId]:[])])]});
    }}
    const telemetry=await new InteractionTelemetry(this.engine.root).read({projectId:parent.projectId??undefined});
    const ambiguousOverlap:typeof telemetry.turnReceipts=[];
    const turns=telemetry.turnReceipts.filter(r=>{
      if(r.interactionId!==interactionId)return false;
      const snapshot=workerThreads.get(r.threadId);if(!snapshot)return true;
      if(snapshot.turnIds.includes(r.turnId))return false;
      if(snapshot.finishedAt&&Date.parse(r.startedAt)>=Date.parse(snapshot.finishedAt))return true;
      if(snapshot.finishedAt&&r.finishedAt&&Date.parse(r.finishedAt)<=Date.parse(snapshot.finishedAt))return false;
      ambiguousOverlap.push(r);return false;
    });
    const coordinator=turns.filter(r=>r.status==='complete'&&r.tokens),seen=new Set<string>();
    const distinct=coordinator.filter(r=>{const key=r.threadId+':'+r.turnId;if(seen.has(key))return false;seen.add(key);return true;});
    const metrics=['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens'] as const;
    const totals=(values:Record<string,number|null>[])=>Object.fromEntries(metrics.map(key=>{const observed=values.map(v=>v[key]).filter((v):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0);return [key,{observed:observed.length?observed.reduce((a,b)=>a+b,0):null,samples:observed.length,missing:values.length-observed.length}];}));
    return {interactionId,units:statuses,coverage:{planned:units.length,worker:statuses.filter(s=>s.unit.route==='worker').length,
      coordinator:statuses.filter(s=>s.unit.route==='coordinator').length,verified:statuses.filter(s=>s.delivery?.outcomeStatus==='passed').length,
      linkedJobsOutsideUnits:parent.jobIds.filter(id=>!jobs.has(id)),unregisteredDesktopWork:'unknown'},
      usage:{unitWorkers:{scope:'latest-cumulative-snapshot-per-owned-worker-thread',threads:[...workerThreads].map(([threadId,v])=>({threadId,...v})),totals:totals([...workerThreads.values()].map(v=>v.usage)),missing},
        coordinator:{scope:'whole-interaction-complete-turn-deltas-not-per-unit',turnIds:distinct.map(r=>r.turnId),totals:totals(distinct.map(r=>r.tokens!)),incomplete:turns.length-distinct.length},
        combined:{scope:'observed-components-with-different-windows-not-objective-cost',totals:totals([...workerThreads.values()].map(v=>v.usage).concat(distinct.map(r=>r.tokens!)))},
        ambiguousOverlap, warnings:[...telemetry.warnings,...(ambiguousOverlap.length?['Some coordinator turns overlap an incompletely bounded worker snapshot; preserved separately and excluded from combined totals.']:[])],truncated:telemetry.truncated,quotaEquivalent:false},
      limitations:['A planned decision documents reasoning; it does not prove that semantic classification was correct.',
        'Coordinator usage covers the whole interaction, including work before these units. It cannot be allocated to individual units.',
        'Missing, partial, reset or unregistered activity prevents an exact total. Cached input is part of input, not added again.',
        'No automatic change of models, permissions or policy follows from these measurements.']};
  }
}
