import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { CodexWorker, type WorkerInput, type WorkerTransport } from '../src/codex-worker.js';

const cwd = process.cwd();
const base: WorkerInput = { cwd, mode: 'read-only', objective: 'Inspect the project manifest.', context: '', timeoutMs: 2_000 };

class FakeTransport implements WorkerTransport {
  calls: { method: string; params: any }[] = [];
  listeners = new Set<(method: string, params: any) => void>();
  closed = false;
  auth = 'chatgpt';
  quota = 94;
  effectiveMode = 'readOnly';
  active = false;
  resumeId = 'thread-1';
  models=[{id:'gpt-6-astra',model:'gpt-6-astra',supportedReasoningEfforts:[{reasoningEffort:'ultra'}]},{id:'gpt-5.6-luna',model:'gpt-5.6-luna',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}];
  wrongModel=false;
  finalMessage: string | undefined = JSON.stringify({ status: 'completed', summary: 'Manifest inspected.' });
  behavior: 'completed' | 'early' | 'blocked' | 'hang' | 'quota' | 'failed' = 'completed';
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
      sandbox: { type: this.effectiveMode, networkAccess: false, writableRoots: [cwd], excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      approvalPolicy: 'on-request', modelProvider: 'openai', model: this.wrongModel?'wrong-model':params.model??'user-configured-model', reasoningEffort:params.config?.model_reasoning_effort??null,
      instructionSources: [path.join(cwd, 'AGENTS.md'), 123, 'not-an-absolute-path'],
    } as T;
    if (method === 'turn/start') {
      this.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
      if (this.behavior === 'early') this.finish();
      else if (this.behavior === 'completed') setImmediate(() => this.finish());
      else if (this.behavior === 'quota') setImmediate(() => this.finish('failed', { codexErrorInfo: 'usageLimitExceeded', message: 'private@example.com' }));
      else if (this.behavior === 'failed') setImmediate(() => this.finish('failed', { codexErrorInfo: 'sandboxError' }));
      else if (this.behavior === 'blocked') setImmediate(() => this.emit('client/serverRequestRejected', { method: 'item/commandExecution/requestApproval' }));
      return { turn: { id: 'turn-1', status: 'inProgress' } } as T;
    }
    if (method === 'turn/interrupt') { this.finish('interrupted'); return {} as T; }
    throw new Error(`Unexpected method ${method}`);
  }
  async close() { this.closed = true; }
}

function worker(transport: FakeTransport) { return new CodexWorker({ clientFactory: () => transport, interruptGraceMs: 30 }); }

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
  assert.equal(turn.model, undefined);
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
});

test('captures completion delivered before turn/start response', async () => {
  const transport = new FakeTransport(); transport.behavior = 'early';
  assert.equal((await worker(transport).run(base)).status, 'completed');
});

test('routing validates actual model and effort before dispatch and records one selected model',async()=>{
 const transport=new FakeTransport();
 const result=await worker(transport).run({...base,routing:{taskClass:'implementation',bounded:true,independentlyVerifiable:true,contextCoupling:'low',complexity:'low',uncertainty:'low',risk:'low',delegationBenefit:'expected'}});
 assert.equal(result.status,'completed');
 const turn=transport.calls.find(call=>call.method==='turn/start')!;
 assert.equal(turn.params.model,'gpt-5.6-luna');assert.equal(turn.params.effort,'medium');
 assert.equal((result.receipt as any).routingDecision.capabilityValidation,'matched');
 assert.equal(transport.calls.filter(call=>call.method==='turn/start').length,1);
});
test('unavailable coordinator effort, missing defensive specialist and effective mismatch do not generate',async()=>{
 for(const condition of ['effort','defensive','mismatch']) {
  const transport=new FakeTransport();
  if(condition==='effort')transport.models[0]!.supportedReasoningEfforts=[{reasoningEffort:'high'}];
  if(condition==='mismatch')transport.wrongModel=true;
  const result=await worker(transport).run({...base,routing:{taskClass:condition==='defensive'?'defensive-security':'implementation'}});
  assert.equal(result.status,'blocked');
  assert.equal(transport.calls.some(call=>call.method==='turn/start'),false);
 }
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

test('approval refusal becomes blocked after interrupt and transport cleanup', async () => {
  const transport = new FakeTransport(); transport.behavior = 'blocked';
  const result = await worker(transport).run(base);
  assert.equal(result.status, 'blocked');
  assert.equal(transport.calls.at(-1)?.method, 'turn/interrupt');
  assert.equal(transport.closed, true);
  assert.equal((result.receipt as any).interruptionConfirmed, true);
  assert.equal((result.receipt as any).blocker.method,'item/commandExecution/requestApproval');
  assert.equal((result.receipt as any).blocker.rawRequestStored,false);
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
  assert.equal(idle.calls[0]?.method, 'thread/resume');
  assert.equal(idle.calls[0]?.params.threadId, 'thread-1');
  const active = new FakeTransport(); active.active = true;
  assert.equal((await worker(active).run({ ...base, threadId: 'thread-1' })).status, 'blocked');
  assert.equal(active.calls.length, 1);
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
