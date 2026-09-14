import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { TaskEngine } from '../src/engine.js';
import { LearningBuilder, LearningBuildError, type LearningBuildInput } from '../src/learning-builder.js';
import { LearningActivationPolicySchema, LearningRuntimeStore } from '../src/learning-runtime.js';
import { RoutingPolicy } from '../src/routing.js';
import type { WorkerInput, WorkerResult } from '../src/codex-worker.js';
import { StateStore } from '../src/state.js';

const buildInput: LearningBuildInput = { caseId: 'fixture-learning-case', projectId: 'fixture-destination', kind: 'script',
  title: 'Reusable fixture', content: 'Create a small fixture transformer from observed repeated work.', evidence: ['fixture observation'], attempt: 1 };
// The throwing source proves schema checks treat executable content as data during build/review.
const generatedBundle = { version: 1, capabilityVersion: '1.0.0',
  files: [{ path: 'main.mjs', content: 'throw new Error("Generated code must remain unexecuted during synthesis and review");\n' },
    { path: 'test.mjs', content: 'import "./main.mjs";\n' }],
  entrypoints: [{ id: 'fixture', runtime: 'node', path: 'main.mjs' }], tests: [{ id: 'behavior', runtime: 'node', path: 'test.mjs' }] };

async function fixture(t: TestContext, behavior: 'pass' | 'quota' | 'mutate' | 'reject' = 'pass', outputBundle = generatedBundle) {
  const parent = fileURLToPath(new URL('../../artifacts/test-fixtures/', import.meta.url));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'learning-builder-'));
  t.after(async () => { if (!path.resolve(root).startsWith(path.resolve(parent) + path.sep)) throw new Error('Fixture cleanup escaped test root.'); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'profiles'));
  const policy = LearningActivationPolicySchema.parse({ version: 1, enabled: true, automaticActivation: true,
    authorizedBy: { name: 'Fixture owner', role: 'owner' }, source: 'fixture standing authorization', evidence: ['owned fixture authorization'], allowedProjectIds: [buildInput.projectId] });
  await fs.writeFile(path.join(root, 'profiles/learning-policy.json'), JSON.stringify(policy));
  const calls: WorkerInput[] = [];
  const worker = { run: async (input: WorkerInput): Promise<WorkerResult> => {
    calls.push(input);
    if (behavior === 'quota') return { status: 'quota', summary: 'Fixture account quota exhausted' };
    if (path.basename(input.cwd) === 'build') await fs.writeFile(path.join(input.cwd, 'bundle.json'), JSON.stringify(outputBundle));
    else {
      const request = JSON.parse(await fs.readFile(path.join(input.cwd, 'INPUT.json'), 'utf8')) as { bundleHash: string };
      await fs.writeFile(path.join(input.cwd, 'review.json'), JSON.stringify({ decision: behavior === 'reject' ? 'rejected' : 'approved',
        reason: 'Fixture review result; generated code has not been executed.', evidence: ['main.mjs and test.mjs fixture review'], bundleHash: request.bundleHash }));
      if (behavior === 'mutate') await fs.appendFile(path.join(input.cwd, 'bundle.json'), '\n');
    }
    return { status: 'completed', summary: 'Fixture worker wrote the requested artifact.' };
  } };
  const builder = new LearningBuilder(root, { engineFactory: ownedRoot => new TaskEngine(ownedRoot, worker),archiveAdapter:{async archive(){/* synthetic worker, no Desktop operation */}} });
  return { root, calls, builder, setBehavior: (next: typeof behavior) => { behavior = next; } };
}

test('builder uses two queue jobs, independent owned workspaces, schema-only checks and idempotent result', async t => {
  const f = await fixture(t), prepared: string[] = [];
  const result = await f.builder.build(buildInput, { onJobPrepared: job => { prepared.push(job.id); } });
  assert.equal(result.review.decision, 'approved');
  assert.equal(result.jobIds.length, 2); assert.deepEqual(result.jobIds, prepared);
  assert.equal(f.calls.length, 2); assert.notEqual(f.calls[0]!.cwd, f.calls[1]!.cwd);
  assert.ok(f.calls.every(call => call.cwd.startsWith(path.join(f.root, 'artifacts/learning/builds'))));
  assert.equal(new RoutingPolicy().decide(f.calls[0]!.routing!).candidate!.model, 'gpt-5.6-luna');
  assert.equal(new RoutingPolicy().decide(f.calls[1]!.routing!).candidate!.model, 'gpt-5.6-sol');
  const state = new StateStore(path.join(f.root, 'state/jobs.sqlite'));
  try { assert.ok(state.list().every(job => job.projectId.startsWith('learning-') && job.status === 'completed')); }
  finally { state.close(); }
  assert.deepEqual(await f.builder.build(buildInput), result);
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.builder.build({ ...buildInput, content: 'Different request under the same attempt.' }), /Immutable knowledge content/);
});

test('repair has its own bounded worker deadline while initial build and review retain their budget',async t=>{
  const f=await fixture(t),file=path.join(f.root,'profiles/learning-policy.json');
  const policy=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(LearningRuntimeStore.workerTimeout(policy,1),300000);
  assert.equal(LearningRuntimeStore.workerTimeout(policy,2),600000);
  assert.equal(LearningRuntimeStore.workerTimeout({...policy,workerTimeoutMs:400000},2),600000);
  await fs.writeFile(file,JSON.stringify({...policy,workerTimeoutMs:300000,repairWorkerTimeoutMs:600000}));
  await f.builder.build({...buildInput,attempt:2,feedback:'Review found a concrete mismatch.'});
  assert.deepEqual(f.calls.map(call=>call.timeoutMs),[600000,300000]);
  assert.equal(new RoutingPolicy().decide(f.calls[0]!.routing!).candidate!.model,'gpt-6-astra');
});

test('quota failure preserves waiting job identity and stops before review', async t => {
  const f = await fixture(t, 'quota');
  let pausedJob: string | undefined;
  await assert.rejects(f.builder.build(buildInput), error => {
    assert.ok(error instanceof LearningBuildError); assert.equal(error.status, 'waiting_quota');
    assert.equal(error.jobIds.length, 1); assert.equal(error.stage, 'build');
    pausedJob = error.jobIds[0];
    return true;
  });
  assert.equal(f.calls.length, 1);
  f.setBehavior('pass');
  const resumed = await f.builder.build(buildInput);
  assert.equal(resumed.jobIds[0], pausedJob); assert.equal(resumed.jobIds.length, 2);
  const state = new StateStore(path.join(f.root, 'state/jobs.sqlite'));
  try { assert.equal(state.get(pausedJob!).attempts, 2); }
  finally { state.close(); }
});

test('independent review cannot modify the bundle and still produce a usable result', async t => {
  const f = await fixture(t, 'mutate');
  await assert.rejects(f.builder.build(buildInput), error => {
    assert.ok(error instanceof LearningBuildError); assert.equal(error.status, 'failed'); assert.equal(error.stage, 'review');
    assert.equal(error.jobIds.length, 2); assert.match(error.message, /changed during independent review/);
    return true;
  });
});

test('rejected review remains rejected and a bounded retry is routed by the existing policy', async t => {
  const f = await fixture(t, 'reject');
  const result = await f.builder.build({ ...buildInput, attempt: 2, feedback: 'The earlier validation did not establish the claimed behavior.' });
  assert.equal(result.review.decision, 'rejected');
  assert.equal(new RoutingPolicy().decide(f.calls[0]!.routing!).candidate!.model, 'gpt-6-astra');
  await assert.rejects(f.builder.build({ ...buildInput, attempt: 3 }), error => error instanceof LearningBuildError && error.status === 'waiting_user');
  assert.equal(f.calls.length, 2);
});

test('Python-only input reaches both workers while schema checking remains host-owned Node', async t => {
  const pythonBundle = { ...generatedBundle, files: [
    { path: 'main.py', content: 'raise RuntimeError("Generated Python must not execute during synthesis or review")\n' },
    { path: 'test.py', content: 'import main\n' },
  ], entrypoints: [{ id: 'fixture', runtime: 'python', path: 'main.py' }], tests: [{ id: 'behavior', runtime: 'python', path: 'test.py' }] };
  const f = await fixture(t, 'pass', pythonBundle), input: LearningBuildInput = { ...buildInput, allowedRuntimes: ['python'] };
  const policyPath = path.join(f.root, 'profiles/learning-policy.json'), policy = JSON.parse(await fs.readFile(policyPath, 'utf8'));
  policy.allowedRuntimes = ['python']; await fs.writeFile(policyPath, JSON.stringify(policy));
  const result = await f.builder.build(input);
  assert.equal(f.calls.length, 2); assert.equal(result.review.decision, 'approved'); assert.equal(result.bundle.entrypoints[0]!.runtime, 'python');
  for (const call of f.calls) {
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(call.cwd, 'INPUT.json'), 'utf8')).allowedRuntimes, ['python']);
    assert.match(await fs.readFile(path.join(call.cwd, 'CONTRACT.md'), 'utf8'), /only these available, authorized runtimes for every entrypoint and test: python/);
  }
  assert.deepEqual(await f.builder.build(input), result); assert.equal(f.calls.length, 2);
});

test('a generated runtime outside the available input cannot reach independent review', async t => {
  const f = await fixture(t);
  await assert.rejects(f.builder.build({ ...buildInput, allowedRuntimes: ['python'] }), /outside the available, authorized build input/);
  assert.equal(f.calls.length, 1);
});
