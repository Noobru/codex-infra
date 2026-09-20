import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectRegistry, type ProjectContext, type Profile } from './registry.js';
import { StateStore, type Job, type JobMode } from './state.js';
import { atomicWriteJson, atomicWriteNew, readJson, errorMessage, isSubPath } from './legacy/command-os-utils.js';
import { CodexWorker } from './codex-worker.js';
import { WorkspaceManager } from './workspace.js';
import { ProfileManager } from './profile-manager.js';
import { ProcessCleanupError } from './process.js';
import { TaskContractBuilder, TaskDetailsSchema, type TaskContract, type TaskDetailsInput } from './task-contract.js';
import { KnowledgeIndex } from './knowledge-index.js';
import { KnowledgeLearningStore } from './knowledge-learning.js';
import { RoutingPolicy, TaskRoutingInputSchema, TaskQualificationSchema, type TaskRoutingInput, type RoutingConfiguration, type RoutingDecision } from './routing.js';
import { RoutingConfigurationStore } from './routing-configuration.js';
import { z } from 'zod';
import { CapabilityPlanner } from './capability-planner.js';
import { ExecutionEvidence } from './execution-evidence.js';
import { ExecutionPolicyManager } from './execution-policy.js';
import {WorkflowStore} from './workflow.js';
import {OperationalInsights} from './operational-insights.js';
import {EvidenceSanitizer} from './evidence.js';
import {OutcomeVerifier} from './outcome.js';
import {DelegationContract,type TaskBlocker} from './delegation-contract.js';
import {ObjectiveCoordinator,type DispatchOptions,type BlockerReceipt} from './objective-coordinator.js';
import {ExecutionStop} from './execution-stop.js';
import {SupervisorManager,type SupervisorReceipt} from './supervisor.js';
import {WorkUnitStore} from './work-unit.js';

export interface PrepareInput {
  project: string; objective: string; idempotencyKey: string; mode: JobMode;
  kind: 'checks' | 'codex'; checkIds: string[]; dependencyIds?: string[]; requirementIds?: string[];
  workspace?: 'in-place' | 'worktree'; baseRef?: string;
  taskDetails?: TaskDetailsInput;
  routing?: TaskRoutingInput;
  workflow?:{id:string;revision:number};
}
interface WorkspaceSelection { kind: 'in-place' | 'worktree'; baseRef?: string; baseSha?: string }
interface Manifest { version: 1; kind: PrepareInput['kind']; checkIds: string[]; requirementIds?: string[]; workspace?: WorkspaceSelection; context: ProjectContext; taskContract?: TaskContract; routing?: TaskRoutingInput; routingPolicy?: RoutingConfiguration; routingDecision?: RoutingDecision; workflow?:PrepareInput['workflow'] }

export const DelegationInputSchema = z.object({
  project: z.string().min(1), objective: z.string().trim().min(1).max(20000), idempotencyKey: z.string().min(1),
  mode: z.enum(['read-only', 'workspace-write']), checkIds: z.array(z.string().min(1)).describe('Distinct check IDs registered on the project. Empty requires taskDetails.outcomeCriteria; prose acceptanceCriteria alone is insufficient.'),
  requirementIds: z.array(z.string()).default([]), workspace: z.enum(['in-place', 'worktree']).default('in-place').describe('Select a workspace allowed by the project profile. Worktree requires an explicit local baseRef.'),
  baseRef: z.string().min(1).optional(), taskDetails: TaskDetailsSchema.optional(),
  qualification: TaskQualificationSchema,
  background: z.boolean().default(false).describe('Use true for research/review or long work: return a supervisor receipt immediately and poll task_status/queue_status.'),
  timeoutMs: z.number().int().min(1000).max(1800000).default(180000).describe('Execution budget, not MCP waiting time. Up to 240000 ms foreground; up to 1800000 ms with background:true.'),
}).strict().superRefine((input,ctx)=>{
  if(!input.background&&input.timeoutMs>240000)ctx.addIssue({code:'custom',path:['timeoutMs'],message:'Foreground delegation allows at most 240000 ms. Use background:true for up to 1800000 ms and inspect task_status/queue_status.'});
});
export type DelegationInput = z.input<typeof DelegationInputSchema>;
export class TaskEngine {
  readonly registry: ProjectRegistry;
  readonly state: StateStore;
  readonly profiles: ProfileManager;
  readonly execution: ExecutionPolicyManager;
  readonly insights: OperationalInsights;
  readonly routing: RoutingConfigurationStore;
  constructor(readonly root: string, private worker: Pick<CodexWorker, 'run'> = new CodexWorker()) {
    this.registry = new ProjectRegistry(path.join(root, 'profiles/registry.json'));
    this.state = new StateStore(path.join(root, 'state/jobs.sqlite'));
    this.profiles = new ProfileManager(this.registry, this.state, root);
    this.execution = new ExecutionPolicyManager(root,this.profiles,this.state);
    this.insights = new OperationalInsights(root);
    this.routing = new RoutingConfigurationStore(root);
  }
  artifactDir(id: string): string { this.state.get(id); return path.join(this.root, 'artifacts/jobs', id); }
  async projectContext(project:string) {return new KnowledgeLearningStore(this.root).augmentContext(await this.registry.context(await this.registry.resolve(project)));}
  private async contextPack(profile:Profile,context:ProjectContext,contract:TaskContract) {
    const augmented=await new KnowledgeLearningStore(this.root).augmentContext(context);
    const index=new KnowledgeIndex(this.root),capture=await index.build(profile,augmented);
    const search=await index.search(capture.id,contract);
    return {contextPack:search.pack,knowledge:{indexId:search.indexId,graph:search.graph,freshness:search.freshness}};
  }
  async previewContext(input:Pick<PrepareInput,'project'|'objective'|'mode'|'kind'|'checkIds'|'requirementIds'|'taskDetails'>) {
    const profile=await this.registry.resolve(input.project);
    this.registry.assertMode(profile,input.mode);
    const taskContract=new TaskContractBuilder().build({...input,projectId:profile.id,details:input.taskDetails});
    const context=await this.registry.context(profile);
    const {contextPack,knowledge}=await this.contextPack(profile,context,taskContract);
    return {taskContract,contextPack,knowledge,capabilityPlan:new CapabilityPlanner().plan(profile,taskContract,contextPack)};
  }
  async prepare(input: PrepareInput, admission: { delegateOnly?: boolean } = {}): Promise<Job> {
    if(input.taskDetails?.workUnit)await new WorkUnitStore(this.root).assertTask(input.taskDetails.workUnit,input);
    // The orchestrator classifies the task before any job/context side effect, never the owner.
    const routing = input.kind === 'checks'
      ? TaskRoutingInputSchema.parse({ taskClass: 'deterministic' }) : TaskQualificationSchema.parse(input.routing);
    const routingPolicy = input.kind === 'checks' ? new RoutingPolicy() : await this.routing.read();
    const routingDecision = routingPolicy.decide(routing);
    if (routingDecision.status === 'blocked') throw new Error(routingDecision.reason);
    if (admission.delegateOnly && routingDecision.assignment === 'coordinator') {
      throw new Error('This task belongs to the current coordinator. '+routingDecision.reason+' Continue there; no duplicate coordinator worker was created.');
    }
    const profile = await this.registry.resolve(input.project);
    await this.assertActivated(profile.id);
    this.registry.assertMode(profile, input.mode);
    if (!input.objective.trim() || input.objective.length > 20000) throw new Error('Objective must contain 1–20000 characters');
    if (!['checks', 'codex'].includes(input.kind)) throw new Error('Invalid execution kind');
    if (new Set(input.checkIds).size !== input.checkIds.length) throw new Error('checkIds must contain distinct acceptance check IDs; remove duplicates.');
    if (input.checkIds.length === 0 && !input.taskDetails?.outcomeCriteria?.length) throw new Error('Select registered checkIds or provide taskDetails.outcomeCriteria with an artifact path and contains/sha256 expectation. Text-only acceptanceCriteria does not verify an outcome. Do not add an unrelated check merely to pass admission.');
    for (const id of input.checkIds) {
      const check = profile.checks.find(c => c.id === id);
      if (!check || (input.mode === 'read-only' && !check.readOnly)) throw new Error('Unavailable acceptance check: ' + id);
    }
    const requirementIds = [...new Set(input.requirementIds ?? [])].sort();
    if (requirementIds.some(id=>!id.trim()||id.length>128)) throw new Error('Invalid requirement ID');
    const workspace: WorkspaceSelection = {kind:input.workspace ?? 'in-place'};
    if (!profile.workspaces.includes(workspace.kind)) throw new Error(`Workspace kind ${workspace.kind} is not allowed for project ${profile.id}. Allowed: ${profile.workspaces.join(', ')}.${profile.workspaces.includes('worktree')?' Select workspace:worktree with an explicit local baseRef.':''}`);
    if (workspace.kind === 'worktree') {
      if (!input.baseRef) throw new Error('A worktree requires an explicit local baseRef');
      workspace.baseRef=input.baseRef;
      workspace.baseSha=await new WorkspaceManager(this.root).resolveBase(profile.root,input.baseRef);
    } else if (input.baseRef) throw new Error('baseRef only applies to a worktree');
    const context = await this.registry.context(profile);
    const taskContract=new TaskContractBuilder().build({...input,projectId:profile.id,details:input.taskDetails});
    const {contextPack,knowledge}=await this.contextPack(profile,context,taskContract);
    const capabilityPlan=new CapabilityPlanner().plan(profile,taskContract,contextPack);
    new CapabilityPlanner().assertReady(capabilityPlan,'execution');
    const realRoot=(await fs.realpath(profile.root)).replaceAll('\\','/').replace(/\/$/,'');
    const job = this.state.create({ ...input, projectId: profile.id, profileHash: this.registry.hash(profile),
      resourceKey:'root:'+(process.platform==='win32'?realRoot.toLowerCase():realRoot),isolatedWorkspace:workspace.kind==='worktree',executionKind:input.kind,initialStatus:input.workflow?'waiting_user':'ready' });
    const directory = this.artifactDir(job.id);
    await fs.mkdir(directory, { recursive: true });
    const manifest: Manifest = { version: 1, kind: input.kind, checkIds: input.checkIds, requirementIds, workspace, context, taskContract, routing, routingPolicy: routingPolicy.configuration, routingDecision, ...(input.workflow?{workflow:input.workflow}:{}) };
    // Exclusive creation preserves the original context on an idempotent retry.
    try { await atomicWriteNew(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.manifest(job.id);
      if(JSON.stringify(existing.workflow)!==JSON.stringify(input.workflow))throw new Error('Idempotency key has a different workflow binding');
      if(existing.taskContract ? existing.taskContract.hash!==taskContract.hash : input.taskDetails!==undefined) throw new Error('Idempotency key has a different execution contract: task details');
      if(existing.routing ? JSON.stringify(existing.routing)!==JSON.stringify(routing) : input.routing!==undefined)throw new Error('Idempotency key has a different routing contract');
      if (existing.routingPolicy && new RoutingPolicy({ configuration: existing.routingPolicy }).hash !== routingPolicy.hash) throw new Error('Idempotency key has a different routing policy');
      if (existing.kind !== input.kind || JSON.stringify(existing.checkIds) !== JSON.stringify(input.checkIds) || JSON.stringify(existing.requirementIds ?? []) !== JSON.stringify(requirementIds) || JSON.stringify(existing.workspace ?? {kind:'in-place'}) !== JSON.stringify(workspace)) throw new Error('Idempotency key has a different execution contract');
    }
    try {await atomicWriteNew(path.join(directory,'context-pack.json'),JSON.stringify(contextPack,null,2));}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    try {await atomicWriteNew(path.join(directory,'knowledge.json'),JSON.stringify(knowledge,null,2));}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    try {await atomicWriteNew(path.join(directory,'capability-plan.json'),JSON.stringify(capabilityPlan,null,2));}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    return job;
  }
  /** One governed dispatch; shares preparation, admission, worker, checks and lifecycle with queued work. */
  async delegate(raw: DelegationInput) {
    const { qualification, timeoutMs, background, ...task } = DelegationInputSchema.parse(raw);
    const job = await this.prepare({ ...task, kind: 'codex', routing: qualification }, { delegateOnly: true });
    const supervisor=background?await this.startPrepared(job.id,timeoutMs):null;
    const completed = background ? this.state.get(job.id) : await this.run(job.id, timeoutMs);
    const manifest = await this.manifest(job.id);
    const worker = completed.attempts > 0
      ? await readJson(path.join(this.artifactDir(job.id), `attempt-${completed.attempts}`, 'worker.json'), null) : null;
    return { job: completed, qualification: manifest.routing, routingDecision: worker?.receipt?.routingDecision ?? manifest.routingDecision,
      execution: worker ? { model: worker.receipt?.model ?? null, reasoningEffort: worker.receipt?.reasoningEffort ?? null,
        threadId: worker.threadId ?? null, turnId: worker.turnId ?? null, status: worker.status } : null,
      artifactDirectory: this.artifactDir(job.id), delivery:await this.delivery(job.id), supervisor,
      ...(background?{guidance:'Dispatch is asynchronous, not completion. Inspect task_status and queue_status using the returned job/supervisor IDs. Failed jobs require explicit retry; use start_queue for the same prepared job after retry. Never infer completion from a PID.'}:{}) };
  }
  /** Shared idempotent background dispatch; no model is needed to wait for completion. */
  async startPrepared(id:string,timeoutMs:number):Promise<SupervisorReceipt|null>{
    z.number().int().min(1000).max(1800000).parse(timeoutMs);
    return this.profiles.withLock(async()=>{
      const job=this.state.get(id),receiptPath=path.join(this.artifactDir(id),`dispatch-${job.attempts}.json`);
      const previous=await readJson(receiptPath,null) as SupervisorReceipt|null;
      if(previous)return previous;
      if(job.status!=='ready')return null;
      const receipt=await new SupervisorManager(this.root).start({maxJobs:1,totalTimeoutMs:timeoutMs,concurrency:1,jobIds:[id]});
      await atomicWriteJson(receiptPath,receipt);return receipt;
    });
  }
  private async assertActivated(projectId:string):Promise<void>{
    const restore=await readJson(path.join(this.root,'recovery/RESTORE.json'),null) as {activatedProjectIds?:string[]}|null;
    if(restore?.activatedProjectIds&&!restore.activatedProjectIds.includes(projectId))throw new Error('Project is not activated in this restored installation: '+projectId);
  }
  private async manifest(id: string): Promise<Manifest> {
    const data = await readJson(path.join(this.artifactDir(id), 'manifest.json'), null) as Manifest | null;
    if (!data || data.version !== 1 || !['checks', 'codex'].includes(data.kind) || !Array.isArray(data.checkIds) || (!data.checkIds.length&&!data.taskContract?.details.outcomeCriteria?.length) || !data.context) throw new Error('Job manifest is incomplete; prepare the task again before execution');
    return data;
  }
  async run(id:string,timeoutMs=300000,dispatch:DispatchOptions={}):Promise<Job> {
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2_147_483_647)throw new Error('Invalid task timeout');
    const controller=new AbortController(),abort=()=>controller.abort(dispatch.signal?.reason);
    dispatch.signal?.addEventListener('abort',abort,{once:true});
    if(dispatch.signal?.aborted)abort();
    const timer=setTimeout(()=>controller.abort(new ExecutionStop('deadline')),timeoutMs),options={...dispatch,signal:controller.signal};
    try{return await new ObjectiveCoordinator(this).run(id,timeoutMs,options,remaining=>this.runAttempt(id,remaining,options));}
    finally{clearTimeout(timer);dispatch.signal?.removeEventListener('abort',abort);}
  }
  async canContinueAfter(job:Job):Promise<boolean>{return new ObjectiveCoordinator(this).canContinueAfter(job);}
  async delivery(id:string) {
    const job=this.state.get(id),manifest=await this.manifest(id),contract=manifest.taskContract;
    const directory=this.artifactDir(id),attempt=path.join(directory,`attempt-${job.attempts}`);
    const outcome=job.attempts?await readJson(path.join(attempt,'outcome.json'),null):null;
    const blocker=await new ObjectiveCoordinator(this).blocker(job);
    const verified=job.status==='completed'&&Boolean(contract?.details.outcomeCriteria?.length)&&outcome?.status==='passed'&&outcome.taskContractHash===contract?.hash;
    const decisions=(contract?.details.openDecisions??[]).filter(d=>d.material&&d.status==='open');
    return {version:1,jobId:id,status:job.status,attempt:job.attempts,objective:job.objective,
      technicalCompleted:job.status==='completed',outcomeStatus:verified?'passed':contract?.details.outcomeCriteria?.length?'unverified':'not-recorded',
      humanAcceptance:'not-recorded',summary:job.result,criteria:outcome?.criteria??[],blocker:blocker?.blocker??null,
      approvedPlanRefs:contract?.details.intent?.approvedPlanRefs??[],decisions,
      nextAction:blocker?.blocker.nextAction??(decisions.length?'Review the prepared result and resolve the listed decision':verified?'Review the verified deliverable':job.status==='completed'?'Planned checks complete; objective coverage was not recorded':'Continue the authorized task'),
      evidence:[path.join(directory,'manifest.json'),...(job.attempts?[path.join(attempt,'checks.json'),...(outcome?[path.join(attempt,'outcome.json')]:[])]:[])]};
  }
  private async runAttempt(id: string, timeoutMs = 300000,dispatch:DispatchOptions = {}): Promise<Job> {
    const restore = await readJson(path.join(this.root, 'recovery/RESTORE.json'), null) as {requiresReconciliation?: boolean;dispatchEnabled?:boolean} | null;
    if (restore?.dispatchEnabled === false) throw new Error('Restored copy is for inspection. Rebind project paths and explicitly activate it before dispatch; original project paths are preserved.');
    if (restore?.requiresReconciliation) throw new Error('Restored installation: run reconcile before dispatch');
    let job = this.state.get(id);
    if (job.status === 'completed' || job.status === 'cancelled') return job;
    await this.assertActivated(job.projectId);
    if (job.status !== 'ready') throw new Error('An explicit retry is required for a waiting or failed task');
    const manifest = await this.manifest(id);
    if(manifest.taskContract?.details.workUnit)await new WorkUnitStore(this.root).assertTask(manifest.taskContract.details.workUnit,{
      project:job.projectId,objective:job.objective,mode:job.mode,kind:manifest.kind,checkIds:manifest.checkIds,
      taskDetails:manifest.taskContract.details,routing:manifest.routing,workspace:manifest.workspace?.kind,baseRef:manifest.workspace?.baseRef,requirementIds:manifest.requirementIds},manifest.routingPolicy);
    if(manifest.kind==='codex'&&!manifest.routing)throw new Error('Legacy model task has no explicit routing contract. Prepare a new task with the approved model policy; the old contract is preserved.');
    if(manifest.kind==='codex'&&!manifest.routingPolicy)throw new Error('Legacy model task has no pinned routing policy. Prepare a newly qualified task; history is preserved.');
    const profile = await this.profiles.withLock(async () => {
      if(dispatch.signal?.aborted)return null;
      if(manifest.workflow) {
        const plan=await new WorkflowStore(this.root).read(manifest.workflow.id);
        if(plan.state!=='prepared'||!plan.nodes.some(node=>node.jobId===id))throw new Error('Job does not belong to the current prepared workflow revision');
      }
      const current = await this.registry.resolve(job.projectId);
      this.registry.assertMode(current, job.mode);
      if (job.profileHash !== this.registry.hash(current)) throw new Error('Project profile changed; prepare a new task with the current contract');
      const policy=await this.execution.read();
      job = this.state.claim(id, process.pid, policy.maxWorkers,policy.maxModelWorkers);
      dispatch.onClaimed?.(job);
      return current;
    },5000);
    if(!profile)return this.state.get(id);
    const attempt = path.join(this.artifactDir(id), 'attempt-' + job.attempts);
    const evidence=new ExecutionEvidence(attempt);
    const controller = new AbortController();
    const abort=()=>controller.abort(dispatch.signal?.reason);
    dispatch.signal?.addEventListener('abort',abort,{once:true});
    if(dispatch.signal?.aborted)abort();
    const cancellationRequested = async () => {
      return ExecutionEvidence.cancellationRequested(this.artifactDir(id),job.attempts);
    };
    let polling = false;
    const poll = setInterval(() => {
      if (polling) return;
      polling = true;
      cancellationRequested().then(requested => { if (requested) controller.abort(); }).catch(() => {}).finally(() => { polling = false; });
    }, 250);
    try {
      if (await cancellationRequested()) controller.abort();
      if (controller.signal.aborted) return await this.stopAttempt(id,attempt,controller.signal);
      await evidence.effect('task-admission','allow','Profile identity, mode, activation and global ownership confirmed');
      let runtimeProfile = profile;
      if (manifest.workspace?.kind === 'worktree') {
        if (!manifest.workspace.baseSha) throw new Error('Missing pinned workspace base');
        const workspace = await new WorkspaceManager(this.root).prepare({projectId:profile.id,sourceRoot:profile.root,jobId:id,baseRef:manifest.workspace.baseSha});
        const rebind = (value:string):string => path.isAbsolute(value) && isSubPath(value,profile.root) ? path.join(workspace.root,path.relative(profile.root,value)) : value;
        runtimeProfile = {...profile,root:workspace.root,sourceRoots:profile.sourceRoots.map(rebind),sources:profile.sources.map(source=>({...source,path:rebind(source.path)})),checks:profile.checks.map(check=>({...check,executable:rebind(check.executable),args:check.args.map(rebind),environmentPaths:check.environmentPaths.map(rebind)}))};
        await atomicWriteJson(path.join(attempt,'workspace.json'),workspace);
        await evidence.effect('workspace-prepare','allow','Owned worktree prepared from the explicit pinned base');
      }
      const currentContext = await this.registry.context(runtimeProfile);
      await atomicWriteJson(path.join(attempt, 'before.json'), currentContext);
      const taskContract=manifest.taskContract??new TaskContractBuilder().build({projectId:job.projectId,objective:job.objective,mode:job.mode,kind:manifest.kind,checkIds:manifest.checkIds,requirementIds:manifest.requirementIds,details:{networkAccess:false}});
      const {contextPack,knowledge}=await this.contextPack(runtimeProfile,currentContext,taskContract);
      await atomicWriteJson(path.join(attempt,'knowledge.json'),knowledge);
      const capabilityPlan=new CapabilityPlanner().plan(runtimeProfile,taskContract,contextPack);
      await atomicWriteJson(path.join(attempt,'capability-plan.json'),capabilityPlan);
      const executionGate=capabilityPlan.gates.find(gate=>gate.stage==='execution')!;
      if(!executionGate.ready){await evidence.effect('execute','deny',executionGate.reasons.join(', '));await this.recordGateBlocker(attempt,job,taskContract,'execution',executionGate.reasons);return this.state.transition(id,'waiting_user',{error:'Execution capability gate: '+executionGate.reasons.join(', ')});}
      const preflightChecks=[];
      for(const checkId of new Set(capabilityPlan.capabilities.filter(c=>c.stage==='execution'&&c.kind==='deterministic'&&c.required&&c.checkId).map(c=>c.checkId!))){
        const check=await this.registry.check(runtimeProfile,checkId,job.mode,{signal:controller.signal});
        preflightChecks.push(check);await atomicWriteJson(path.join(attempt,'preflight-checks.json'),preflightChecks);
        if(check.cleanupFailed)return this.state.transition(id,'running',{error:'Unconfirmed cleanup: preflight process. Inspect evidence before releasing lock.'});
        if(controller.signal.aborted)return await this.stopAttempt(id,attempt,controller.signal);
        if(check.exitCode!==0){await this.recordBlocker(attempt,job,taskContract,'worker-blocked',{kind:'missing-information',cause:'environment',reason:'Contracted preflight check failed: '+checkId,evidence:[`attempt-${job.attempts}/preflight-checks.json`],nextAction:'Resolve the observed environment prerequisite within existing authority, then explicitly retry this contract.',recoveryActionId:null});return this.state.transition(id,'waiting_user',{error:'Environment preflight failed before model dispatch'});}
      }
      const previousAttempt=await evidence.previousAttempt(job.attempts);
      const recovery=job.attempts>1?await readJson(path.join(this.artifactDir(id),`attempt-${job.attempts-1}`,'recovery.json'),null):null;
      const dependencyHandoffs=await evidence.dependencies(this.state,id);
      await atomicWriteJson(path.join(attempt,'handoffs.json'),dependencyHandoffs);
      if(previousAttempt)await atomicWriteJson(path.join(attempt,'previous-attempt.json'),previousAttempt);
      await atomicWriteJson(path.join(attempt,'task-contract.json'),taskContract);
      await atomicWriteJson(path.join(attempt,'context-pack.json'),contextPack);
      if(manifest.routing)await atomicWriteJson(path.join(attempt,'routing.json'),new RoutingPolicy({ configuration: manifest.routingPolicy }).decide(manifest.routing));
      if (manifest.kind === 'codex') {
        const contextTransfer=await evidence.resumeContext(contextPack,job.attempts,job.threadId);
        await atomicWriteJson(path.join(attempt,'context-transfer.json'),contextTransfer.transfer);
        await evidence.effect('worker-dispatch','allow','One model turn under the saved routing contract and runtime admission');
        const result = await this.worker.run({cwd: runtimeProfile.root, mode: job.mode, objective: job.objective,
          networkAccess: taskContract.details.networkAccess ?? false,
          gitHubAuth: taskContract.details.gitHubAuth ?? false,
          context: JSON.stringify({taskContract,contextPack:contextTransfer.contextPack,capabilityPlan,previousAttempt,dependencyHandoffs,recovery}), ...(job.threadId ? {threadId: job.threadId} : {}), timeoutMs,
          structuredBlockers:Boolean(taskContract.details.resolution||taskContract.details.outcomeCriteria),
          ...(manifest.routing?{routing:manifest.routing}:{}),
          ...(manifest.routingPolicy?{routingPolicy:manifest.routingPolicy}:{}),
          signal: controller.signal, onProgress: update => { this.state.transition(id, 'running', update); }});
        await atomicWriteJson(path.join(attempt, 'worker.json'), result);
        await evidence.effect('worker-result',result.status==='blocked'?'deny':'allow','Runtime returned a terminal result',result.status);
        if (result.cleanupFailed) return this.state.transition(id, 'running', {error: 'Unconfirmed cleanup: worker process. Inspect attempt evidence and confirm shutdown before releasing this lock.'});
        if(controller.signal.aborted)return await this.stopAttempt(id,attempt,controller.signal);
        if(result.status==='blocked'&&result.blocker) {
          const blocker=DelegationContract.sanitizeBlocker(result.blocker);
          if(blocker)await this.recordBlocker(attempt,job,taskContract,'worker-blocked',blocker);
        }
        if (result.status !== 'completed') return this.state.transition(id,
          result.status === 'quota' ? 'waiting_quota' : result.status === 'blocked' ? 'waiting_user' : result.status === 'cancelled' ? 'cancelled' : 'failed',
          { error: result.summary });
        this.state.transition(id, 'running', { result: result.summary });
      }
      // A successful model turn is only input to validation, never an automatic PASS.
      const validationGate=capabilityPlan.gates.find(gate=>gate.stage==='validation')!;
      if(!validationGate.ready){await evidence.effect('validation','deny',validationGate.reasons.join(', '));await this.recordGateBlocker(attempt,job,taskContract,'validation',validationGate.reasons);return this.state.transition(id,'waiting_user',{error:'Validation capability gate: '+validationGate.reasons.join(', ')});}
      this.state.transition(id, 'validating');
      const validationContext=manifest.kind==='codex' ? await this.registry.context(runtimeProfile) : currentContext;
      if(manifest.kind==='codex')await atomicWriteJson(path.join(attempt,'validation-context.json'),validationContext);
      const checks:Awaited<ReturnType<ProjectRegistry['check']>>[] = [];
      if(manifest.checkIds.length===0)await atomicWriteJson(path.join(attempt,'checks.json'),checks);
      for (const checkId of manifest.checkIds) {
        if (controller.signal.aborted) return await this.stopAttempt(id,attempt,controller.signal);
        const logPrefix=path.join(attempt,'check-'+String(checks.length+1));
        await evidence.effect('check:'+checkId,'allow','Named check selected in the immutable task contract');
        checks.push(await this.registry.check(runtimeProfile, checkId, job.mode,{signal:controller.signal,outputFiles:{stdout:logPrefix+'.stdout.log',stderr:logPrefix+'.stderr.log'},execution:{jobId:id,attempt:job.attempts,baseSha:taskContract.details.comparisonBaseSha??manifest.workspace?.baseSha??null,targetSha:validationContext.git.head,artifactDir:logPrefix}}));
        await atomicWriteJson(path.join(attempt, 'checks.json'), checks);
        await evidence.effect('check-result:'+checkId,'allow','Check completed; acceptance is evaluated separately','exit='+String(checks.at(-1)!.exitCode)+'; cleanupConfirmed='+String(!checks.at(-1)!.cleanupFailed));
        if (checks.at(-1)!.cleanupFailed) return this.state.transition(id, 'validating', {error: 'Unconfirmed cleanup: acceptance check process. Inspect attempt evidence and confirm shutdown before releasing this lock.'});
        if (checks.at(-1)!.exitCode !== 0) break;
      }
      await atomicWriteJson(path.join(attempt, 'after.json'), await this.registry.context(runtimeProfile));
      if (controller.signal.aborted) return await this.stopAttempt(id,attempt,controller.signal);
      const passed = checks.length === manifest.checkIds.length && checks.every(check => check.exitCode === 0);
      if (!passed) {
        await this.recordValidationBlocker(attempt,job,taskContract,'check-failed','Acceptance check failed');
        return this.state.transition(id, 'failed', {error: 'Acceptance check failed; inspect attempt evidence'});
      }
      const outcome=await new OutcomeVerifier().verify({root:runtimeProfile.root,criteria:taskContract.details.outcomeCriteria??[],checks,taskContractHash:taskContract.hash});
      await atomicWriteJson(path.join(attempt,'outcome.json'),outcome);
      if(outcome.status==='failed') {
        await this.recordValidationBlocker(attempt,job,taskContract,'outcome-failed','Contracted outcome is not verified');
        return this.state.transition(id,'failed',{error:'Contracted outcome failed; inspect outcome.json'});
      }
      return this.state.transition(id, 'completed', {result: manifest.kind === 'checks'
        ? `Diagnostic checks completed: ${manifest.checkIds.join(', ')}. This does not certify a product build, runtime or feature.`
        : this.state.get(id).result});
    } catch (error) {
      await atomicWriteJson(path.join(attempt, 'failure.json'), {message: errorMessage(error), capturedAt: new Date().toISOString(), ...(error instanceof ProcessCleanupError ? {process:error.result} : {})});
      if (error instanceof ProcessCleanupError) return this.state.transition(id, this.state.get(id).status, {error: 'Unconfirmed cleanup: ' + errorMessage(error)});
      if (controller.signal.aborted) return await this.stopAttempt(id,attempt,controller.signal);
      return this.state.transition(id, 'failed', {error: errorMessage(error)});
    } finally {
      clearInterval(poll);dispatch.signal?.removeEventListener('abort',abort);
      await this.recordInsights(id,attempt,job.attempts);
      if (!job.projectId.startsWith('learning-')) {
        const { AutonomousLearning } = await import('./autonomous-learning.js');
        await new AutonomousLearning(this.root).onEvent(job.projectId);
      }
    }
  }
  private async stopAttempt(id:string,attempt:string,signal:AbortSignal):Promise<Job> {
    const stop=ExecutionStop.fromSignal(signal);
    await atomicWriteJson(path.join(attempt,'stop.json'),{version:1,kind:stop.kind,message:stop.message,capturedAt:new Date().toISOString()});
    return this.state.transition(id,stop.status,{error:stop.message});
  }
  private async recordBlocker(attempt:string,job:Job,contract:TaskContract,trigger:BlockerReceipt['trigger'],blocker:TaskBlocker) {
    await atomicWriteJson(path.join(attempt,'blocker.json'),{version:1,attempt:job.attempts,taskContractHash:contract.hash,trigger,blocker});
  }
  private async recordGateBlocker(attempt:string,job:Job,contract:TaskContract,stage:'execution'|'validation',reasons:string[]) {
    const decisions=contract.details.openDecisions.filter(d=>d.stage===stage&&d.material&&d.status==='open');
    await this.recordBlocker(attempt,job,contract,'worker-blocked',{kind:decisions.length?'owner-decision':'missing-information',
      reason:EvidenceSanitizer.text(reasons.join(', '),2000),evidence:[`attempt-${job.attempts}/capability-plan.json`],
      nextAction:decisions.length?EvidenceSanitizer.text(decisions.map(d=>d.question).join('; '),2000):'Resolve the identified capability using the existing authorization and evidence',recoveryActionId:null});
  }
  private async recordValidationBlocker(attempt:string,job:Job,contract:TaskContract,trigger:'check-failed'|'outcome-failed',reason:string) {
    const action=contract.details.resolution?.actions.find(a=>a.triggers.includes(trigger));
    await this.recordBlocker(attempt,job,contract,trigger,{kind:'recoverable',reason,
      cause:'validation',
      evidence:[`attempt-${job.attempts}/${trigger==='check-failed'?'checks.json':'outcome.json'}`],
      nextAction:action?.instruction??'Inspect failed criterion and prepare an authorized correction',recoveryActionId:action?.id??null});
  }
  private async recordInsights(jobId:string,attemptDirectory:string,attemptNumber:number):Promise<void> {
    let receipt;
    try {
      const job=this.state.get(jobId);
      if(!['completed','failed','cancelled','waiting_user','waiting_quota'].includes(job.status))return;
      const captured=await this.insights.captureJob(jobId);
      receipt={version:1,jobId,attempt:attemptNumber,recordedAt:new Date().toISOString(),status:captured.warnings.length?'attention':'processed',...captured};
    }catch(error){
      receipt={version:1,jobId,attempt:attemptNumber,recordedAt:new Date().toISOString(),status:'attention',evaluationIds:[],created:0,reused:0,
        warnings:[EvidenceSanitizer.text(errorMessage(error),1000)]};
    }
    try {await atomicWriteJson(path.join(attemptDirectory,'insights.json'),receipt);}
    catch(error){
      // Reporting must never replace the execution result, including when its evidence volume is unavailable.
      process.stderr.write(JSON.stringify({type:'insights-receipt-unavailable',jobId,attempt:attemptNumber,warnings:receipt.warnings,
        error:EvidenceSanitizer.text(errorMessage(error),1000)})+'\n');
    }
  }
  async cancel(id: string,expectedOwner?:{pid:number;attempt:number}): Promise<Job> {
    const job = this.state.get(id);
    if(expectedOwner && (job.ownerPid!==expectedOwner.pid||job.attempts!==expectedOwner.attempt))return job;
    if (job.status === 'completed' || job.status === 'cancelled') return job;
    if (job.status === 'running' || job.status === 'validating') {
      await atomicWriteJson(path.join(this.artifactDir(id), 'cancel.json'), {requestedAt: new Date().toISOString(), attempt: job.attempts});
      return job; // Owner interrupts and closes its worker before releasing the project lock.
    }
    return this.state.transition(id, 'cancelled');
  }
  retry(id: string, freshThread = false): Job {
    if(this.state.get(id).status==='cancelled')throw new Error('Cancelled jobs are terminal; inspect the preserved attempt and prepare a new task with a new idempotencyKey to continue. Historical cancellations are not rewritten.');
    return this.state.transition(id, 'ready', freshThread ? {threadId:null} : {});
  }
  async confirmProcessesStopped(id: string, evidence: string): Promise<Job> {
    const job = this.state.get(id);
    if (!['running','validating'].includes(job.status) || !job.error?.startsWith('Unconfirmed cleanup:')) throw new Error('Job has no unconfirmed cleanup to release');
    if (!evidence.trim() || evidence.length > 4000) throw new Error('Record the observed shutdown evidence (1–4000 characters)');
    await atomicWriteJson(path.join(this.artifactDir(id), 'attempt-' + job.attempts, 'shutdown-confirmation.json'), {capturedAt:new Date().toISOString(), evidence});
    return this.state.transition(id, 'waiting_user', {error:'Shutdown explicitly confirmed; inspect changes before deciding retry or cancellation.'});
  }
  async reconcile(): Promise<Job[]> {
    const markerPath = path.join(this.root, 'recovery/RESTORE.json');
    const marker = await readJson(markerPath, null) as Record<string, unknown> | null;
    const recovered = this.state.reconcile(pid => {
      if (marker?.requiresReconciliation) return false;
      try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
    });
    if (marker?.requiresReconciliation) await atomicWriteJson(markerPath, {...marker, requiresReconciliation: false, reconciledAt: new Date().toISOString(), reconciliationId: randomUUID()});
    return recovered;
  }
  close(): void { this.state.close(); }
}
