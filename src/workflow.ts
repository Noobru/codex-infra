import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {TaskEngine} from './engine.js';
import {TaskDetailsSchema} from './task-contract.js';
import {TaskQualificationSchema} from './routing.js';
import {QueueCoordinator,type DrainOptions,type DrainResult} from './queue.js';
import {SupervisorManager} from './supervisor.js';
import {atomicWriteJson,readJson,resolveRealSubPath} from './legacy/command-os-utils.js';

export const WorkflowTaskSchema=z.object({project:z.string().min(1),objective:z.string().trim().min(1).max(20000),mode:z.enum(['read-only','workspace-write']),kind:z.enum(['checks','codex']),checkIds:z.array(z.string().min(1)).min(1).max(40),requirementIds:z.array(z.string()).max(40).default([]),workspace:z.enum(['in-place','worktree']).default('in-place'),baseRef:z.string().optional(),taskDetails:TaskDetailsSchema.optional(),routing:TaskQualificationSchema.optional()});
const nodeId=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const WorkflowNodeSchema=z.object({id:nodeId,dependsOn:z.array(nodeId).max(40).default([]),task:WorkflowTaskSchema});
export const WorkflowInputSchema=z.object({idempotencyKey:z.string().min(1).max(200),objective:z.string().trim().min(1).max(20000),nodes:z.array(WorkflowNodeSchema).min(1).max(40),maxRevisions:z.number().int().min(1).max(5).default(3)});
export const WorkflowReplanSchema=z.object({reason:z.string().trim().min(1).max(4000),evidence:z.string().trim().min(1).max(4000),replacements:z.array(z.object({nodeId,task:WorkflowTaskSchema})).min(1).max(40)});
type WorkflowInput=z.infer<typeof WorkflowInputSchema>;
export interface WorkflowPlan {version:1;id:string;revision:number;requestHash:string;objective:string;maxRevisions:number;createdAt:string;state:'preparing'|'prepared'|'superseded';nodes:(z.infer<typeof WorkflowNodeSchema>&{jobId?:string})[];reason?:string;evidence?:string;replanHash?:string;replaces?:{nodeId:string;jobId:string}[]}

/** Durable plan revisions composed from the existing task engine and bounded queue. No second executor. */
export class WorkflowStore {
  constructor(protected readonly root:string){}
  protected ordered(nodes:WorkflowInput['nodes']) {
    const map=new Map(nodes.map(node=>[node.id,node]));
    if(map.size!==nodes.length)throw new Error('Workflow node IDs must be unique');
    const result:WorkflowInput['nodes']=[],visiting=new Set<string>(),done=new Set<string>();
    const visit=(id:string)=>{
      if(visiting.has(id))throw new Error('Workflow dependency cycle');
      if(done.has(id))return;
      const node=map.get(id);if(!node)throw new Error('Unknown workflow dependency: '+id);
      if(new Set(node.dependsOn).size!==node.dependsOn.length)throw new Error('Duplicate workflow dependency');
      visiting.add(id);node.dependsOn.forEach(visit);visiting.delete(id);done.add(id);result.push(node);
    };
    nodes.forEach(node=>visit(node.id));return result;
  }
  protected async directory(id:string,create=false) {
    if(!/^workflow_[a-f0-9-]{36}$/.test(id))throw new Error('Invalid workflow ID');
    const directory=path.join(this.root,'artifacts/workflows',id);
    if(create)await fs.mkdir(directory,{recursive:true});
    const resolved=await resolveRealSubPath(directory,this.root);
    if(!resolved||(await fs.lstat(directory)).isSymbolicLink())throw new Error('Workflow is outside the infrastructure');
    return resolved;
  }
  async read(id:string):Promise<WorkflowPlan> {
    const directory=await this.directory(id), pointer=await readJson(path.join(directory,'current.json'),null);
    if(!pointer||!Number.isInteger(pointer.revision))throw new Error('Workflow has no prepared revision');
    const plan=await readJson(path.join(directory,`revision-${pointer.revision}.json`),null) as WorkflowPlan|null;
    if(!plan||plan.version!==1||plan.id!==id||plan.revision!==pointer.revision)throw new Error('Workflow plan is incomplete');
    return plan;
  }
  async list():Promise<WorkflowPlan[]> {
    const names=await fs.readdir(path.join(this.root,'artifacts/workflows')).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;});
    const plans=[];for(const name of names)if(/^workflow_[a-f0-9-]{36}$/.test(name))plans.push(await this.read(name));return plans;
  }
}
export class WorkflowManager extends WorkflowStore {
  constructor(private readonly engine:TaskEngine){super(engine.root);}
  async prepare(raw:unknown):Promise<WorkflowPlan> {
    const input=WorkflowInputSchema.parse(raw),nodes=this.ordered(input.nodes);
    const hash=createHash('sha256').update(input.idempotencyKey).digest('hex');
    const id='workflow_'+[hash.slice(0,8),hash.slice(8,12),hash.slice(12,16),hash.slice(16,20),hash.slice(20,32)].join('-');
    const requestHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.engine.profiles.withLock(async()=>{
      const directory=await this.directory(id,true);
      const existing=await readJson(path.join(directory,'revision-1.json'),null) as WorkflowPlan|null;
      if(existing && existing.requestHash!==requestHash)throw new Error('Workflow key belongs to a different plan');
      if(existing?.state==='prepared'){const current=await this.read(id);await this.activate(current);return current;}
      const plan:WorkflowPlan=existing??{version:1,id,revision:1,requestHash,objective:input.objective,maxRevisions:input.maxRevisions,createdAt:new Date().toISOString(),state:'preparing',nodes};
      await atomicWriteJson(path.join(directory,'current.json'),{revision:1});
      await this.prepareRevision(directory,plan);
      return plan;
    });
  }
  private async prepareRevision(directory:string,plan:WorkflowPlan) {
    await atomicWriteJson(path.join(directory,`revision-${plan.revision}.json`),plan);
    for(const node of plan.nodes) {
      if(node.jobId)continue;
      const dependencyIds=node.dependsOn.map(id=>{const parent=plan.nodes.find(n=>n.id===id);if(!parent?.jobId)throw new Error('Dependency was not prepared');return parent.jobId;});
      const job=await this.engine.prepare({...node.task,idempotencyKey:`${plan.id}:r${plan.revision}:${node.id}`,dependencyIds,workflow:{id:plan.id,revision:plan.revision}});
      node.jobId=job.id;
      await atomicWriteJson(path.join(directory,`revision-${plan.revision}.json`),plan);
    }
    plan.state='prepared';
    await atomicWriteJson(path.join(directory,`revision-${plan.revision}.json`),plan);
    await atomicWriteJson(path.join(directory,'current.json'),{revision:plan.revision});
    await this.activate(plan);
  }
  private async activate(plan:WorkflowPlan) {
    for(const jobId of this.jobIds(plan)) {
      const job=this.engine.state.get(jobId);
      if(job.status==='waiting_user'&&job.attempts===0)this.engine.state.transition(jobId,'ready');
    }
  }
  private jobIds(plan:WorkflowPlan):string[] {
    if(plan.state!=='prepared'||plan.nodes.some(n=>!n.jobId))throw new Error('Workflow preparation is incomplete; resume its prepare request');
    return plan.nodes.map(node=>node.jobId!);
  }
  async run(id:string,options:Pick<DrainOptions,'totalTimeoutMs'|'concurrency'|'signal'>) {
    const plan=await this.engine.profiles.withLock(async()=>{const plan=await this.read(id);await this.activate(plan);return plan;});
    const jobIds=this.jobIds(plan);
    const drain=await new QueueCoordinator(this.engine).drain({...options,maxJobs:jobIds.length,jobIds});
    return this.consolidate(id,drain);
  }
  async start(id:string,options:{totalTimeoutMs:number;concurrency?:number}) {
    const plan=await this.engine.profiles.withLock(async()=>{const plan=await this.read(id);await this.activate(plan);return plan;});
    const jobIds=this.jobIds(plan);
    return new SupervisorManager(this.engine.root).start({...options,maxJobs:jobIds.length,jobIds,workflowId:id});
  }
  async cancel(id:string) {
    const directory=await this.directory(id),ids=new Set<string>();
    for(const name of await fs.readdir(directory))if(/^revision-\d+\.json$/.test(name)) {
      const plan=await readJson(path.join(directory,name),null) as WorkflowPlan;
      for(const node of plan.nodes)if(node.jobId)ids.add(node.jobId);
    }
    await Promise.all([...ids].map(jobId=>this.engine.cancel(jobId)));return this.consolidate(id);
  }
  async consolidate(id:string,drain?:DrainResult) {
    const plan=await this.read(id);
    const nodes=plan.nodes.map(node=>({id:node.id,dependsOn:node.dependsOn,job:node.jobId?this.engine.state.get(node.jobId):null,evidence:node.jobId?this.engine.artifactDir(node.jobId):null}));
    const completed=nodes.every(node=>node.job?.status==='completed');
    const active=nodes.some(node=>['running','validating'].includes(node.job?.status??''));
    const failed=nodes.filter(node=>['failed','waiting_user','waiting_quota','cancelled'].includes(node.job?.status??''));
    const summary={version:1,workflowId:id,revision:plan.revision,objective:plan.objective,capturedAt:new Date().toISOString(),status:completed?'completed':active?'running':failed.length?'blocked':'ready',nodes,
      nextAction:completed?'Delivered':failed.length?(plan.revision<plan.maxRevisions?'Inspect failed nodes and submit a bounded replan or explicit retry':'Revision budget exhausted; inspect results before creating another plan'):'Run or resume prepared nodes',...(drain?{drain}:{})};
    await atomicWriteJson(path.join(await this.directory(id),`result-${plan.revision}.json`),summary);return summary;
  }
  async replan(id:string,raw:unknown) {
    const input=WorkflowReplanSchema.parse(raw);
    return this.engine.profiles.withLock(async()=>{
      const old=await this.read(id);this.jobIds(old);
      const directory=await this.directory(id);
      const revisions=(await fs.readdir(directory)).map(name=>/^revision-(\d+)\.json$/.exec(name)?.[1]).filter(Boolean).map(Number);
      const latestRevision=Math.max(...revisions),replanHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const draft=latestRevision>old.revision?await readJson(path.join(directory,`revision-${latestRevision}.json`),null) as WorkflowPlan:null;
      if(draft?.state==='preparing'&&draft.replanHash===replanHash){await this.prepareRevision(directory,draft);await this.cancelReplaced(draft);return draft;}
      const nextRevision=latestRevision+1;
      if(nextRevision>old.maxRevisions)throw new Error('Workflow revision budget exhausted');
      if(old.nodes.some(node=>['running','validating'].includes(this.engine.state.get(node.jobId!).status)))throw new Error('Stop active workflow workers before replanning');
      const affected=new Set(input.replacements.map(r=>r.nodeId));
      if(affected.size!==input.replacements.length)throw new Error('Duplicate replacement node');
      for(const replacement of input.replacements) {
        const prior=old.nodes.find(n=>n.id===replacement.nodeId);
        if(!prior)throw new Error('Replacement node does not exist');
        if(this.engine.state.get(prior.jobId!).status==='completed')throw new Error('Completed nodes are retained; replace a failed or pending node');
        const before=await this.engine.registry.resolve(prior.task.project),after=await this.engine.registry.resolve(replacement.task.project);
        if(before.id!==after.id || prior.task.mode!==replacement.task.mode)throw new Error('Replan cannot expand project or authority mode');
      }
      for(const node of old.nodes)if(node.dependsOn.some(parent=>affected.has(parent)))affected.add(node.id);
      const nodes=old.nodes.map(node=>{
        if(!affected.has(node.id))return {...node};
        const task=input.replacements.find(r=>r.nodeId===node.id)?.task??node.task;
        return {id:node.id,dependsOn:node.dependsOn,task};
      });
      if(draft?.state==='preparing') {
        for(const node of draft.nodes)if(node.jobId&&!old.nodes.some(n=>n.jobId===node.jobId))await this.engine.cancel(node.jobId);
        await atomicWriteJson(path.join(directory,`revision-${draft.revision}.json`),{...draft,state:'superseded'});
      }
      const plan:WorkflowPlan={...old,revision:nextRevision,createdAt:new Date().toISOString(),state:'preparing',nodes,reason:input.reason,evidence:input.evidence,replanHash,replaces:old.nodes.filter(n=>affected.has(n.id)).map(n=>({nodeId:n.id,jobId:n.jobId!}))};
      await this.prepareRevision(directory,plan);
      await this.cancelReplaced(plan);
      return plan;
    });
  }
  private async cancelReplaced(plan:WorkflowPlan) {
    for(const prior of plan.replaces??[])if(this.engine.state.get(prior.jobId).status==='ready')await this.engine.cancel(prior.jobId);
  }
}
