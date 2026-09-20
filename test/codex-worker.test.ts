import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {ExecutionStop} from '../src/execution-stop.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexWorker, type WorkerInput, type WorkerTransport } from '../src/codex-worker.js';
import { TaskEngine } from '../src/engine.js';
import { DEFAULT_ROUTING_CONFIGURATION, type TaskQualification } from '../src/routing.js';

const cwd = process.cwd();
const qualifiedRouting: TaskQualification = {
  taskClass: 'implementation', complexity: 'low', uncertainty: 'low', risk: 'low',
  bounded: true, independentlyVerifiable: true, contextCoupling: 'low', delegationBenefit: 'expected',
  rationale: 'Inspect the manifest as a bounded, independently verifiable task.',
};
const base: WorkerInput = {
  cwd, mode: 'read-only', networkAccess: false, objective: 'Inspect the project manifest.', context: '', timeoutMs: 2_000,
  routing: qualifiedRouting, routingPolicy: DEFAULT_ROUTING_CONFIGURATION,
};

class FakeTransport implements WorkerTransport {
  calls: { method: string; params: any }[] = [];
  listeners = new Set<(method: string, params: any) => void>();
  closed = false;
  auth = 'chatgpt';
  quota = 94;
  effectiveMode = 'readOnly';
  wrongNetwork = false;
  active = false;
  resumeId = 'thread-1';
  models=[{id:'gpt-6-astra',model:'gpt-6-astra',supportedReasoningEfforts:[{reasoningEffort:'ultra'}]},{id:'gpt-5.6-luna',model:'gpt-5.6-luna',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}]}];
  wrongModel=false;
  wrongEffort=false;
  finalMessage: string | undefined = JSON.stringify({ status: 'completed', summary: 'Manifest inspected.' });
  behavior: 'completed' | 'early' | 'blocked' | 'hang' | 'quota' | 'failed' | 'interrupted' = 'completed';
  async connect() {}
  async probeAccount() {
    return { type: this.auth, planType: 'pro', rateLimits: { rateLimits: { limitId: 'codex', primary: { usedPercent: this.quota } } } };
  }
  onNotification(listener: (method: string, params: any) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(method: string, params: any) { for (const listener of this.listeners) listener(method, params); }
  finish(status = 'completed', error: unknown = null) {
    this.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status, error,
      items: this.finalMessage === undefined ? [] : [{ type: 'agentMessage', text: this.finalMessage, phase: 'final_answer' }] } });
  }
  async request<T>(method: string, params?: any): Promise<T> {
    this.calls.push({ method, params });
    if(method==='config/read')return {config:{mcp_servers:{'external-service':{enabled:true}},plugins:{'external@fixture':{enabled:true}}}} as T;
    if(method==='model/list')return {data:this.models,nextCursor:null} as T;
    if (method === 'thread/start' || method === 'thread/resume') return {
      thread: { id: this.resumeId, cwd, status: { type: this.active ? 'active' : 'idle' } }, cwd,
      sandbox: { type: this.effectiveMode, networkAccess: this.wrongNetwork ? !params.config['sandbox_workspace_write.network_access'] : this.effectiveMode === 'readOnly' ? false : params.config['sandbox_workspace_write.network_access'], writableRoots: [cwd], excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      approvalPolicy: 'on-request', modelProvider: 'openai', model: this.wrongModel?'wrong-model':params.model??'user-configured-model', reasoningEffort:this.wrongEffort?'ultra':params.config?.model_reasoning_effort??null,
      instructionSources: [path.join(cwd, 'AGENTS.md'), 123, 'not-an-absolute-path'],
    } as T;
    if (method === 'turn/start') {
      this.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
      if (this.behavior === 'early') this.finish();
      else if (this.behavior === 'completed') setImmediate(() => this.finish());
      else if (this.behavior === 'quota') setImmediate(() => this.finish('failed', { codexErrorInfo: 'usageLimitExceeded', message: 'private@example.com' }));
      else if (this.behavior === 'failed') setImmediate(() => this.finish('failed', { codexErrorInfo: 'sandboxError' }));
      else if (this.behavior === 'interrupted') setImmediate(() => this.finish('interrupted'));
      else if (this.behavior === 'blocked') setImmediate(() => this.emit('client/serverRequestRejected', { method: 'item/commandExecution/requestApproval',source:'infra-client',threadId:'thread-1',turnId:'turn-1',itemId:'exec-1',commandSha256:'a'.repeat(64) }));
      return { turn: { id: 'turn-1', status: 'inProgress' } } as T;
    }
    if (method === 'turn/interrupt') { this.finish('interrupted'); return {} as T; }
    throw new Error(`Unexpected method ${method}`);
  }
  async close() { this.closed = true; }
}

function worker(transport: FakeTransport) { return new CodexWorker({ clientFactory: () => transport, interruptGraceMs: 30 }); }

test('structured blocker wire contract survives transport and rejects malformed recovery declarations',async()=>{
  const transport=new FakeTransport();
  const blocker={kind:'recoverable',reason:'Local artifact missing',evidence:['fixture result absent'],nextAction:'Regenerate fixture result',recoveryActionId:'repair'};
  transport.finalMessage=JSON.stringify({status:'blocked',summary:'Prepared recovery',blocker});
  const result=await worker(transport).run({...base,structuredBlockers:true});
  assert.deepEqual(result.blocker,blocker);assert.equal(result.status,'blocked');
  const schema=transport.calls.find(call=>call.method==='turn/start')!.params.outputSchema;
  assert.deepEqual(schema.required,['status','summary','blocker']);
  const malformed=new FakeTransport();malformed.finalMessage=JSON.stringify({status:'blocked',summary:'Invalid',blocker:{kind:'recoverable'}});
  assert.equal((await worker(malformed).run({...base,structuredBlockers:true})).status,'failed');
});

async function engineFixture(t: TestContext, transport: FakeTransport) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-routing-engine-'));
  await fs.mkdir(path.join(root, 'profiles'));
  await fs.writeFile(path.join(root, 'profiles', 'registry.json'), JSON.stringify({ version: 1, projects: [{
    id: 'routing-fixture', name: 'Routing fixture', aliases: [], root: process.cwd(), status: 'active',
    stack: ['node'], modes: ['read-only', 'workspace-write'], sourceRoots: [], sources: [],
    checks: [{ id: 'node-version', executable: process.execPath, args: ['--version'], readOnly: true }],
  }] }));
  const engine = new TaskEngine(root, worker(transport));
  t.after(async () => { engine.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { engine, root };
}

test('one job starts one turn and waits for confirmed terminal completion', async () => {
  const transport = new FakeTransport();
  const progress: unknown[] = [];
  const result = await worker(transport).run({ ...base, onProgress: update => progress.push(update) });
  assert.equal(result.status, 'completed');
  assert.equal(result.summary, 'Manifest inspected.');
  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.turnId, 'turn-1');
  assert.equal(transport.closed, true);
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(transport.calls.filter(call => call.method === 'turn/interrupt').length, 0);
  const turn = transport.calls.find(call => call.method === 'turn/start')!.params;
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turn.cwd, cwd);
  assert.equal(turn.approvalPolicy, 'on-request');
  if (process.platform === 'win32') {
    assert.match(turn.input[0].text,/start-docker/);
    assert.match(turn.input[0].text,/Keep the current project identity/);
  } else {
    assert.match(turn.input[0].text,/Docker recovery is Windows-only/);
    assert.match(turn.input[0].text,/Colima/);
  }
  assert.equal(turn.model, 'gpt-5.6-luna');
  assert.equal(turn.effort, 'medium');
  const thread = transport.calls.find(call => call.method === 'thread/start')!.params;
  assert.equal(thread.config['agents.enabled'], false);
  assert.equal(thread.config['features.multi_agent'], false);
  assert.deepEqual(turn.outputSchema.required, ['status', 'summary']);
  assert.deepEqual(turn.outputSchema.properties.status.enum, ['completed', 'blocked']);
  assert.equal(turn.outputSchema.additionalProperties, false);
  assert.deepEqual((result.receipt as any).instructionSources, [path.join(cwd, 'AGENTS.md')]);
  assert.ok(progress.length >= 2);
  assert.ok((result.receipt as any).trajectory.some((event:any)=>event.event==='turn/started'&&event.threadId==='thread-1'));
  assert.ok((result.receipt as any).trajectory.some((event:any)=>event.event==='turn/completed'&&event.turnId==='turn-1'));
  assert.equal(JSON.stringify((result.receipt as any).trajectory).includes('Manifest inspected.'),false);
});

test('learning file-only workers remove inherited integrations without relaxing sandbox or approval', async () => {
  const transport=new FakeTransport();
  const result=await new CodexWorker({clientFactory:()=>transport,localFilesOnly:true}).run(base);
  assert.equal(result.status,'completed');
  const options=transport.calls.find(call=>call.method==='thread/start')!.params;
  assert.deepEqual(options.config.mcp_servers,{'external-service':{enabled:false}});
  assert.deepEqual(options.config.plugins,{'external@fixture':{enabled:false}});
  assert.equal(options.config['features.apps'],false);
  assert.equal(options.config.web_search,'disabled');
  assert.equal(options.approvalPolicy,'on-request');assert.equal(options.sandbox,'read-only');
  assert.equal((result.receipt as any).toolScope.kind,'local-files');
  const prompt=transport.calls.find(call=>call.method==='turn/start')!.params.input[0].text;
  assert.match(prompt,/must not start, stop or recover Docker\/WSL/);
  assert.doesNotMatch(prompt,/when startup is authorized and needed, use recover_docker_start/);
});

test('captures completion delivered before turn/start response', async () => {
  const transport = new FakeTransport(); transport.behavior = 'early';
  assert.equal((await worker(transport).run(base)).status, 'completed');
});

test('routing validates actual model and effort before dispatch and records one selected model',async()=>{
 const transport=new FakeTransport();
 const result=await worker(transport).run(base);
 assert.equal(result.status,'completed');
 const turn=transport.calls.find(call=>call.method==='turn/start')!;
 assert.equal(turn.params.model,'gpt-5.6-luna');assert.equal(turn.params.effort,'medium');
 assert.equal((result.receipt as any).routingDecision.capabilityValidation,'matched');
 assert.equal(transport.calls.filter(call=>call.method==='turn/start').length,1);
});
test('unavailable coordinator effort, missing defensive specialist and effective mismatch do not generate',async()=>{
 for(const condition of ['effort','defensive','mismatch','effort-mismatch']) {
  const transport=new FakeTransport();
  if(condition==='effort')transport.models[0]!.supportedReasoningEfforts=[{reasoningEffort:'high'}];
  if(condition==='mismatch')transport.wrongModel=true;
  if(condition==='effort-mismatch')transport.wrongEffort=true;
  const routing = condition === 'defensive'
    ? { ...qualifiedRouting, taskClass: 'defensive-security' as const }
    : condition === 'effort'
      ? { ...qualifiedRouting, complexity: 'high' as const }
      : qualifiedRouting;
  const result=await worker(transport).run({...base,routing});
  assert.equal(result.status,'blocked');
  assert.equal(transport.calls.some(call=>call.method==='turn/start'),false);
  if(condition==='mismatch'||condition==='effort-mismatch')assert.equal(result.threadId,'thread-1');
 }
});

test('missing qualification or pinned policy is rejected before connecting', async () => {
  const transport = new FakeTransport();
  const unqualified: WorkerInput = { ...base, routing: undefined, routingPolicy: undefined };
  const result = await worker(transport).run(unqualified);
  assert.equal(result.status, 'blocked');
  assert.match(result.summary, /qualification and pinned routing policy/);
  assert.equal(transport.calls.length, 0);
  assert.equal(transport.closed, false);
});

test('TaskEngine.delegate routes moderate research through Sol high and records runtime execution', async t => {
  const transport = new FakeTransport();
  transport.models.push({ id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] });
  const { engine } = await engineFixture(t, transport);
  const delegated = await engine.delegate({
    project: 'routing-fixture', objective: 'Inspect the local runtime contract', idempotencyKey: 'delegate-research',
    mode: 'read-only', checkIds: ['node-version'], qualification: {
      taskClass: 'research', complexity: 'moderate', uncertainty: 'moderate', risk: 'moderate',
      bounded: true, independentlyVerifiable: true, contextCoupling: 'low', delegationBenefit: 'expected',
      rationale: 'Research is bounded and independently verifiable against the local fixture.',
    },
  });
  assert.equal(delegated.job.status, 'completed');
  assert.equal(delegated.execution?.status, 'completed');
  assert.equal(delegated.execution?.model, 'gpt-5.6-sol');
  assert.equal(delegated.execution?.reasoningEffort, 'high');
  assert.equal(delegated.routingDecision.evidenceLevel, 'runtime-validated');
  assert.equal(delegated.routingDecision.capabilityValidation, 'matched');
  assert.equal(transport.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 1);
  const turn = transport.calls.find(call => call.method === 'turn/start')!;
  assert.equal(turn.params.model, 'gpt-5.6-sol');
  assert.equal(turn.params.effort, 'high');
});

test('TaskEngine.delegate records waiting_user when the selected catalog capability is absent', async t => {
  const transport = new FakeTransport();
  const { engine } = await engineFixture(t, transport);
  const delegated = await engine.delegate({
    project: 'routing-fixture', objective: 'Inspect the unavailable analysis route', idempotencyKey: 'delegate-missing-catalog',
    mode: 'read-only', checkIds: ['node-version'], qualification: {
      taskClass: 'research', complexity: 'moderate', uncertainty: 'moderate', risk: 'moderate',
      bounded: true, independentlyVerifiable: true, contextCoupling: 'low', delegationBenefit: 'expected',
      rationale: 'The fixture intentionally omits the selected specialist capability.',
    },
  });
  assert.equal(delegated.job.status, 'waiting_user');
  assert.equal(delegated.execution?.status, 'blocked');
  assert.equal(transport.calls.filter(call => call.method === 'thread/start').length, 0);
  assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('exhausted quota and non-ChatGPT auth never start a thread or turn', async () => {
  for (const condition of ['quota', 'auth']) {
    const transport = new FakeTransport();
    if (condition === 'quota') transport.quota = 100; else transport.auth = 'apiKey';
    const result = await worker(transport).run(base);
    assert.equal(result.status, condition === 'quota' ? 'quota' : 'blocked');
    assert.equal(transport.calls.length, 0);
    assert.equal(transport.closed, true);
  }
});

test('effective sandbox mismatch blocks before model generation', async () => {
  const transport = new FakeTransport(); transport.effectiveMode = 'dangerFullAccess';
  const result = await worker(transport).run(base);
  assert.equal(result.status, 'blocked');
  assert.equal(transport.calls.some(call => call.method === 'turn/start'), false);
});

test('workspace-write requests exact writable root and no network access', async () => {
  const transport = new FakeTransport(); transport.effectiveMode = 'workspaceWrite';
  const result = await worker(transport).run({ ...base, mode: 'workspace-write' });
  assert.equal(result.status, 'completed');
  const turn = transport.calls.find(call => call.method === 'turn/start')!.params;
  assert.deepEqual(turn.sandboxPolicy.writableRoots, [cwd]);
  assert.equal(turn.sandboxPolicy.networkAccess, false);
  assert.equal(turn.sandboxPolicy.excludeTmpdirEnvVar, true);
});

test('delegated network authority reaches the runtime and preserves the exact workspace boundary', async t => {
  const transport = new FakeTransport(); transport.effectiveMode = 'workspaceWrite';
  const { engine, root } = await engineFixture(t, transport);
  const delegated = await engine.delegate({
    project: 'routing-fixture', objective: 'Read the authorized remote issue', idempotencyKey: 'network-task',
    mode: 'workspace-write', checkIds: ['node-version'], qualification: qualifiedRouting,
    taskDetails: { networkAccess: true, gitHubAuth: true, constraints: ['Read remote issue only; do not publish.'] },
  });
  assert.equal(delegated.job.status, 'completed');
  const thread = transport.calls.find(call => call.method === 'thread/start')!.params;
  const turn = transport.calls.find(call => call.method === 'turn/start')!.params;
  assert.equal(thread.config['sandbox_workspace_write.network_access'], true);
  assert.equal(turn.sandboxPolicy.networkAccess, true);
  assert.deepEqual(turn.sandboxPolicy.writableRoots, [cwd]);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'artifacts/jobs', delegated.job.id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.taskContract.details.networkAccess, true);
  assert.equal(manifest.taskContract.details.gitHubAuth, true);
  assert.equal(thread.config['shell_environment_policy.ignore_default_excludes'], true);
});

test('effective network mismatch blocks generation instead of silently changing authority', async () => {
  const transport = new FakeTransport(); transport.effectiveMode = 'workspaceWrite'; transport.wrongNetwork = true;
  const result = await worker(transport).run({ ...base, mode: 'workspace-write', networkAccess: true });
  assert.equal(result.status, 'blocked');
  assert.equal(transport.calls.some(call => call.method === 'turn/start'), false);
});

test('ordinary read-only delegation has network without granting filesystem write access', async t => {
  const transport = new FakeTransport();
  const { engine } = await engineFixture(t, transport);
  const delegated = await engine.delegate({
    project: 'routing-fixture', objective: 'Read an authorized remote source', idempotencyKey: 'read-only-network-default',
    mode: 'read-only', checkIds: ['node-version'], qualification: qualifiedRouting,
  });
  assert.equal(delegated.job.status, 'completed');
  const turn = transport.calls.find(call => call.method === 'turn/start')!.params;
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: true });
});

test('local-file learning cannot acquire network through a task override', async () => {
  const transport = new FakeTransport();
  const result = await new CodexWorker({ clientFactory: () => transport, localFilesOnly: true }).run({ ...base, mode: 'workspace-write', networkAccess: true });
  assert.equal(result.status, 'blocked');
  assert.equal(transport.calls.length, 0);
});

test('approval refusal becomes blocked after interrupt and transport cleanup', async () => {
  const transport = new FakeTransport(); transport.behavior = 'blocked';
  const result = await worker(transport).run(base);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blocker?.cause,'approval');
  assert.equal(result.blocker?.recoveryActionId,null);
  assert.equal(transport.calls.at(-1)?.method, 'turn/interrupt');
  assert.equal(transport.closed, true);
  assert.equal((result.receipt as any).interruptionConfirmed, true);
  assert.equal((result.receipt as any).blocker.method,'item/commandExecution/requestApproval');
  assert.equal((result.receipt as any).blocker.rawRequestStored,false);
  assert.equal((result.receipt as any).blocker.source,'infra-client');
  assert.equal((result.receipt as any).blocker.itemId,'exec-1');
  assert.equal((result.receipt as any).blocker.commandSha256,'a'.repeat(64));
  assert.match(result.summary,/not an automatic-review policy verdict/);
});

test('cancellation interrupts the owned turn and waits for cleanup', async () => {
  const transport = new FakeTransport(); transport.behavior = 'hang';
  const controller = new AbortController();
  const result = await worker(transport).run({ ...base, signal: controller.signal, onProgress: ({ turnId }) => { if (turnId) controller.abort(); } });
  assert.equal(result.status, 'cancelled');
  assert.equal(transport.calls.at(-1)?.method, 'turn/interrupt');
  assert.equal(transport.closed, true);
});

test('deadline interrupts instead of treating turn/start acknowledgement as completion', async () => {
  const transport = new FakeTransport(); transport.behavior = 'hang';
  const result = await worker(transport).run({ ...base, timeoutMs: 50 });
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /deadline/);
  assert.equal(transport.calls.at(-1)?.method, 'turn/interrupt');
  assert.equal(transport.closed, true);
});

test('an engine deadline keeps its cause through worker interruption and cleanup', async () => {
  const transport=new FakeTransport();transport.behavior='hang';
  const controller=new AbortController();
  const result=await worker(transport).run({...base,signal:controller.signal,onProgress:({turnId})=>{if(turnId)controller.abort(new ExecutionStop('deadline'));}});
  assert.equal(result.status,'failed');assert.match(result.summary,/deadline/);
  assert.doesNotMatch(result.summary,/cancelled by.*owner/);
  assert.equal(transport.calls.at(-1)?.method,'turn/interrupt');assert.equal(transport.closed,true);
});

test('unattributed runtime interruption fails without inventing an owner cancellation',async()=>{
  const transport=new FakeTransport();transport.behavior='interrupted';
  const result=await worker(transport).run(base);
  assert.equal(result.status,'failed');assert.match(result.summary,/interrupted/);
  const receipt=result.receipt as {terminalStatus:string;cleanupConfirmed:boolean};
  assert.equal(receipt.terminalStatus,'interrupted');
  assert.equal(receipt.cleanupConfirmed,true);
  assert.equal(transport.calls.filter(call=>call.method==='turn/start').length,1);
  assert.equal(transport.calls.some(call=>call.method==='turn/interrupt'),false);
});

test('terminal errors remain failed or quota without retrying or retaining raw errors', async () => {
  for (const behavior of ['quota', 'failed'] as const) {
    const transport = new FakeTransport(); transport.behavior = behavior;
    const result = await worker(transport).run(base);
    assert.equal(result.status, behavior);
    assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.ok(!JSON.stringify(result).includes('private@example.com'));
  }
});

test('resume targets the existing idle thread and refuses one already active', async () => {
  const idle = new FakeTransport();
  assert.equal((await worker(idle).run({ ...base, threadId: 'thread-1' })).status, 'completed');
  const resume = idle.calls.find(call => call.method === 'thread/resume');
  assert.equal(resume?.method, 'thread/resume');
  assert.equal(resume?.params.threadId, 'thread-1');
  const active = new FakeTransport(); active.active = true;
  assert.equal((await worker(active).run({ ...base, threadId: 'thread-1' })).status, 'blocked');
  assert.equal(active.calls.filter(call => call.method === 'thread/resume').length, 1);
});

test('cleanup failure is explicit so the engine can retain its ownership lock', async () => {
  const transport = new FakeTransport();
  transport.close = async () => { throw new Error('owned process still alive'); };
  const result = await worker(transport).run(base);
  assert.equal(result.status, 'failed');
  assert.equal(result.cleanupFailed, true);
  assert.equal((result.receipt as any).cleanupConfirmed, false);
});

test('model-reported blocking remains blocked and malformed or missing final output cannot complete a job', async () => {
  for (const finalMessage of [
    JSON.stringify({ status: 'blocked', summary: 'Required input is unavailable.' }),
    'I cannot finish this task.', undefined, JSON.stringify({ status: 'completed' }),
  ]) {
    const transport = new FakeTransport(); transport.finalMessage = finalMessage;
    const result = await worker(transport).run(base);
    assert.equal(result.status, finalMessage?.includes('"blocked"') ? 'blocked' : 'failed');
    assert.equal(transport.closed, true);
  }
});
