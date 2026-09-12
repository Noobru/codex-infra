import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { KnowledgeLearningStore } from '../src/knowledge-learning.js';
import { InteractionStore } from '../src/interactions.js';
import { ProcessRunner } from '../src/process.js';
import { LearningActivationPolicySchema, LearningRuntimeStore, type LearningBundleInput,
  type LearningSandboxExecutor, type LearningSandboxRequest } from '../src/learning-runtime.js';
import type { ProjectContext } from '../src/registry.js';
import { ProfileSchema, ProjectRegistry } from '../src/registry.js';
import { KnowledgeIndex } from '../src/knowledge-index.js';

const reviewer = { author: { name: 'Fixture reviewer', role: 'reviewer' as const }, source: 'internal fixture review', evidence: ['owned fixture behavior and code'] };
const agent = { author: { name: 'Fixture agent', role: 'model' as const }, source: 'internal fixture agent decision', evidence: ['owned fixture validation receipt'] };
const owner = { author: { name: 'Fixture owner', role: 'owner' as const }, source: 'internal fixture owner decision', evidence: ['fixture standing authorization'] };
const policy = LearningActivationPolicySchema.parse({ version: 1, enabled: true, automaticActivation: true,
  authorizedBy: owner.author, source: owner.source, evidence: owner.evidence, allowedProjectIds: ['fixture-learning'] });

/** This adapter executes only fixed, repository-owned test fixtures. It substitutes the OS boundary;
 * its receipts are explicitly fixture evidence, never verification of production sandbox isolation. */
class FixtureAdapter implements LearningSandboxExecutor {
  readonly calls: LearningSandboxRequest[] = [];
  async run(request: LearningSandboxRequest) {
    this.calls.push(request);
    assert.equal(request.runtime, 'node');
    const result = await new ProcessRunner().run(process.execPath, [request.entrypoint, ...request.args], request.workspace, request.timeoutMs, { signal: request.signal });
    return { result, isolation: { kind: 'test-only substituted boundary', network: 'denied' as const,
      filesystem: 'workspace-write' as const, verified: true as const, evidence: ['fixture adapter; no OS sandbox claim'] } };
  }
}
const bundle: LearningBundleInput = {
  version: 1, capabilityVersion: '1.0.0',
  files: [
    { path: 'lib.mjs', content: 'export const normalize = value => value.trim().toUpperCase();\n' },
    { path: 'main.mjs', content: "import { readFileSync, writeFileSync } from 'node:fs';\nimport { normalize } from './lib.mjs';\nwriteFileSync(process.argv[3], normalize(readFileSync(process.argv[2], 'utf8')));\nconsole.log('done');\n" },
    { path: 'test.mjs', content: "import assert from 'node:assert/strict';\nimport { normalize } from './lib.mjs';\nassert.equal(normalize('  abc  '), 'ABC');\nassert.equal(normalize(''), '');\nconsole.log('verified');\n" },
  ],
  entrypoints: [{ id: 'normalize', runtime: 'node', path: 'main.mjs' }],
  tests: [{ id: 'normalization', runtime: 'node', path: 'test.mjs', expectedStdout: 'verified\n' }],
};

async function fixture(t: TestContext, kind: 'script' | 'skill' = 'script') {
  const parent = fileURLToPath(new URL('../../artifacts/test-fixtures/', import.meta.url));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'learning-runtime-'));
  t.after(async () => { if (!path.resolve(root).startsWith(path.resolve(parent) + path.sep)) throw new Error('Fixture cleanup escaped test root.'); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'profiles'), { recursive: true });
  await fs.writeFile(path.join(root, 'profiles/learning-policy.json'), JSON.stringify(policy));
  const interaction = await new InteractionStore(root).begin({ idempotencyKey: 'owned-learning-runtime-fixture', projectId: 'fixture-learning', title: 'Owned fixture', source: 'test fixture' });
  const learning = new KnowledgeLearningStore(root);
  const candidate = await learning.propose({ projectId: 'fixture-learning', origin: { interactionId: interaction.id, revision: interaction.revision },
    title: 'Normalize fixture text', kind, content: 'A reusable fixture text normalization capability.', author: agent.author, source: agent.source });
  await learning.review(candidate.id, { ...reviewer, decision: 'approved' });
  const adapter = new FixtureAdapter(), runtime = new LearningRuntimeStore(root, adapter);
  return { root, learning, candidate, adapter, runtime };
}

test('executable capability records real fixture checks, agent activation, callable outputs, and permanent hash disable', async t => {
  const f = await fixture(t), published = await f.runtime.publish(f.candidate.id, bundle), hash = published.manifest.hash;
  assert.equal(published.state.status, 'packaged');
  assert.equal((await f.runtime.publish(f.candidate.id, bundle)).manifest.hash, hash);
  await assert.rejects(f.runtime.activate(hash, agent), /reviews/);
  await f.runtime.review(hash, { ...reviewer, decision: 'approved' });
  await assert.rejects(f.runtime.activate(hash, agent), /passing validation/);
  const validation = await f.runtime.validate(hash, reviewer);
  assert.equal(validation.status, 'passed');
  assert.equal(validation.checks[0]!.result.exitCode, 0);
  assert.ok(validation.checks[0]!.result.ownedPid);
  assert.equal(validation.checks[0]!.result.stdout, 'verified\n');
  await assert.rejects(f.runtime.activate(hash, owner), /model author/);
  const activated = await f.runtime.activate(hash, agent);
  assert.equal(activated.state.activation!.author.role, 'model');
  assert.equal(activated.state.activation!.policy.authorizedBy.role, 'owner');
  const sources = await f.runtime.activeSources(f.candidate.projectId);
  assert.equal(sources.length, 1); assert.ok(sources[0]!.excerpt.includes(hash));
  const profile = ProfileSchema.parse({ id: f.candidate.projectId, name: 'Fixture context', root: f.root, status: 'active',
    stack: ['node'], modes: ['read-only'], sourceRoots: [], sources: [], checks: [] });
  const registry = new ProjectRegistry(path.join(f.root, 'profiles/registry.json'));
  const enriched = await f.learning.augmentContext(await registry.context(profile));
  assert.equal((await new KnowledgeIndex(f.root).build(profile, enriched)).nodes.length, 1);
  const invocation = await f.runtime.run(hash, { projectId: f.candidate.projectId, entrypoint: 'normalize', args: ['input.txt', 'output.txt'],
    inputFiles: [{ path: 'input.txt', content: '  useful text  ' }], outputPaths: ['output.txt'], decision: agent });
  assert.equal(invocation.status, 'passed');
  assert.equal(invocation.outputs[0]!.content, 'USEFUL TEXT');
  assert.notEqual(f.adapter.calls[0]!.workspace, f.adapter.calls[1]!.workspace);
  await assert.rejects(f.runtime.run(hash, { projectId: 'other-project', entrypoint: 'normalize', decision: agent }), /exact project/);
  await assert.rejects(f.runtime.run(hash, { projectId: f.candidate.projectId, entrypoint: 'normalize', inputFiles: [{ path: 'main.mjs', content: 'override' }], decision: agent }), /replace bundle/);
  const context = { projectId: f.candidate.projectId, sources } as ProjectContext;
  assert.equal((await f.learning.augmentContext(context)).sources.length, 1);
  const calls = f.adapter.calls.length;
  await assert.rejects(f.runtime.disable(hash, agent), /owner decision/);
  assert.equal((await f.runtime.disable(hash, owner)).state.status, 'disabled');
  assert.equal((await new LearningRuntimeStore(f.root).read(hash)).state.status, 'disabled');
  assert.deepEqual(await f.runtime.activeSources(f.candidate.projectId), []);
  assert.deepEqual((await f.learning.augmentContext(context)).sources, []);
  await assert.rejects(f.runtime.run(hash, { projectId: f.candidate.projectId, entrypoint: 'normalize', decision: agent }), /not active/);
  assert.equal(f.adapter.calls.length, calls);
  await assert.rejects(f.runtime.activate(hash, agent), /passing validation/);
  assert.equal((await f.runtime.publish(f.candidate.id, bundle)).state.status, 'disabled');
  assert.notEqual((await f.runtime.publish(f.candidate.id, { ...bundle, capabilityVersion: '1.0.1' })).manifest.hash, hash);
});

test('failed executable test is retained and cannot activate; re-review invalidates an earlier validation', async t => {
  const f = await fixture(t), badBundle = { ...bundle, files: bundle.files.map(file => file.path === 'lib.mjs' ? { ...file, content: 'export const normalize = value => value;\n' } : file) };
  const hash = (await f.runtime.publish(f.candidate.id, badBundle)).manifest.hash;
  await f.runtime.review(hash, { ...reviewer, decision: 'approved' });
  const receipt = await f.runtime.validate(hash, reviewer);
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.checks[0]!.result.exitCode, 1);
  assert.equal((await f.runtime.read(hash)).state.status, 'validation-failed');
  await assert.rejects(f.runtime.activate(hash, agent), /passing validation/);
  const goodHash = (await f.runtime.publish(f.candidate.id, bundle)).manifest.hash;
  await f.runtime.review(goodHash, { ...reviewer, decision: 'approved' }); await f.runtime.validate(goodHash, reviewer);
  await f.runtime.review(goodHash, { ...reviewer, decision: 'approved' });
  await assert.rejects(f.runtime.activate(goodHash, agent), /passing validation/);
});

test('content hashes reject changed code and altered validation receipts', async t => {
  const f = await fixture(t), published = await f.runtime.publish(f.candidate.id, bundle), hash = published.manifest.hash;
  await f.runtime.review(hash, { ...reviewer, decision: 'approved' });
  const receipt = await f.runtime.validate(hash, reviewer);
  await fs.appendFile(path.join(f.root, receipt.artifactPath), '\n');
  await assert.rejects(f.runtime.activate(hash, agent), /receipt integrity/);
  const library = path.join(f.root, path.dirname(published.manifest.artifactPath), 'files/lib.mjs');
  await fs.appendFile(library, '\n// modified after review\n');
  await assert.rejects(f.runtime.read(hash), /file integrity/);
});

test('standing policy is required and scope changes deny execution without inventing owner authorization', async t => {
  const f = await fixture(t), hash = (await f.runtime.publish(f.candidate.id, bundle)).manifest.hash;
  await f.runtime.review(hash, { ...reviewer, decision: 'approved' });
  const noPolicy = new LearningRuntimeStore(f.root, f.adapter, async () => null);
  await assert.rejects(noPolicy.validate(hash, reviewer), /standing learning policy/);
  assert.equal(f.adapter.calls.length, 0);
  await f.runtime.validate(hash, reviewer);
  const manualOnly = new LearningRuntimeStore(f.root, f.adapter, async () => ({ ...policy, automaticActivation: false }));
  await assert.rejects(manualOnly.activate(hash, agent), /standing learning policy/);
  const differentProject = new LearningRuntimeStore(f.root, f.adapter, async () => ({ ...policy, allowedProjectIds: ['different-project'] }));
  await assert.rejects(differentProject.activate(hash, agent), /standing learning policy/);
  await f.runtime.activate(hash, agent);
  const disabledPolicy = new LearningRuntimeStore(f.root, f.adapter, async () => ({ ...policy, enabled: false }));
  await assert.rejects(disabledPolicy.run(hash, { projectId: f.candidate.projectId, entrypoint: 'normalize', decision: agent }), /standing learning policy/);
});

test('missing trusted sandbox does not execute generated code or manufacture a passing receipt', async t => {
  const f = await fixture(t), hash = (await f.runtime.publish(f.candidate.id, bundle)).manifest.hash;
  await f.runtime.review(hash, { ...reviewer, decision: 'approved' });
  await assert.rejects(new LearningRuntimeStore(f.root).validate(hash, reviewer), /verified OS sandbox adapter/);
  assert.equal((await f.runtime.read(hash)).state.validation, null);
  assert.equal(f.adapter.calls.length, 0);
});

test('bundled skills expose SKILL.md plus invocation metadata and remove both after disable', async t => {
  const f = await fixture(t, 'skill');
  await assert.rejects(f.runtime.publish(f.candidate.id, bundle), /requires SKILL.md/);
  const hash = (await f.runtime.publish(f.candidate.id, { ...bundle, files: [...bundle.files,
    { path: 'SKILL.md', content: '# Normalize text\nUse the registered normalize capability for supplied text.\n' }] })).manifest.hash;
  await f.runtime.review(hash, { ...reviewer, decision: 'approved' }); await f.runtime.validate(hash, reviewer); await f.runtime.activate(hash, agent);
  assert.equal((await f.runtime.activeSources(f.candidate.projectId)).length, 2);
  await f.runtime.disable(hash, owner);
  assert.deepEqual(await f.runtime.activeSources(f.candidate.projectId), []);
});

test('bundle schema restricts executable files and paths before materialization', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.publish(f.candidate.id, { ...bundle, files: [...bundle.files, { path: '../outside.txt', content: 'outside' }] }), /portable relative/);
  await assert.rejects(f.runtime.publish(f.candidate.id, { ...bundle, entrypoints: [{ id: 'missing', runtime: 'node', path: 'absent.mjs' }] }), /absent/);
  await assert.rejects(f.runtime.publish(f.candidate.id, { ...bundle, files: [...bundle.files, { path: 'LIB.MJS', content: 'duplicate' }] }), /unique/);
  await assert.rejects(f.runtime.publish(f.candidate.id, { ...bundle, tests: [] }), /Too small/);
});
