import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RecoveryManager, RESTORE_METADATA_PATH, SNAPSHOT_MANIFEST, type SnapshotManifest } from '../src/recovery.js';
import { StateStore } from '../src/state.js';
import { ProjectRegistry } from '../src/registry.js';
import { KnowledgeLearningStore } from '../src/knowledge-learning.js';
import { InteractionStore } from '../src/interactions.js';
import { LearningActivationPolicySchema, LearningRuntimeStore, type LearningSandboxExecutor } from '../src/learning-runtime.js';
import { ProcessRunner } from '../src/process.js';
import { TaskEngine } from '../src/engine.js';

function fixture(t: TestContext): { root: string; source: string; manager: RecoveryManager } {
  const root = mkdtempSync(join(tmpdir(), 'codexinfra-recovery-'));
  const source = join(root, 'source');
  mkdirSync(source);
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'codexinfra-recovery-'));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, source, manager: new RecoveryManager(source) };
}

function put(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

test('snapshot captures committed WAL, restores source/evidence and requires reconciliation', (t) => {
  const { root, source, manager } = fixture(t);
  put(source, 'src/example.ts', 'export const fixture = true;\n');
  put(source, 'package.json', '{"name":"fixture"}\n');
  put(source, 'profiles/example.json', '{"id":"fixture"}\n');
  put(source, 'artifacts/job/check.json', '{"result":"passed"}\n');
  put(source, 'ui/package-lock.json', '{"lockfileVersion":3}\n');
  put(source, 'ui/src/Home.tsx', 'export default function Home() {}\n');
  put(source, 'imports/design.zip', 'original-reference-fixture');
  put(source, 'ui/node_modules/react/index.js', 'excluded-dependency');
  put(source, 'ui/dist/app.js', 'excluded-build');
  const store = new StateStore(join(source, 'state/jobs.sqlite'));
  const job = store.create({ idempotencyKey: 'fixture', projectId: 'fixture', objective: 'Read fixture', mode: 'read-only', profileHash: 'v1' });
  store.claim(job.id, process.pid);
  let snapshot: SnapshotManifest;
  const snapshotPath = join(source, 'recovery/backups/first');
  try {
    // The source connection remains open and its WAL may contain the latest job.
    snapshot = manager.snapshot(snapshotPath);
    assert.equal(store.get(job.id).status, 'running');
  } finally { store.close(); }
  assert.equal(snapshot.database, 'state/jobs.sqlite');
  assert.deepEqual(readdirSync(join(snapshotPath, 'state')), ['jobs.sqlite']);
  const target = join(root, 'restored');
  const result = manager.restore(snapshotPath, target);
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.automaticReplay, false);
  const metadata = JSON.parse(readFileSync(join(target, RESTORE_METADATA_PATH), 'utf8'));
  assert.equal(metadata.requiresReconciliation, true);
  for (const file of snapshot.files) {
    assert.equal(createHash('sha256').update(readFileSync(join(target, file.path))).digest('hex'), file.sha256);
  }
  const restored = new StateStore(join(target, 'state/jobs.sqlite'));
  try {
    assert.equal(restored.get(job.id).id, job.id);
    assert.equal(restored.get(job.id).attempts, 1);
    assert.equal(restored.get(job.id).status, 'running');
    assert.equal(restored.reconcile(() => false)[0]?.status, 'waiting_user');
  } finally { restored.close(); }
  assert.equal(readFileSync(join(target, 'artifacts/job/check.json'), 'utf8'), '{"result":"passed"}\n');
  assert.equal(existsSync(join(target, 'node_modules')), false);
  assert.equal(readFileSync(join(target, 'imports/design.zip'), 'utf8'), 'original-reference-fixture');
  assert.equal(existsSync(join(target, 'ui/src/Home.tsx')), true);
  assert.equal(existsSync(join(target, 'ui/package-lock.json')), true);
  assert.equal(existsSync(join(target, 'ui/node_modules')), false);
  assert.equal(existsSync(join(target, 'ui/dist')), false);
});

test('snapshot excludes dependencies, credentials, logs and older backups', (t) => {
  const { source, manager } = fixture(t);
  for (const path of ['src/entry.ts', 'plugins/example/.codex-plugin/plugin.json', 'docs/usage.md', 'schemas/project.json']) put(source, path, '{}');
  for (const path of ['.env', '.codex/auth.json', 'node_modules/lib.js', 'dist/index.js', 'src/.env.local', 'src/credentials.json', 'artifacts/.env', 'artifacts/logs/raw.log', 'artifacts/key.pem', 'plugins/example/.codex/auth.json']) put(source, path, 'excluded-fixture');
  const first = manager.snapshot(join(source, 'recovery/backups/one'));
  const second = manager.snapshot(join(source, 'recovery/backups/two'));
  assert.deepEqual(first.files.map((file) => file.path), second.files.map((file) => file.path));
  assert.deepEqual(new Set(first.files.map((file) => file.path)), new Set(['src/entry.ts', 'plugins/example/.codex-plugin/plugin.json', 'docs/usage.md', 'schemas/project.json']));
  assert.equal(first.database, null);
  assert.throws(() => manager.snapshot(join(source, 'src/backup')), /copied source directory/);
});

test('snapshot and restore preserve learned capability hashes, files, states and receipts without enabling dispatch', async t => {
  const { root, source, manager } = fixture(t);
  const owner = { name: 'Recovery fixture owner', role: 'owner' as const };
  const decision = { author: { name: 'Recovery fixture agent', role: 'model' as const }, source: 'Owned recovery fixture', evidence: ['fixed fixture behavior'] };
  put(source, 'profiles/registry.json', JSON.stringify({ version: 1, projects: [] }));
  put(source, 'profiles/learning-policy.json', JSON.stringify(LearningActivationPolicySchema.parse({ version: 1, enabled: true, automaticActivation: true,
    authorizedBy: owner, source: 'Owned fixture standing policy', evidence: ['fixture policy'], allowedProjectIds: ['fixture'] })));
  const interaction = await new InteractionStore(source).begin({ idempotencyKey: 'recovery-learning-fixture', projectId: 'fixture', title: 'Owned recovery fixture', source: 'test' });
  const learning = new KnowledgeLearningStore(source);
  const candidate = await learning.propose({ projectId: 'fixture', origin: { interactionId: interaction.id, revision: interaction.revision },
    title: 'Preserve reusable text normalization', kind: 'script', content: 'Trim and uppercase the owned text fixture.', ...decision });
  await learning.review(candidate.id, { ...decision, decision: 'approved' });
  let fixtureExecutions = 0;
  // Only these fixed repository-owned files execute; this fixture substitutes the OS boundary.
  const adapter: LearningSandboxExecutor = { async run(request) {
    fixtureExecutions++;
    return { result: await new ProcessRunner().run(process.execPath, [request.entrypoint, ...request.args], request.workspace, request.timeoutMs),
      isolation: { kind: 'test-only substituted boundary', network: 'denied', filesystem: 'workspace-write', verified: true,
        evidence: ['fixed repository fixture; no production sandbox isolation claim'] } };
  } };
  const runtime = new LearningRuntimeStore(source, adapter);
  const published = await runtime.publish(candidate.id, { version: 1, capabilityVersion: '1.0.0', files: [
    { path: 'normalize.mjs', content: 'export const normalize = value => value.trim().toUpperCase();\n' },
    { path: 'main.mjs', content: "import { normalize } from './normalize.mjs'; console.log(normalize(process.argv[2]));\n" },
    { path: 'test.mjs', content: "import assert from 'node:assert/strict';import { normalize } from './normalize.mjs';assert.equal(normalize(' abc '),'ABC');\n" },
  ], entrypoints: [{ id: 'normalize', runtime: 'node', path: 'main.mjs' }], tests: [{ id: 'normalize', runtime: 'node', path: 'test.mjs' }] });
  const hash = published.manifest.hash;
  await runtime.review(hash, { ...decision, decision: 'approved' });
  const validation = await runtime.validate(hash, decision);
  assert.equal(validation.status, 'passed');
  const active = await runtime.activate(hash, decision);
  const run = await runtime.run(hash, { projectId: 'fixture', entrypoint: 'normalize', args: [' abc '], decision });
  assert.equal(run.result.stdout, 'ABC\n'); assert.equal(run.status, 'passed'); assert.equal(fixtureExecutions, 2);
  const store = new StateStore(join(source, 'state/jobs.sqlite'));
  const pending = store.create({ idempotencyKey: 'must-not-replay', projectId: 'fixture', objective: 'Remain paused after restore', mode: 'read-only', profileHash: 'v1' });
  store.close();
  const excluded = ['runtime/node/cache.txt', 'artifacts/runtime/host.txt', 'artifacts/other/runtime/cache.txt',
    'artifacts/learning/runtime/secrets/token.txt', 'artifacts/learning/runtime/credentials.json',
    'artifacts/learning/runtime/node_modules/package/index.js', 'artifacts/learning/runtime/logs/raw.log'];
  for (const file of excluded) put(source, file, 'excluded fixture sentinel');
  const snapshotPath = join(source, 'recovery/backups/learned-runtime'), manifest = manager.snapshot(snapshotPath);
  const learnedFiles = manifest.files.filter(file => file.path.startsWith('artifacts/learning/runtime/'));
  for (const required of [published.manifest.artifactPath, active.state.artifactPath, validation.artifactPath, run.artifactPath,
    ...published.manifest.files.map(file => `artifacts/learning/runtime/bundles/${hash}/files/${file.path}`)]) {
    assert.ok(learnedFiles.some(file => file.path === required), `Snapshot lost learned artifact ${required}`);
  }
  assert.ok(excluded.every(file => !manifest.files.some(item => item.path === file)));
  const target = join(root, 'restored-learning'), restored = manager.restore(snapshotPath, target);
  assert.equal(restored.dispatchEnabled, false); assert.equal(restored.automaticReplay, false); assert.equal(restored.requiresReconciliation, true);
  for (const file of learnedFiles) {
    const copied = readFileSync(join(target, file.path));
    assert.deepEqual(copied, readFileSync(join(source, file.path)));
    assert.equal(createHash('sha256').update(copied).digest('hex'), file.sha256);
  }
  assert.ok(excluded.every(file => !existsSync(join(target, file))));
  const restoredRuntime = new LearningRuntimeStore(target);
  assert.deepEqual(await restoredRuntime.read(hash), await runtime.read(hash));
  assert.equal((await restoredRuntime.read(hash)).state.status, 'active', 'Restore preserves evidence; it does not rewrite capability history');
  assert.deepEqual(JSON.parse(readFileSync(join(target, validation.artifactPath), 'utf8')), validation);
  assert.deepEqual(JSON.parse(readFileSync(join(target, run.artifactPath), 'utf8')), run);
  assert.deepEqual((await manager.observations()).warnings, []);
  let dispatched = 0;
  const engine = new TaskEngine(target, { async run() { dispatched++; return { status: 'completed', summary: 'Unexpected fixture dispatch' }; } });
  try {
    await assert.rejects(engine.run(pending.id), /Restored copy is for inspection/);
    assert.equal(engine.state.get(pending.id).attempts, 0);
  } finally { engine.close(); }
  assert.equal(dispatched, 0); assert.equal(fixtureExecutions, 2);
  assert.equal(JSON.parse(readFileSync(join(target, RESTORE_METADATA_PATH), 'utf8')).dispatchEnabled, false);
});

test('recovery observations and restore accept the G-IDEIA templates included in R9 snapshots', async t => {
  const { root, source, manager } = fixture(t);
  const templates = ['contract', 'evidence', 'index', 'prd', 'prevc', 'spec'];
  for (const template of templates) put(source, `templates/g-ideia/${template}.md`, `# Fixture ${template}\n`);
  put(source, 'README.md', 'Infrastructure fixture');
  const snapshotPath = join(source, 'recovery/backups/r9-g-ideia');
  const manifest = manager.snapshot(snapshotPath);
  const manifestBytes = readFileSync(join(snapshotPath, SNAPSHOT_MANIFEST));
  assert.equal(manifest.files.filter(file => file.path.startsWith('templates/g-ideia/')).length, templates.length);

  const observations = await manager.observations();
  assert.deepEqual(observations.warnings, []);
  assert.equal(observations.totalSnapshots, 1);
  assert.deepEqual(observations.snapshots, [{
    name: 'r9-g-ideia', createdAt: manifest.createdAt, files: manifest.files.length,
    bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    evidence: `recovery/backups/r9-g-ideia/${SNAPSHOT_MANIFEST}`,
  }]);
  assert.deepEqual(observations.verifications, [], 'manifest observation must not invent a verification receipt');

  const restored = join(root, 'restored-r9');
  manager.restore(snapshotPath, restored);
  for (const template of templates) {
    assert.equal(readFileSync(join(restored, `templates/g-ideia/${template}.md`), 'utf8'), `# Fixture ${template}\n`);
  }
  assert.deepEqual(readFileSync(join(snapshotPath, SNAPSHOT_MANIFEST)), manifestBytes);
});

test('recovery observation preserves an invalid manifest and still reports other snapshots', async t => {
  const { source, manager } = fixture(t);
  put(source, 'templates/g-ideia/contract.md', '# Fixture contract');
  manager.snapshot(join(source, 'recovery/backups/valid'));
  const invalid = '{"version":1,"files":';
  put(source, `recovery/backups/incomplete/${SNAPSHOT_MANIFEST}`, invalid);
  const observation = await manager.observations();
  assert.deepEqual(observation.snapshots.map(snapshot => snapshot.name), ['valid']);
  assert.equal(observation.totalSnapshots, 2);
  assert.deepEqual(observation.warnings, ['incomplete: recovery manifest unavailable or invalid.']);
  assert.equal(readFileSync(join(source, 'recovery/backups/incomplete', SNAPSHOT_MANIFEST), 'utf8'), invalid);
});

test('existing destinations are preserved and damaged snapshots fail before restore creates files', (t) => {
  const { root, source, manager } = fixture(t);
  put(source, 'README.md', 'Original fixture');
  const snapshot = join(root, 'snapshot');
  manager.snapshot(snapshot);
  assert.throws(() => manager.snapshot(snapshot), /already exists/);
  const existing = join(root, 'existing');
  put(existing, 'keep.txt', 'Preserve');
  assert.throws(() => manager.restore(snapshot, existing), /already exists/);
  assert.equal(readFileSync(join(existing, 'keep.txt'), 'utf8'), 'Preserve');
  put(snapshot, 'README.md', 'Changed fixture');
  const target = join(root, 'damaged-restore');
  assert.throws(() => manager.restore(snapshot, target), /hash mismatch/);
  assert.equal(existsSync(target), false);
});

test('manifest cannot restore a path outside its destination', (t) => {
  const { root, source, manager } = fixture(t);
  put(source, 'README.md', 'Fixture');
  const snapshot = join(root, 'snapshot');
  const manifest = manager.snapshot(snapshot);
  manifest.files[0]!.path = '../outside.txt';
  put(snapshot, SNAPSHOT_MANIFEST, JSON.stringify(manifest));
  const target = join(root, 'restored');
  assert.throws(() => manager.restore(snapshot, target), /Invalid snapshot file path/);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(join(root, 'outside.txt')), false);
});

function activationFixture(t: TestContext) {
  const data = fixture(t);
  const external = join(data.root, 'external-project');
  mkdirSync(external);
  put(external, 'README.md', 'External project');
  put(data.source, 'README.md', 'Infrastructure fixture');
  put(data.source, 'src/check.js', '/* fixture, never executed */');
  const profile = (id: string, root: string) => ({
    id, name: id, aliases: [], root, status: 'active', stack: ['fixture'], modes: ['read-only'],
    sourceRoots: [] as string[], sources: [{ path: 'README.md', label: 'Readme', kind: 'reference', maxChars: 100 }],
    checks: [{ id: 'inspect', executable: process.execPath, args: [join(data.source, 'src/check.js')], relativeCwd: '.', readOnly: true, timeoutMs: 1000, environmentPaths: [join(data.source, 'src'), external] }],
  });
  const ownProfile = profile('infra', data.source);
  ownProfile.sourceRoots = [data.source];
  ownProfile.sources[0]!.path = join(data.source, 'README.md');
  put(data.source, 'profiles/registry.json', JSON.stringify({ version: 1, projects: [ownProfile, profile('external', external)] }));
  put(data.source, 'plugins/codex-infra/.mcp.json', JSON.stringify({ mcpServers: { 'codex-infra': {
    command: process.execPath, args: [join(data.source, 'dist/src/mcp.js')], env: { CODEX_INFRA_ROOT: data.source },
  } } }));
  const snapshotPath = join(data.root, 'activation-snapshot');
  data.manager.snapshot(snapshotPath);
  const restored = join(data.root, 'activation-restore');
  data.manager.restore(snapshotPath, restored);
  return { ...data, external, restored, recovered: new RecoveryManager(restored), snapshotPath };
}

function markReconciled(root: string): void {
  const file = join(root, RESTORE_METADATA_PATH);
  const metadata = JSON.parse(readFileSync(file, 'utf8'));
  put(root, RESTORE_METADATA_PATH, JSON.stringify({ ...metadata, requiresReconciliation: false }));
}

test('activation rebinds only internal paths, preserves external roots and enables dispatch last', async t => {
  const { source, external, restored, recovered, snapshotPath } = activationFixture(t);
  const originalRegistry = readFileSync(join(source, 'profiles/registry.json'), 'utf8');
  const originalSnapshot = readFileSync(join(snapshotPath, SNAPSHOT_MANIFEST), 'utf8');
  markReconciled(restored);
  const result = await recovered.activate();
  assert.equal(result.dispatchEnabled, true);
  assert.deepEqual(result.activatedProjectIds, ['infra', 'external']);
  const profiles = await new ProjectRegistry(join(restored, 'profiles/registry.json')).list();
  assert.equal(profiles[0]!.root, restored);
  assert.deepEqual(profiles[0]!.sourceRoots, [restored]);
  assert.equal(profiles[0]!.sources[0]!.path, join(restored, 'README.md'));
  assert.equal(profiles[0]!.checks[0]!.args[0], join(restored, 'src/check.js'));
  assert.equal(profiles[0]!.checks[0]!.executable, process.execPath);
  assert.deepEqual(profiles[0]!.checks[0]!.environmentPaths, [join(restored, 'src'), external]);
  assert.equal(profiles[1]!.root, external);
  const mcp = JSON.parse(readFileSync(join(restored, 'plugins/codex-infra/.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers['codex-infra'].env.CODEX_INFRA_ROOT, restored);
  assert.equal(mcp.mcpServers['codex-infra'].args[0], join(restored, 'dist/src/mcp.js'));
  assert.equal(JSON.parse(readFileSync(join(restored, RESTORE_METADATA_PATH), 'utf8')).dispatchEnabled, true);
  assert.equal(readFileSync(join(source, 'profiles/registry.json'), 'utf8'), originalRegistry);
  assert.equal(readFileSync(join(snapshotPath, SNAPSHOT_MANIFEST), 'utf8'), originalSnapshot);
  assert.deepEqual((await recovered.activate()).changedPaths, [RESTORE_METADATA_PATH]);
});

test('activation requires reconciliation and leaves every config unchanged when blocked', async t => {
  const { restored, recovered } = activationFixture(t);
  const originalRegistry = readFileSync(join(restored, 'profiles/registry.json'), 'utf8');
  await assert.rejects(recovered.activate(), /Reconcile/);
  assert.equal(readFileSync(join(restored, 'profiles/registry.json'), 'utf8'), originalRegistry);
  assert.equal(JSON.parse(readFileSync(join(restored, RESTORE_METADATA_PATH), 'utf8')).dispatchEnabled, false);
});

test('missing external project requires a known explicit root override before any activation writes', async t => {
  const { root, external, restored, recovered } = activationFixture(t);
  const registryPath = join(restored, 'profiles/registry.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  registry.projects[1].root = join(root, 'missing-external');
  put(restored, 'profiles/registry.json', JSON.stringify(registry));
  const before = readFileSync(registryPath, 'utf8');
  markReconciled(restored);
  await assert.rejects(recovered.activate(), /external.*override/);
  assert.equal(readFileSync(registryPath, 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(join(restored, RESTORE_METADATA_PATH), 'utf8')).dispatchEnabled, false);
  await assert.rejects(recovered.activate({ unknown: external }), /Unknown project/);
  const activated = await recovered.activate({ external });
  assert.equal(activated.profileMappings.find(profile => profile.projectId === 'external')!.overridden, true);
  assert.equal((await new ProjectRegistry(registryPath).resolve('external')).root, external);
});

test('selective activation preserves unavailable external profiles and rebinds internal references without requiring their runtimes', async t => {
  const { root, source, restored, recovered } = activationFixture(t);
  const registryPath = join(restored, 'profiles/registry.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const external = registry.projects[1];
  external.root = join(root, 'product-not-restored');
  external.checks[0].executable = join(root, 'product-runtime-not-installed', 'python.exe');
  external.checks[0].environmentPaths = [join(source, 'runtime', 'python')];
  put(restored, 'profiles/registry.json', JSON.stringify(registry));
  const sourceRegistry = readFileSync(join(source, 'profiles/registry.json'), 'utf8');
  markReconciled(restored);
  const result = await recovered.activate({}, ['infra']);
  assert.deepEqual(result.activatedProjectIds, ['infra']);
  const metadata = JSON.parse(readFileSync(join(restored, RESTORE_METADATA_PATH), 'utf8'));
  assert.equal(metadata.dispatchEnabled, true);
  assert.deepEqual(metadata.activatedProjectIds, ['infra']);
  const profiles = await new ProjectRegistry(registryPath).list();
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0]!.root, restored);
  assert.equal(profiles[1]!.root, external.root);
  assert.equal(profiles[1]!.checks[0]!.executable, external.checks[0].executable);
  assert.deepEqual(profiles[1]!.checks[0]!.environmentPaths, [join(restored, 'runtime', 'python')]);
  assert.equal(existsSync(join(restored, 'runtime', 'python')), false);
  assert.equal(readFileSync(join(source, 'profiles/registry.json'), 'utf8'), sourceRegistry);
  assert.deepEqual((await recovered.activate({}, ['infra'])).changedPaths, [RESTORE_METADATA_PATH]);
});

test('invalid activation selections preserve registry and disabled dispatch', async t => {
  const { external, restored, recovered } = activationFixture(t);
  markReconciled(restored);
  const registryPath = join(restored, 'profiles/registry.json');
  const originalRegistry = readFileSync(registryPath, 'utf8');
  const originalMetadata = readFileSync(join(restored, RESTORE_METADATA_PATH), 'utf8');
  for (const selection of [[], ['missing'], ['infra', 'infra']]) {
    await assert.rejects(recovered.activate({}, selection), /unique known IDs/);
  }
  await assert.rejects(recovered.activate({ external }, ['infra']), /requires selecting/);
  assert.equal(readFileSync(registryPath, 'utf8'), originalRegistry);
  assert.equal(readFileSync(join(restored, RESTORE_METADATA_PATH), 'utf8'), originalMetadata);
});

test('active selective restore cannot silently expand dispatch to other profiles', async t => {
  const { restored, recovered } = activationFixture(t);
  markReconciled(restored);
  await recovered.activate({}, ['infra']);
  const metadataPath = join(restored, RESTORE_METADATA_PATH);
  const originalMetadata = readFileSync(metadataPath, 'utf8');
  await assert.rejects(recovered.activate(), /Disable dispatch/);
  assert.equal(readFileSync(metadataPath, 'utf8'), originalMetadata);
  assert.deepEqual(JSON.parse(originalMetadata).activatedProjectIds, ['infra']);
});
