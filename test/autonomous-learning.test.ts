import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { AutonomousLearning, LearningCaseSchema, type LearningCase } from '../src/autonomous-learning.js';
import { InteractionStore } from '../src/interactions.js';
import { KnowledgeLearningStore } from '../src/knowledge-learning.js';
import { LearningBundleInputSchema, LearningRuntimeStore, LearningActivationPolicySchema, type LearningSandboxExecutor } from '../src/learning-runtime.js';
import { ProcessRunner } from '../src/process.js';
import { StateStore } from '../src/state.js';
import { LearningBuildError, LearningBuildInputSchema, LearningBuildArtifacts, type LearningBuilder } from '../src/learning-builder.js';
import { KnowledgeFiles } from '../src/knowledge-store.js';
import { ReworkDiscovery, type ReworkCluster } from '../src/rework-discovery.js';

const owner = { author: { name: 'Test owner', role: 'owner' as const }, source: 'Owned fixture authorization', evidence: ['test fixture'] };
const agent = { author: { name: 'Test agent', role: 'model' as const }, source: 'Owned fixture execution', evidence: ['test fixture'] };
const bundle = LearningBundleInputSchema.parse({ version: 1, capabilityVersion: '1.0.0', files: [
  { path: 'main.mjs', content: "import fs from 'node:fs';fs.writeFileSync('output.txt',fs.readFileSync('input.txt','utf8').trim());\n" },
  { path: 'test.mjs', content: "import assert from 'node:assert/strict';assert.equal(' a '.trim(),'a');\n" },
], entrypoints: [{ id: 'trim', runtime: 'node', path: 'main.mjs' }], tests: [{ id: 'trim-test', runtime: 'node', path: 'test.mjs' }] });

// Fixed repository-owned fixtures only; this substituted adapter is not evidence of OS isolation.
const sandbox: LearningSandboxExecutor = { async run(r) {
  return { result: await new ProcessRunner().run(process.execPath, [r.entrypoint, ...r.args], r.workspace, r.timeoutMs),
    isolation: { kind: 'test-only substituted boundary', network: 'denied', filesystem: 'workspace-write', verified: true, evidence: ['fixed fixture adapter, not production isolation evidence'] } };
} };
async function fixture(t: TestContext) {
  const parent = fileURLToPath(new URL('../../artifacts/test-fixtures/', import.meta.url));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'autonomous-learning-'));
  t.after(async () => { assert.ok(root.startsWith(parent)); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'profiles'), { recursive: true });
  await fs.writeFile(path.join(root, 'profiles/registry.json'), JSON.stringify({ version: 1, projects: [] }));
  new StateStore(path.join(root, 'state/jobs.sqlite')).close();
  await fs.writeFile(path.join(root, 'profiles/learning-policy.json'), JSON.stringify(LearningActivationPolicySchema.parse({
    version: 1, enabled: true, automaticActivation: true, authorizedBy: owner.author, source: owner.source, evidence: owner.evidence,
    allowedProjectIds: ['fixture'], maxBuildAttempts: 2,
  })));
  const interaction = await new InteractionStore(root).begin({ idempotencyKey: 'fixture', projectId: 'fixture', title: 'Owned test', source: 'test' });
  const candidate = await new KnowledgeLearningStore(root).propose({ projectId: 'fixture', origin: { interactionId: interaction.id, revision: interaction.revision },
    title: 'Normalize test text', kind: 'script', content: 'Trim external whitespace in the owned text fixture.', ...agent });
  return { root, candidate };
}
function builder(decisions: ('approved'|'rejected')[]) {
  const calls: Parameters<LearningBuilder['build']>[0][] = [];
  return { calls, async build(input: Parameters<LearningBuilder['build']>[0]) {
    calls.push(input);
    return { version: 1 as const, artifactPath: 'artifacts/test-build.json', bundle, jobIds: [randomUUID(), randomUUID()],
      review: { decision: decisions[calls.length-1] ?? 'approved', reason: 'Fixture review result', evidence: ['fixed fixture review'], bundleHash: 'a'.repeat(64) } };
  } };
}

test('large evidence history reaches the builder with an immutable full-source reference', async t => {
  const f = await fixture(t), b = builder(['approved']), cycle = new AutonomousLearning(f.root, b, sandbox);
  await cycle.reconcile();
  const initial = (await cycle.list()).items[0]!;
  const refs = Array.from({length:75}, (_,i)=>`artifacts/evidence-${i}.json`);
  const sourced = await appendCase(f.root, initial, {evidence:refs});
  await cycle.drain({maxJobs:1,totalTimeoutMs:10000});
  assert.equal(b.calls.length,1);
  assert.equal(b.calls[0]!.evidence.length,50);
  assert.equal(b.calls[0]!.evidence[0],sourced.artifactPath);
  assert.deepEqual((await cycle.read(initial.id)).evidence.slice(0,75),refs);
  assert.equal((await cycle.read(initial.id)).status,'active');
});

test('pre-build exceptions park the case with an error and are not retried on the next drain', async t => {
  const f = await fixture(t), b = builder([]);
  let probes=0;
  const cycle = new AutonomousLearning(f.root,b,{...sandbox, async available(){probes++;throw new Error('Readiness fixture failed');}});
  await cycle.reconcile();
  await cycle.drain({maxJobs:1,totalTimeoutMs:10000});
  const item=(await cycle.list()).items[0]!;
  assert.equal(item.status,'attention'); assert.match(item.lastError!,/Readiness fixture failed/);
  assert.equal(item.ownerPid,null); assert.equal(item.retryAfter,null); assert.equal(item.attempts,0);
  const firstProbes=probes;
  assert.ok(firstProbes>0);
  await cycle.drain({maxJobs:1,totalTimeoutMs:10000});
  assert.equal(probes,firstProbes); assert.equal(b.calls.length,0);
});
async function appendCase(root: string, item: LearningCase, update: Partial<LearningCase>) {
  const revision = item.revision + 1;
  const next = LearningCaseSchema.parse({ ...item, ...update, revision, updatedAt: new Date().toISOString(),
    artifactPath: `artifacts/learning/cases/${item.id}/revision-${String(revision).padStart(6, '0')}.json` });
  await new KnowledgeFiles(root).writeJsonNew(next.artifactPath, next);
  return next;
}
async function stagedCase(t: TestContext, phase: 'packaged' | 'reviewed' | 'validation-passed' | 'active' | 'disabled') {
  const f = await fixture(t), cycle = new AutonomousLearning(f.root, builder([]), sandbox);
  await cycle.reconcile();
  await new KnowledgeLearningStore(f.root).review(f.candidate.id, { ...agent, decision: 'approved' });
  const runtime = new LearningRuntimeStore(f.root, sandbox), published = await runtime.publish(f.candidate.id, bundle), hash = published.manifest.hash;
  if (phase !== 'packaged') await runtime.review(hash, { ...agent, decision: 'approved' });
  if (['validation-passed', 'active', 'disabled'].includes(phase)) await runtime.validate(hash, agent);
  if (['active', 'disabled'].includes(phase)) await runtime.activate(hash, agent);
  if (phase === 'disabled') await runtime.disable(hash, owner);
  const item = await appendCase(f.root, (await cycle.list()).items[0]!, { status: 'validating', attempts: 2, ownerPid: null,
    candidateId: f.candidate.id, hash, reviewDecision: agent, validationAttempts: ['validation-passed', 'active', 'disabled'].includes(phase) ? 2 : 1 });
  return { ...f, item, runtime, hash };
}

test('explicit recovery resumes only a completed interrupted worker, preserving input, attempts and history', async t => {
  const f = await fixture(t), b = builder(['approved']), cycle = new AutonomousLearning(f.root, b, sandbox);
  await cycle.reconcile();
  const initial = (await cycle.list()).items[0]!;
  const input = LearningBuildInputSchema.parse({caseId:initial.id, projectId:'fixture', kind:initial.kind,
    title:initial.title, content:initial.content, evidence:initial.evidence, attempt:2});
  const state = new StateStore(path.join(f.root,'state/jobs.sqlite'));
  t.after(()=>state.close());
  const job = state.create({idempotencyKey:'interrupted-build', projectId:`learning-${LearningBuildArtifacts.key(input)}-build`,
    objective:'Fixed recovery fixture',mode:'workspace-write',profileHash:'fixture'});
  state.transition(job.id,'failed');
  const parked = await appendCase(f.root,initial,{status:'attention',attempts:2,buildInput:input,jobIds:[job.id],lastError:'deadline exceeded'});
  const decision = {...agent,action:'resume',expectedRevision:parked.revision};
  await assert.rejects(cycle.recover(initial.id,decision),/explicitly retry/);
  state.transition(job.id,'ready'); state.claim(job.id,process.pid); state.transition(job.id,'validating'); state.transition(job.id,'completed',{ownerPid:null});
  state.close();
  await assert.rejects(cycle.recover(initial.id,{...decision,expectedRevision:1}),/revision changed/);
  const resumed = await cycle.recover(initial.id,decision);
  assert.equal(resumed.status,'queued'); assert.equal(resumed.resumeAttempt,true); assert.equal(resumed.attempts,2);
  assert.deepEqual(resumed.buildInput,input); assert.equal(resumed.lastError,'deadline exceeded');
  assert.equal(resumed.recovery?.action,'resume');
  await assert.rejects(cycle.recover(initial.id,decision),/revision changed/);
  await cycle.drain({maxJobs:1,totalTimeoutMs:10000});
  assert.equal((await cycle.read(initial.id)).status,'active'); assert.equal(b.calls.length,1);
  assert.deepEqual(b.calls[0],input);
  assert.equal((await new KnowledgeFiles(f.root).read(parked.artifactPath,LearningCaseSchema)).status,'attention');
});

test('supersession requires a validated successor, preserves disabled state and never dispatches old cases', async t => {
  const f = await stagedCase(t,'disabled');
  const b = builder([]), cycle = new AutonomousLearning(f.root,b,sandbox);
  const successor = await appendCase(f.root,f.item,{status:'disabled'});
  const id='learning_'+'f'.repeat(32), artifactPath=`artifacts/learning/cases/${id}/revision-000001.json`;
  const pendingState=new StateStore(path.join(f.root,'state/jobs.sqlite'));
  const pending=pendingState.create({projectId:'learning-obsolete-build',objective:'obsolete fixture',idempotencyKey:'obsolete',mode:'read-only',profileHash:'a'.repeat(64)});
  pendingState.transition(pending.id,'waiting_user');pendingState.close();
  const old = LearningCaseSchema.parse({...successor,id,revision:1,artifactPath,status:'attention',hash:undefined,
    candidateId:undefined,attempts:2,jobIds:[pending.id],lastError:'old fixture startup failed'});
  await new KnowledgeFiles(f.root).writeJsonNew(artifactPath,old);
  const decision={...agent,action:'supersede',expectedRevision:1,successorId:successor.id};
  await assert.rejects(cycle.recover(id,{...decision,successorId:id}),/different successor/);
  const retired=await cycle.recover(id,decision);
  assert.equal(retired.status,'superseded'); assert.equal(retired.hash,undefined);
  assert.equal(retired.attempts,2); assert.equal(retired.lastError,old.lastError);
  assert.equal(retired.recovery?.successorId,successor.id);
  const reconciledState=new StateStore(path.join(f.root,'state/jobs.sqlite'));
  assert.equal(reconciledState.get(pending.id).status,'cancelled');const events=reconciledState.events(pending.id).length;
  assert.equal((await cycle.recover(id,{...decision,expectedRevision:retired.revision})).revision,retired.revision);
  assert.equal(reconciledState.events(pending.id).length,events);reconciledState.close();
  assert.equal((await f.runtime.read(f.hash)).state.status,'disabled');
  await cycle.reconcile(); await cycle.drain({maxJobs:1,totalTimeoutMs:10000});
  assert.equal(b.calls.length,0); assert.equal((await cycle.read(id)).status,'superseded');
});
test('material findings run through build, review, actual fixture tests, activation, invocation and hash disable', async t => {
  const f = await fixture(t), b = builder(['approved']), cycle = new AutonomousLearning(f.root, b, sandbox);
  assert.equal((await cycle.reconcile()).created, 1);
  assert.equal((await cycle.reconcile()).created, 0);
  await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 });
  const item = (await cycle.list()).items[0]!;
  assert.equal(item.status, 'active'); assert.equal(item.attempts, 1); assert.equal(b.calls.length, 1);
  const runtime = new LearningRuntimeStore(f.root, sandbox);
  const used = await runtime.run(item.hash!, { projectId: 'fixture', entrypoint: 'trim', inputFiles: [{ path: 'input.txt', content: ' hello ' }], outputPaths: ['output.txt'], decision: agent });
  assert.equal(used.status, 'passed'); assert.equal(used.outputs[0]!.content, 'hello');
  await runtime.disable(item.hash!, owner);
  assert.equal((await cycle.list()).items[0]!.status, 'disabled');
  await assert.rejects(runtime.run(item.hash!, { projectId: 'fixture', entrypoint: 'trim', decision: agent }), /not active/);
  await cycle.reconcile(); await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 });
  assert.equal(b.calls.length, 1);
});
test('rejected improvement is repaired once with feedback and never activated after exhausted review budget', async t => {
  const f = await fixture(t), b = builder(['rejected', 'rejected']), cycle = new AutonomousLearning(f.root, b, sandbox);
  await cycle.reconcile(); await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 });
  const item = (await cycle.list()).items[0]!;
  assert.equal(item.status, 'attention'); assert.equal(b.calls.length, 2);
  assert.match(b.calls[1]!.feedback!, /Review rejected/);
  assert.equal((await new LearningRuntimeStore(f.root).list()).items.length, 0);
  await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 }); assert.equal(b.calls.length, 2);
});
test('prepared build and independent review jobs persist their visible stage before the builder returns', async t => {
  const f = await fixture(t), observed: string[] = [];
  const b = { async build(input: Parameters<LearningBuilder['build']>[0], options: NonNullable<Parameters<LearningBuilder['build']>[1]> = {}) {
    const state = new StateStore(path.join(f.root, 'state/jobs.sqlite')), jobIds: string[] = [];
    try {
      for (const stage of ['build', 'review'] as const) {
        const job = state.create({ idempotencyKey: `fixture-${stage}`, projectId: `learning-${'a'.repeat(24)}-${stage}`,
          objective: 'Owned stage notification fixture; no worker executes', mode: 'workspace-write', profileHash: 'fixture' });
        jobIds.push(job.id);
        await options.onJobPrepared?.(job);
        const persisted = await new AutonomousLearning(f.root).read(input.caseId);
        observed.push(persisted.status);
        assert.deepEqual(persisted.jobIds, jobIds);
      }
    } finally { state.close(); }
    throw new LearningBuildError('Fixture stops after stage observations; no model or review result', 'waiting_user', jobIds, 'review');
  } };
  const cycle = new AutonomousLearning(f.root, b, sandbox);
  await cycle.reconcile(); await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 });
  assert.deepEqual(observed, ['building', 'reviewing']);
  assert.equal((await cycle.list()).items[0]!.status, 'attention');
});
test('successful reconciliation resolves a prior event error while preserving its warning receipt',async t=>{
  const f=await fixture(t),cycle=new AutonomousLearning(f.root,builder([]),sandbox);
  await cycle.reconcile();
  const item=(await cycle.list()).items[0]!;
  await appendCase(f.root,item,{status:'attention',attempts:2,retryAfter:null});
  const errorPath=path.join(f.root,'artifacts/learning/last-error.json');
  await fs.writeFile(errorPath,JSON.stringify({recordedAt:'2026-09-12T00:00:00Z',warning:'Temporary policy read error'}));
  assert.ok((await cycle.list()).warnings.some(w=>w.includes('Temporary policy')));
  await cycle.onEvent();
  assert.equal((await cycle.list()).warnings.length,0);
  const receipt=JSON.parse(await fs.readFile(errorPath,'utf8'));
  assert.equal(receipt.warning,'Temporary policy read error');assert.ok(receipt.resolvedAt);
});

test('missing policy never schedules discovery or models', async t => {
  const f = await fixture(t), b = builder(['approved']);
  await fs.rename(path.join(f.root, 'profiles/learning-policy.json'), path.join(f.root, 'profiles/learning-policy.disabled.json'));
  const cycle = new AutonomousLearning(f.root, b, sandbox);
  assert.equal((await cycle.onEvent()).enabled, false);
  assert.equal((await cycle.list()).items.length, 0); assert.equal(b.calls.length, 0);
});

test('a dead final attempt resumes its exact bundle phase without rebuilding or repeating passed tests', async t => {
  for (const phase of ['packaged', 'reviewed', 'validation-passed', 'active', 'disabled'] as const) await t.test(phase, async t => {
    const f = await stagedCase(t, phase), b = builder([]);
    let validations = 0, readiness = 0;
    const adapter = { async available() { readiness++; return { available: false }; }, async run(input: Parameters<LearningSandboxExecutor['run']>[0]) {
      validations++; return sandbox.run(input);
    } };
    const cycle = new AutonomousLearning(f.root, b, adapter);
    await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 });
    const item = await cycle.read(f.item.id);
    assert.equal(item.status, phase === 'disabled' ? 'disabled' : 'active', item.lastError ?? phase);
    assert.equal(item.hash, f.hash); assert.equal(item.attempts, 2); assert.equal(b.calls.length, 0);
    assert.equal(readiness, 0); assert.equal(validations, ['packaged', 'reviewed'].includes(phase) ? 1 : 0);
    await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 });
    assert.equal(b.calls.length, 0);
  });
});

test('resumed capability validation keeps review gates and has a separate bounded exception budget', async t => {
  const f = await stagedCase(t, 'reviewed'), b = builder([]);
  let validations = 0;
  const cycle = new AutonomousLearning(f.root, b, { async run() { validations++; throw new Error('Owned fixture executor temporarily unavailable'); } });
  await appendCase(f.root, f.item, { validationAttempts: 0 });
  await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 });
  let item = await cycle.read(f.item.id);
  assert.equal(item.status, 'attention'); assert.equal(item.attempts, 2); assert.equal(item.validationAttempts, 1); assert.ok(item.retryAfter);
  await appendCase(f.root, item, { retryAfter: new Date(0).toISOString() });
  await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 });
  item = await cycle.read(item.id);
  assert.equal(item.validationAttempts, 2); assert.equal(item.retryAfter, null); assert.equal(item.status, 'attention');
  await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 });
  assert.equal(validations, 2); assert.equal(b.calls.length, 0);
  assert.equal((await f.runtime.read(f.hash)).state.status, 'reviewed');
});

test('restart does not manufacture a packaged review or accept a revoked candidate review', async t => {
  for (const phase of ['packaged', 'validation-passed', 'active'] as const) await t.test(phase, async t => {
    const f = await stagedCase(t, phase), b = builder([]);
    if (phase === 'packaged') await appendCase(f.root, f.item, { reviewDecision: null });
    else await new KnowledgeLearningStore(f.root).review(f.candidate.id, { ...agent, decision: 'rejected' });
    const cycle = new AutonomousLearning(f.root, b, sandbox);
    await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 });
    assert.equal((await cycle.read(f.item.id)).status, 'attention'); assert.equal(b.calls.length, 0);
    assert.equal((await f.runtime.read(f.hash)).state.status, phase);
  });
});

test('Python-only availability reaches synthesis and quota resume preserves its original runtime input', async t => {
  const f = await fixture(t), policyPath = path.join(f.root, 'profiles/learning-policy.json');
  const policy = JSON.parse(await fs.readFile(policyPath, 'utf8'));
  policy.allowedRuntimes = ['python']; await fs.writeFile(policyPath, JSON.stringify(policy));
  const calls: Parameters<LearningBuilder['build']>[0][] = [], probes: string[] = [];
  let nodeAvailable = false;
  const b = { async build(input: Parameters<LearningBuilder['build']>[0]) {
    calls.push(input);
    throw new LearningBuildError('Fixture quota pause', 'waiting_quota', [], 'build');
  } };
  const adapter = { ...sandbox, async available(runtime: 'node' | 'python') {
    probes.push(runtime); return { available: runtime === 'python' || nodeAvailable };
  } };
  const cycle = new AutonomousLearning(f.root, b, adapter);
  await cycle.reconcile(); await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 });
  assert.deepEqual(probes, ['python']); assert.equal(calls.length, 1); assert.deepEqual(calls[0]!.allowedRuntimes, ['python']);
  const paused = (await cycle.list()).items[0]!;
  assert.equal(paused.attempts, 1); assert.equal(paused.resumeAttempt, true);
  policy.allowedRuntimes = ['node', 'python']; nodeAvailable = true; await fs.writeFile(policyPath, JSON.stringify(policy));
  await appendCase(f.root, paused, { retryAfter: new Date(0).toISOString() });
  await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 });
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]);
  assert.equal((await cycle.read(paused.id)).attempts, 1);
});

test('unavailable runtimes do not consume an attempt and interrupted final builds reuse the recorded input', async t => {
  const f = await fixture(t), b = builder(['rejected']);
  let available = false;
  const cycle = new AutonomousLearning(f.root, b, { ...sandbox, async available() { return { available }; } });
  await cycle.reconcile(); await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 });
  let item = (await cycle.list()).items[0]!;
  assert.equal(item.attempts, 0); assert.equal(b.calls.length, 0);
  const input = LearningBuildInputSchema.parse({ caseId: item.id, projectId: item.projectId, title: item.title, kind: item.kind,
    content: item.content, evidence: item.evidence, attempt: 2, allowedRuntimes: ['node'], feedback: 'Original bounded repair feedback' });
  await appendCase(f.root, item, { status: 'reviewing', attempts: 2, ownerPid: null, buildInput: input, retryAfter: null, resumeAttempt: false });
  available = true;
  await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 });
  item = await cycle.read(item.id);
  assert.equal(b.calls.length, 1); assert.deepEqual(b.calls[0], input);
  assert.equal(item.attempts, 2); assert.equal(item.status, 'attention');
});

test('large recurrent clusters preserve bounded factual samples, cross-job counts and the complete capture reference', async t => {
  const f = await fixture(t), jobIds = Array.from({ length: 50 }, () => randomUUID());
  const cluster: ReworkCluster = { id: 'rework_' + 'b'.repeat(32), projectId: 'fixture', signature: 'typescript:TS2322:string-to-number',
    language: 'typescript', problemCategory: 'compiler-diagnostic', summary: 'Repeated TS2322 in distinct owned jobs', distinctJobs: 50,
    recommendation: 'Investigate and test a reusable type-boundary check.', occurrences: jobIds.flatMap(jobId => Array.from({ length: 5 }, (_, index) => ({
      jobId, attempt: index + 1, checkId: 'typecheck', diagnostic: "TS2322: Type 'string' is not assignable to type 'number'.",
      evidence: [`artifacts/jobs/${jobId}/attempt-${index + 1}/checks.json`, `artifacts/jobs/${jobId}/attempt-${index + 1}/typecheck.stderr.txt`],
    }))) };
  assert.ok(JSON.stringify(cluster).length > 64000);
  const capturePath = `artifacts/rework/${cluster.id}/fixture.json`;
  await new KnowledgeFiles(f.root).writeJsonNew(capturePath, { cluster });
  t.mock.method(ReworkDiscovery.prototype, 'reconcile', async () => ({ clusters: [cluster], captures: [{ clusterId: cluster.id, artifactPath: capturePath, created: true }],
    created: 1, reused: 0, jobsInspected: 50, failuresInspected: 250, unclassifiedFailures: 0, warnings: [], truncated: false }));
  const cycle = new AutonomousLearning(f.root, builder([]), sandbox);
  await cycle.reconcile(); await cycle.reconcile();
  const items = (await cycle.list()).items.filter(item => item.kind === 'skill');
  assert.equal(items.length, 1);
  const item = items[0]!, content = JSON.parse(item.content) as { capturePath: string; totalOccurrences: number; distinctJobs: number; minimumDistinctJobs: number;
    selectedDistinctJobs: number; selectedOccurrences: number; truncated: boolean; occurrences: ReworkCluster['occurrences'] };
  LearningBuildInputSchema.parse({ caseId: item.id, projectId: item.projectId, title: item.title, kind: item.kind, content: item.content, evidence: item.evidence, attempt: 1 });
  assert.equal(content.capturePath, capturePath); assert.equal(content.totalOccurrences, 250); assert.equal(content.distinctJobs, 50);
  assert.equal(content.minimumDistinctJobs, 2); assert.equal(content.selectedDistinctJobs, 50); assert.equal(content.truncated, true);
  assert.equal(content.selectedOccurrences, content.occurrences.length); assert.ok(content.selectedOccurrences < 250);
  assert.ok(content.occurrences.every(selected => cluster.occurrences.some(original => JSON.stringify(original) === JSON.stringify(selected))));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, capturePath), 'utf8')).cluster.occurrences.length, 250);
});

test('owner-input and cancellation gates never auto-escalate; aborted drains report cancellation', async t => {
  for (const status of ['waiting_user', 'cancelled'] as const) await t.test(status, async t => {
    const f = await fixture(t), controller = new AbortController(); let calls = 0;
    const cycle = new AutonomousLearning(f.root, { async build() {
      calls++; if (status === 'cancelled') controller.abort();
      throw new LearningBuildError('Explicit fixture gate', status, [], 'build');
    } }, sandbox);
    await cycle.reconcile();
    const drained = await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000, signal: controller.signal });
    const item = (await cycle.list()).items[0]!;
    assert.equal(item.status, 'attention'); assert.equal(item.attempts, 1); assert.equal(item.retryAfter, null); assert.equal(item.resumeAttempt, false);
    assert.equal(drained.stopReason, status === 'cancelled' ? 'aborted' : 'max_jobs');
    await cycle.drain({ maxJobs: 1, totalTimeoutMs: 10000 }); assert.equal(calls, 1);
  });
});
