import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ProfileManager } from '../src/profile-manager.js';
import { ProjectRegistry } from '../src/registry.js';
import { StateStore } from '../src/state.js';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'codexinfra-profiles-'));
  const projectRoot = path.join(root, 'project');
  const infraRoot = path.join(root, 'infra');
  const registryPath = path.join(infraRoot, 'profiles/registry.json');
  await fs.mkdir(projectRoot);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), 'Fixture instructions');
  const state = new StateStore(path.join(infraRoot, 'state/jobs.sqlite'));
  t.after(async () => {
    state.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep + 'codexinfra-profiles-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const registry = new ProjectRegistry(registryPath);
  const input = {
    id: 'fixture', name: 'Fixture', aliases: ['fixture-alias'], root: projectRoot, status: 'active',
    stack: ['fixture'], modes: ['read-only'], sourceRoots: [],
    sources: [{ path: 'AGENTS.md', label: 'Contract', kind: 'instruction', maxChars: 1000 }],
    checks: [{ id: 'fixture-check', executable: 'must-never-run', args: [], readOnly: true, relativeCwd: '.', timeoutMs: 1000 }],
  };
  const manager = new ProfileManager(registry, state, infraRoot);
  return { root, projectRoot, infraRoot, registryPath, registry, state, input, manager };
}

test('JSON registration, identical calls and explicit replacement preserve other profiles and backups', async (t) => {
  const { infraRoot, registryPath, registry, input, manager } = await fixture(t);
  const untouched = { ...input, id: 'other', name: 'Other', aliases: [], customOwner: 'preserved' };
  const initial = { version: 1, description: 'Preserved registry metadata', projects: [untouched] };
  await fs.writeFile(registryPath, JSON.stringify(initial));
  const registered = await manager.register(JSON.parse(JSON.stringify(input)));
  assert.equal((await registry.resolve('fixture-alias')).id, registered.id);
  const first = await fs.readFile(registryPath, 'utf8');
  assert.deepEqual(await manager.register(input), registered);
  assert.equal(await fs.readFile(registryPath, 'utf8'), first);
  assert.equal((await fs.readdir(path.join(infraRoot, 'artifacts/profiles'))).length, 1);
  await assert.rejects(manager.register({ ...input, aliases: ['new-alias'] }), /explicit replace/);
  const replaced = await manager.register({ ...input, aliases: ['new-alias'] }, true);
  assert.deepEqual(replaced.aliases, ['new-alias']);
  const current = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  assert.equal(current.description, initial.description);
  assert.deepEqual(current.projects[0], untouched);
  const backups = await fs.readdir(path.join(infraRoot, 'artifacts/profiles'));
  assert.equal(backups.length, 2);
  const saved = await Promise.all(backups.map(async (file) => JSON.parse(await fs.readFile(path.join(infraRoot, 'artifacts/profiles', file), 'utf8'))));
  assert.ok(saved.some((snapshot) => JSON.stringify(snapshot) === JSON.stringify(initial)));
  assert.ok(saved.some((snapshot) => snapshot.projects.length === 2 && snapshot.projects[1].aliases[0] === 'fixture-alias'));
});

test('alias conflicts and active jobs block changes without adding backups', async (t) => {
  const { infraRoot, registryPath, registry, state, input, manager } = await fixture(t);
  await manager.register(input);
  const original = await fs.readFile(registryPath, 'utf8');
  await assert.rejects(manager.register({ ...input, id: 'another', name: 'Another', aliases: ['FIXTURE'] }), /conflicts/);
  const profile = await registry.resolve('fixture');
  const job = state.create({ idempotencyKey: 'active', projectId: profile.id, objective: 'Fixture active job', mode: 'read-only', profileHash: registry.hash(profile) });
  state.claim(job.id, process.pid);
  await assert.rejects(manager.register({ ...input, name: 'Changed' }, true), /active job/);
  state.transition(job.id, 'validating');
  await assert.rejects(manager.register({ ...input, name: 'Changed' }, true), /active job/);
  assert.equal(await fs.readFile(registryPath, 'utf8'), original);
  assert.equal((await fs.readdir(path.join(infraRoot, 'artifacts/profiles'))).length, 1);
  assert.deepEqual(await manager.register(input), profile);
});

test('missing roots and out-of-scope source paths leave no partial registration', async (t) => {
  const { root, infraRoot, registryPath, projectRoot, input, manager } = await fixture(t);
  await fs.writeFile(path.join(root, 'outside.md'), 'Outside fixture source');
  await assert.rejects(manager.register({ ...input, root: path.join(projectRoot, 'missing') }), /ENOENT/);
  await assert.rejects(manager.register({ ...input, sources: [{ ...input.sources[0], path: '../outside.md' }] }), /outside allowed roots/);
  await assert.rejects(fs.access(registryPath));
  await assert.rejects(fs.access(path.join(infraRoot, 'artifacts/profiles')));
  await assert.rejects(fs.access(registryPath + '.registration.lock'));
});

test('dispatch and registration share one short lock, which also releases after callback failure', async (t) => {
  const { infraRoot, registryPath, registry, state, input, manager } = await fixture(t);
  await manager.register(input);
  const peer = new ProfileManager(registry, state, infraRoot);
  const original = await fs.readFile(registryPath, 'utf8');
  const job = await manager.withLock(async () => {
    await assert.rejects(peer.register({ ...input, name: 'Racing replacement' }, true), /in progress/);
    const profile = await registry.resolve('fixture');
    const prepared = state.create({ idempotencyKey: 'locked-dispatch', projectId: profile.id,
      objective: 'Fixture dispatch', mode: 'read-only', profileHash: registry.hash(profile) });
    return state.claim(prepared.id, process.pid);
  });
  assert.equal(job.status, 'running');
  await assert.rejects(peer.register({ ...input, name: 'After claim' }, true), /active job/);
  assert.equal(await fs.readFile(registryPath, 'utf8'), original);
  await assert.rejects(manager.withLock(async () => { throw new Error('Fixture callback failure'); }), /Fixture callback failure/);
  assert.equal(await peer.withLock(async () => 'released'), 'released');
  await assert.rejects(fs.access(registryPath + '.registration.lock'));
});
