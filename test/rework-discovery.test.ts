import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { StateStore } from '../src/state.js';
import { ReworkDiscovery } from '../src/rework-discovery.js';

class ReworkFixture {
  readonly state: StateStore;
  readonly discovery: ReworkDiscovery;
  constructor(readonly root: string) { this.state = new StateStore(path.join(root, 'state/jobs.sqlite')); this.discovery = new ReworkDiscovery(root); }
  static async create(t: TestContext) {
    const parent = fileURLToPath(new URL('../../artifacts/test-fixtures/', import.meta.url)); await fs.mkdir(parent, { recursive: true });
    const fixture = new ReworkFixture(await fs.mkdtemp(path.join(parent, 'rework-')));
    t.after(async () => { fixture.state.close(); await fs.rm(fixture.root, { recursive: true, force: true }); }); return fixture;
  }
  job(projectId = 'infra-fixture') {
    return this.state.create({ idempotencyKey: crypto.randomUUID(), projectId, objective: 'Owned evidence fixture; command must never execute', mode: 'read-only', profileHash: 'fixture' });
  }
  async attempt(jobId: string, output: string, options: { language?: string; checkId?: string; terminal?: boolean; exitCode?: number; log?: string; outputPath?: string } = {}) {
    const old = this.state.get(jobId); if (old.status === 'failed') this.state.transition(jobId, 'ready');
    const job = this.state.claim(jobId, process.pid), checkId = options.checkId ?? 'compile';
    const directory = path.join(this.root, 'artifacts/jobs', jobId, `attempt-${job.attempts}`); await fs.mkdir(directory, { recursive: true });
    const contract = { version: 1, hash: 'fixture-contract', kind: 'checks', mode: 'read-only', checkIds: [checkId],
      ...(options.language ? { details: { performanceScope: { taskClass: 'fixture', language: options.language } } } : {}) };
    await fs.writeFile(path.join(directory, 'task-contract.json'), JSON.stringify(contract));
    const log = options.outputPath ?? path.join(directory, 'compile.stderr.log');
    if (options.log !== undefined) await fs.writeFile(log, options.log);
    await fs.writeFile(path.join(directory, 'checks.json'), JSON.stringify([{ checkId, exitCode: options.exitCode ?? 1, durationMs: 1, stdout: output, stderr: '',
      executable: 'never-run-fixture-command', args: ['fixture'], cwd: this.root,
      ...(options.log !== undefined || options.outputPath ? { outputFiles: { stdout: log, stderr: log } } : {}) }]));
    this.state.transition(jobId, 'validating');
    if (options.terminal !== false) this.state.transition(jobId, options.exitCode === 0 ? 'completed' : 'failed');
    return job.attempts;
  }
}

test('two distinct jobs yield an actionable cluster despite different locations and check contracts; retries alone do not', async t => {
  const fixture = await ReworkFixture.create(t), first = fixture.job();
  await fixture.attempt(first.id, "src/a.ts(12,8): error TS1005: ';' expected.");
  await fixture.attempt(first.id, "src/b.ts(92,3): error TS1005: ';' expected.");
  assert.equal((await fixture.discovery.scan()).clusters.length, 0);
  const second = fixture.job(); await fixture.attempt(second.id, `${path.join(fixture.root, 'different', 'c.ts')}(29,4): error TS1005: ';' expected.\nFound 11 errors.`, { checkId: 'build' });
  const before = fixture.state.list(), result = await fixture.discovery.scan();
  assert.equal(result.clusters.length, 1); assert.equal(result.clusters[0]!.distinctJobs, 2);
  assert.equal(result.clusters[0]!.occurrences.length, 3); assert.equal(result.clusters[0]!.language, 'typescript');
  assert.equal(result.clusters[0]!.problemCategory, 'syntax'); assert.match(result.clusters[0]!.summary, /TS1005/);
  assert.ok(result.clusters[0]!.occurrences.every(item => item.evidence.some(ref => ref.endsWith('/checks.json'))));
  assert.deepEqual(fixture.state.list(), before); await assert.rejects(fs.access(path.join(fixture.root, 'artifacts/rework')));
  await assert.rejects(fs.access(path.join(fixture.root, 'artifacts/evaluations')));
});

test('unrelated diagnostics, projects, ambiguous runtime languages and generic exit codes never share a cluster', async t => {
  const fixture = await ReworkFixture.create(t);
  for (const output of ['process_exit:1', 'process_exit:1', 'SyntaxError: invalid syntax', 'SyntaxError: invalid syntax',
    "error TS2322: Type 'string' is not assignable to type 'number'.", "error TS2322: Type 'boolean' is not assignable to type 'number'."]) {
    await fixture.attempt(fixture.job().id, output);
  }
  await fixture.attempt(fixture.job('other-project').id, "error TS2322: Type 'string' is not assignable to type 'number'.");
  const result = await fixture.discovery.scan(); assert.equal(result.clusters.length, 0); assert.equal(result.unclassifiedFailures, 4);
  assert.equal((await fixture.discovery.scan({ projectId: 'other-project' })).jobsInspected, 1);
  assert.equal((await fixture.discovery.scan({ limit: 1 })).truncated, true);
});

test('explicit Python and JavaScript runtime scopes stay separate and positions are normalized', async t => {
  const fixture = await ReworkFixture.create(t);
  for (const [language, output] of [['python', 'SyntaxError: invalid syntax (line 12)'], ['python', 'SyntaxError: invalid syntax (line 998)'],
    ['javascript', 'SyntaxError: invalid syntax'], ['javascript', 'SyntaxError: invalid syntax']] as const) {
    await fixture.attempt(fixture.job().id, output, { language });
  }
  const result = await fixture.discovery.scan(); assert.equal(result.clusters.length, 2);
  assert.deepEqual(result.clusters.map(item => item.language).sort(), ['javascript', 'python']);
  assert.ok(result.clusters.every(item => item.distinctJobs === 2));
});

test('bounded owned log evidence is observed but passed, active, external and redacted failures cannot establish recurrence', async t => {
  const fixture = await ReworkFixture.create(t), output = "error TS1005: ';' expected.";
  await fixture.attempt(fixture.job().id, '', { log: output }); await fixture.attempt(fixture.job().id, '', { log: output });
  await fixture.attempt(fixture.job().id, output, { exitCode: 0 });
  const outside = path.join(fixture.root, 'outside.log'); await fs.writeFile(outside, output);
  await fixture.attempt(fixture.job().id, '', { outputPath: outside });
  for (let index = 0; index < 2; index++) await fixture.attempt(fixture.job().id, 'error TS2307: Cannot find module sk-secretfixturecredential.');
  await fixture.attempt(fixture.job().id, output, { terminal: false });
  const result = await fixture.discovery.scan(); assert.equal(result.clusters.length, 1); assert.equal(result.clusters[0]!.distinctJobs, 2);
  assert.ok(result.clusters[0]!.occurrences.every(item => item.evidence.some(ref => ref.endsWith('.log'))));
  assert.ok(result.warnings.some(warning => warning.includes('outside its recorded attempt')));
  assert.doesNotMatch(JSON.stringify(result), /sk-secretfixturecredential/);
});

test('reconciliation is concurrent/idempotent and a new job extends the same cluster with an immutable snapshot', async t => {
  const fixture = await ReworkFixture.create(t), output = 'Traceback (most recent call last):\nSyntaxError: invalid syntax';
  for (let index = 0; index < 2; index++) await fixture.attempt(fixture.job().id, output);
  const [first, second] = await Promise.all([fixture.discovery.reconcile(), new ReworkDiscovery(fixture.root).reconcile()]);
  assert.equal(first.created + second.created, 1); assert.equal(first.reused + second.reused, 1);
  assert.equal(first.captures[0]!.artifactPath, second.captures[0]!.artifactPath);
  await fixture.attempt(fixture.job().id, output);
  const next = await fixture.discovery.reconcile(); assert.equal(next.created, 1);
  assert.equal(next.clusters[0]!.id, first.clusters[0]!.id); assert.notEqual(next.captures[0]!.artifactPath, first.captures[0]!.artifactPath);
  const old = JSON.parse(await fs.readFile(path.join(fixture.root, first.captures[0]!.artifactPath), 'utf8'));
  assert.equal(old.cluster.distinctJobs, 2); assert.equal((await fixture.discovery.reconcile()).reused, 1);
  await assert.rejects(fs.access(path.join(fixture.root, 'artifacts/learning')));
});

test('long output reads bounded log tails and explicitly reports omitted evidence', async t => {
  const fixture = await ReworkFixture.create(t), log = 'ordinary progress\n'.repeat(10000) + "error TS1005: ';' expected.\n";
  for (let index = 0; index < 2; index++) await fixture.attempt(fixture.job().id, '', { log });
  const result = await fixture.discovery.scan(); assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0]!.distinctJobs, 2); assert.equal(result.truncated, true);
  assert.ok(result.warnings.some(warning => warning.includes('bounded read budget')));
});
