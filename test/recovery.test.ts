import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RecoveryManager, RESTORE_METADATA_PATH, SNAPSHOT_MANIFEST, type SnapshotManifest } from '../src/recovery.js';
import { StateStore } from '../src/state.js';
import { ProjectRegistry } from '../src/registry.js';

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
