import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { ProfileSchema, ProjectRegistry, type Profile, type ProjectContext, type ContextSource } from '../src/registry.js';
import { ProcessRunner } from '../src/process.js';
import { StateStore } from '../src/state.js';
import { TaskContractBuilder } from '../src/task-contract.js';
import { EvaluationStore,type EvaluationInput } from '../src/evaluation.js';
import { KnowledgeIndex } from '../src/knowledge-index.js';
import { KnowledgeLearningStore, KnowledgeOriginSchema } from '../src/knowledge-learning.js';
import { InteractionStore } from '../src/interactions.js';
import { deterministicUuid } from '../src/legacy/command-os-utils.js';
import {EfficiencyHistory} from '../src/efficiency-history.js';
import {ImprovementImpactReader} from '../src/improvement-impact.js';

class RecordedGit extends ProcessRunner {
  override async run(executable: string, args: string[], cwd: string) {
    assert.equal(executable, 'git');
    return { executable, args, cwd, exitCode: 0, stdout: args.includes('rev-parse') ? 'fixture-head\n' : '', stderr: '', durationMs: 0 };
  }
}
class KnowledgeFixture {
  readonly registry: ProjectRegistry;
  readonly index: KnowledgeIndex;
  readonly learning: KnowledgeLearningStore;
  readonly evaluations: EvaluationStore;
  constructor(readonly root: string, public profile: Profile) {
    this.registry = new ProjectRegistry(path.join(root, 'profiles/registry.json'), new RecordedGit());
    this.index = new KnowledgeIndex(root); this.learning = new KnowledgeLearningStore(root); this.evaluations = new EvaluationStore(root);
  }
  static async create(t: TestContext) {
    const parent = fileURLToPath(new URL('../../artifacts/test-fixtures/', import.meta.url));
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'knowledge-'));
    const profile = ProfileSchema.parse({ id: 'tiny-knowledge', name: 'Tiny knowledge fixture', root, status: 'active', stack: ['node'],
      modes: ['read-only'], sourceRoots: [], sources: [], checks: [{ id: 'test', executable: process.execPath, args: [], readOnly: true }] });
    const fixture = new KnowledgeFixture(root, profile);
    const state = new StateStore(path.join(root, 'state/jobs.sqlite')); state.close();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return fixture;
  }
  async source(label: string, content: string, metadata: Partial<Profile['sources'][number]> = {}) {
    const relative = `${label}.md`;
    await fs.writeFile(path.join(this.root, relative), content);
    this.profile.sources.push(ProfileSchema.shape.sources.element.parse({ path: relative, label, kind: 'reference', maxChars: 12000, ...metadata }));
  }
  async context(): Promise<ProjectContext> { return this.registry.context(this.profile); }
  contract(objective = 'cache', budget = 24000) {
    return new TaskContractBuilder().build({ projectId: this.profile.id, objective, mode: 'read-only', kind: 'checks', checkIds: ['test'], details: { contextBudgetChars: budget } });
  }
  async job(exitCode: number, sources: ContextSource[] = [],options:{commandArgs?:string[];language?:string;unknownCommand?:boolean;metrics?:EvaluationInput['metrics']}={}) {
    const state = new StateStore(path.join(this.root, 'state/jobs.sqlite'));
    const job = state.create({ idempotencyKey: `fixture-${Date.now()}-${Math.random()}`, projectId: this.profile.id,
      objective: 'Validate the internal candidate fixture', mode: 'read-only', profileHash: this.registry.hash(this.profile) });
    state.claim(job.id, process.pid); state.transition(job.id, 'validating'); state.transition(job.id, exitCode === 0 ? 'completed' : 'failed'); state.close();
    const directory = path.join(this.root, 'artifacts/jobs', job.id, 'attempt-1');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'checks.json'), JSON.stringify([{ checkId: 'test', exitCode, durationMs: 1,...(options.unknownCommand?{}:{executable:process.execPath,args:options.commandArgs??[],cwd:this.root}) }]));
    const contract=new TaskContractBuilder().build({projectId:this.profile.id,objective:job.objective,mode:'read-only',kind:'checks',checkIds:['test'],details:{performanceScope:{taskClass:'tiny-knowledge',language:options.language??'TypeScript',problemCategory:'syntax'}}});
    await fs.writeFile(path.join(directory,'task-contract.json'),JSON.stringify(contract));
    const pack = { version: 1, hash: 'fixture-context', selectorVersion: 'fixture', capturedAt: new Date().toISOString(),
      profileHash: job.profileHash, taskContractHash: 'fixture-contract', sources, excludedSources: [], budget: { includedChars: 0, availableChars: 0, limitChars: 24000 } };
    await fs.writeFile(path.join(directory, 'context-pack.json'), JSON.stringify(pack));
    const evaluation = await this.evaluations.record({ jobId: job.id, attempt: 1, taskClass: 'tiny-knowledge',
      author: { name: 'Fixture evaluator', role: 'reviewer' }, source: 'internal-test-fixture', evidence: [`artifacts/jobs/${job.id}/attempt-1/checks.json`],
      rubric: { id: 'candidate-check', version: '1', criteria: [{ id: 'candidate-behavior', checkId: 'test', critical: true }] },metrics:options.metrics });
    return { jobId: job.id, attempt: 1, evaluationId: evaluation.id };
  }
}
const reviewer = { author: { name: 'Fixture reviewer', role: 'reviewer' as const }, source: 'internal-test-decision', evidence: ['fixture decision'] };
const owner = { author: { name: 'Fixture owner', role: 'owner' as const }, source: 'internal-test-decision', evidence: ['fixture explicit promotion decision'] };

test('improvement effects use the execution time of a backfilled baseline and only matching commands/scopes',async t=>{
  const f=await KnowledgeFixture.create(t),origin=await f.job(1);
  await fs.mkdir(path.join(f.root,'profiles'),{recursive:true});
  await fs.writeFile(f.registry.registryPath,JSON.stringify({version:1,projects:[f.profile]}));
  const proposed=await f.learning.propose({projectId:f.profile.id,origin:{jobId:origin.jobId,attempt:origin.attempt},title:'Syntax verification',kind:'practice',content:'Validate syntax before repeating work.',author:reviewer.author,source:reviewer.source,
    impact:{problem:'Repeated syntax failures',language:'TypeScript',expectedChange:'Fewer failed checks',affectedCheckIds:['test']}});
  await f.learning.review(proposed.id,{...reviewer,decision:'approved'});
  const validation=await f.job(0,[await f.learning.shadowSource(proposed.id)]);
  await f.learning.shadow(proposed.id,{...validation,...reviewer});
  const promoted=await f.learning.promote(proposed.id,owner);
  await new Promise(resolve=>setTimeout(resolve,5));
  const backfilled=await f.evaluations.record(await f.evaluations.read(origin.evaluationId));
  assert.ok(Date.parse(backfilled.technical.observedAt)>Date.parse(promoted.promotion!.recordedAt));
  const source=(await f.learning.promotedSources(f.profile.id))[0]!;
  const after=await f.job(0,[source]);
  await f.job(1,[{...source,path:path.join(f.root,'unrelated-copy.md')}]);
  await f.job(0,[source],{commandArgs:['changed-command']});
  await f.job(0,[source],{language:'Python'});
  await f.job(0,[source],{unknownCommand:true});
  const history=await new EfficiencyHistory(f.root).history({projectId:f.profile.id,days:14});
  const result=await new ImprovementImpactReader(f.root).read(history,f.profile.id);
  const impact=result.cases[0]!;
  assert.equal(impact.baseline.attempts,1);assert.equal(impact.baseline.failedAttempts,1);
  assert.equal(impact.after.attempts,1);assert.equal(impact.after.failedAttempts,0);
  assert.equal(impact.failureRateDelta,-1);
  assert.deepEqual(impact.baseline.evaluationIds,[backfilled.id]);
  assert.deepEqual(impact.after.jobIds,[after.jobId]);
  assert.equal(impact.contextInclusions,4);assert.equal(impact.proposedChange,proposed.content);
});

test('improvement metric averages exclude aggregate samples and keep failed gates out',async t=>{
  const f=await KnowledgeFixture.create(t),now=new Date().toISOString();
  const metric=(id:string,size:number,value:number):NonNullable<EvaluationInput['metrics']>[number]=>({id,classification:'observed',value,unit:'ms',method:'Synthetic observed fixture',source:'fixture-measurement',cohort:'same-controlled-fixture',window:{start:now,end:now},version:'1',sample:{size,representative:false,selection:'Synthetic fixture'}});
  const origin=await f.job(0,[],{metrics:[metric('individual',1,10),metric('aggregate',100,100)]});
  const candidate=await f.learning.propose({projectId:f.profile.id,origin,title:'Fixture verification practice',kind:'practice',content:'Run the named verification.',author:reviewer.author,source:reviewer.source});
  await f.learning.review(candidate.id,{...reviewer,decision:'approved'});
  const shadow=await f.job(0,[await f.learning.shadowSource(candidate.id)]);await f.learning.shadow(candidate.id,{...shadow,...reviewer});await f.learning.promote(candidate.id,owner);
  const source=(await f.learning.promotedSources(f.profile.id))[0]!;
  await f.job(0,[source],{metrics:[metric('individual',1,5),metric('aggregate',100,1)]});
  await f.job(1,[source],{metrics:[metric('individual',1,0)]});
  const history=await new EfficiencyHistory(f.root).history({days:14});
  const impact=(await new ImprovementImpactReader(f.root).read(history)).cases[0]!;
  assert.deepEqual(impact.comparisons.map(comparison=>comparison.metricId),['individual']);
  assert.equal(impact.comparisons[0]!.difference,-5);assert.equal(impact.comparisons[0]!.beforeN,1);assert.equal(impact.comparisons[0]!.afterN,1);
  assert.equal(impact.after.failedAttempts,1);
});

test('declared impact rejects cross-project baselines and check IDs absent from the baseline rubric',async t=>{
  const f=await KnowledgeFixture.create(t),origin=await f.job(1);
  const proposal={projectId:f.profile.id,origin,title:'Fixture learning',kind:'practice' as const,content:'Check the syntax.',author:reviewer.author,source:reviewer.source};
  await assert.rejects(f.learning.propose({...proposal,impact:{problem:'Failure',expectedChange:'Pass',baselineEvaluationIds:[origin.evaluationId],affectedCheckIds:['absent']}}),/absent.*rubric/);
  await assert.rejects(f.learning.propose({...proposal,projectId:'another-project',impact:{problem:'Failure',expectedChange:'Pass',baselineEvaluationIds:[origin.evaluationId]}}),/baseline.*another project/);
});

test('graph retrieves explicit related registered sources with provenance and keeps historical/expired sources excluded', async t => {
  const f = await KnowledgeFixture.create(t);
  await f.source('Cache', 'cache [[Transactions]] [[Old]] [[Expired]] [[Unregistered]]', { decisionRefs: ['ADR-7'], conflictsWith: ['Transactions'] });
  await f.source('Transactions', 'Atomic updates require validation.', { knowledgeClass: 'canonical' });
  await f.source('Shared decision', 'Durable observation.', { decisionRefs: ['ADR-7'] });
  await f.source('Old', 'Old instructions.', { knowledgeStatus: 'historical' });
  await f.source('Expired', 'Expired instructions.', { validUntil: '2020-01-01T00:00:00Z' });
  const index = await f.index.build(f.profile, await f.context());
  assert.ok(index.edges.some(edge => edge.kind === 'canonical-link'));
  assert.ok(index.edges.some(edge => edge.kind === 'declared-conflict'));
  assert.ok(index.edges.some(edge => edge.kind === 'shared-decision'));
  assert.ok(index.unresolvedLinks.some(link => link.reference === 'Unregistered'));
  const options = { asOf: '2026-09-12T00:00:00Z' };
  const result = await f.index.search(index.id, f.contract(), options);
  assert.deepEqual(new Set(result.pack.sources.map(source => source.label)), new Set(['Cache', 'Transactions', 'Shared decision']));
  assert.equal(result.pack.sources.find(source => source.label === 'Transactions')?.selectionReason, 'explicit-graph-link');
  assert.equal(result.pack.governance?.conflicts[0]?.resolution, 'unresolved');
  assert.ok(result.pack.sources.every(source => source.sha256.length === 64));
  assert.equal(result.freshness.liveContentChecked, false);
  assert.deepEqual(await f.index.search(index.id, f.contract(), options), result);
  await assert.rejects(f.index.search(index.id, { ...f.contract(), projectId: 'other' }), /differs/);
});

test('immutable index IDs isolate captures and graph expansion cannot exceed the task budget', async t => {
  const f = await KnowledgeFixture.create(t);
  await f.source('Cache', 'cache [[Transactions]] ' + 'x'.repeat(3900));
  await f.source('Transactions', 'y'.repeat(300));
  const first = await f.index.build(f.profile, await f.context());
  const repeated = await f.index.build(f.profile, { ...(await f.context()), capturedAt: first.capturedAt });
  assert.equal(repeated.id, first.id);
  await fs.writeFile(path.join(f.root, 'Cache.md'), 'cache updated [[Transactions]]');
  const second = await f.index.build(f.profile, await f.context());
  assert.notEqual(first.id, second.id);
  const old = await f.index.search(first.id, f.contract('cache', 4000));
  assert.ok(old.pack.budget.includedChars <= 4000);
  assert.ok(!old.pack.sources.some(source => source.label === 'Transactions'));
  const fresh = await f.index.search(second.id, f.contract('cache', 4000));
  assert.ok(fresh.pack.sources.some(source => source.label === 'Transactions'));
  assert.ok((await f.index.read(first.id)).nodes[0]!.excerpt.includes('x'.repeat(100)));
});

test('reviewed candidate with bound shadow evidence promotes into the next context and reversal preserves history', async t => {
  const f = await KnowledgeFixture.create(t);
  await f.source('Guide', 'General instructions.');
  const origin = await f.job(1);
  const proposal = { projectId: f.profile.id, origin, title: 'Cache verification practice', kind: 'practice' as const,
    content: 'For cache changes, validate invalidation before declaring completion.', author: reviewer.author, source: reviewer.source };
  const [proposed, concurrent] = await Promise.all([
    f.learning.proposeOnce(proposal, 'fixture-key'), new KnowledgeLearningStore(f.root).proposeOnce(proposal, 'fixture-key'),
  ]);
  assert.equal(proposed.id, concurrent.id); assert.equal((await f.learning.list()).items.length, 1);
  await assert.rejects(f.learning.proposeOnce({ ...proposal, content: 'Different content.' }, 'fixture-key'), /key.*different input/);
  assert.equal(proposed.originEvidence.checkResults[0]?.passed, false);
  assert.equal((await f.learning.promotedSources(f.profile.id)).length, 0);
  await assert.rejects(f.learning.promote(proposed.id, owner), /requires/);
  await f.learning.review(proposed.id, { ...reviewer, decision: 'approved' });
  const shadowSource = await f.learning.shadowSource(proposed.id);
  const validation = await f.job(0, [shadowSource]);
  const shadow = await f.learning.shadow(proposed.id, { ...validation, ...reviewer });
  assert.equal(shadow.status, 'shadow-passed');
  await assert.rejects(f.learning.promote(proposed.id, reviewer), /explicit owner/);
  const promoted = await f.learning.promote(proposed.id, owner);
  assert.equal(promoted.status, 'promoted');
  assert.deepEqual(await f.learning.proposeOnce(proposal, 'fixture-key'), promoted);
  const augmented = await f.learning.augmentContext(await f.context());
  assert.equal(augmented.sources.length, 2);
  const learned = augmented.sources.find(source => source.path.includes('releases'))!;
  assert.equal(learned.kind, 'reference');
  const indexed = await f.index.build(f.profile, augmented);
  const nextTask = await f.index.search(indexed.id, f.contract());
  assert.ok(nextTask.pack.sources.some(source => source.sha256 === proposed.contentHash));
  const reverted = await f.learning.revert(proposed.id, owner);
  assert.equal(reverted.status, 'reverted');
  assert.equal((await f.learning.augmentContext(augmented)).sources.length, 1);
  assert.equal((await f.learning.promotedSources(f.profile.id)).length, 0);
  assert.equal((await f.learning.read(proposed.id, promoted.revision)).status, 'promoted');
  assert.equal(await fs.readFile(path.join(f.root, promoted.promotion!.path), 'utf8'), proposed.content);
});

test('unrelated PASS cannot establish shadow validation and a bound failed check blocks promotion', async t => {
  const f = await KnowledgeFixture.create(t), origin = await f.job(1);
  const proposed = await f.learning.propose({ projectId: f.profile.id, origin, title: 'Check proposal', kind: 'script',
    content: 'console.log("fixture");', author: reviewer.author, source: reviewer.source });
  await f.learning.review(proposed.id, { ...reviewer, decision: 'approved' });
  const unrelated = await f.job(0);
  await assert.rejects(f.learning.shadow(proposed.id, { ...unrelated, ...reviewer }), /exact candidate content/);
  const failed = await f.job(1, [await f.learning.shadowSource(proposed.id)]);
  assert.equal((await f.learning.shadow(proposed.id, { ...failed, ...reviewer })).status, 'shadow-failed');
  await assert.rejects(f.learning.promote(proposed.id, owner), /requires/);
  assert.equal((await f.learning.list(f.profile.id)).items.length, 1);
});

test('indexing refuses unregistered files even when they exist inside the same fixture root', async t => {
  const f = await KnowledgeFixture.create(t);
  await f.source('Registered', 'cache');
  const context = await f.context();
  await fs.writeFile(path.join(f.root, 'Unregistered.md'), 'Do not index.');
  context.sources.push({ ...context.sources[0]!, label: 'Unregistered', path: path.join(f.root, 'Unregistered.md') });
  await assert.rejects(f.index.build(f.profile, context), /not registered/);
});

test('interaction origin pins declared evidence without manufacturing checks or bypassing shadow validation', async t => {
  const f = await KnowledgeFixture.create(t), interactions = new InteractionStore(f.root);
  const conversation = await interactions.begin({idempotencyKey: 'general-conversation', projectId: null,
    title: 'Fixture discussion', source: 'fixture'});
  const declared = await interactions.update(conversation.id, {expectedRevision: conversation.revision, source: 'fixture',
    status: 'completed', summary: 'A practice was discussed; this is not a passing check.', evidence: ['fixture-discussion-evidence']});
  const proposed = await f.learning.propose({projectId: f.profile.id, origin: {interactionId: declared.id, revision: declared.revision},
    title: 'Proposed cache practice', kind: 'practice', content: 'Validate cache invalidation before completion.', author: reviewer.author, source: reviewer.source});
  assert.deepEqual(proposed.originEvidence, {refs: [declared.artifactPath, 'fixture-discussion-evidence'], checkResults: [],
    jobStatusAtCapture: 'interaction-declared:completed'});
  await interactions.update(conversation.id, {expectedRevision: declared.revision, source: 'fixture', status: 'blocked', evidence: ['later-evidence']});
  assert.deepEqual((await f.learning.read(proposed.id)).origin, {interactionId: declared.id, revision: declared.revision});
  assert.equal((await f.learning.read(proposed.id)).originEvidence.refs.includes('later-evidence'), false);
  assert.equal((await interactions.read(declared.id, declared.revision)).status, 'completed');
  await assert.rejects(f.learning.promote(proposed.id, owner), /requires/);
  const unrelatedPassingJob = await f.job(0);
  await assert.rejects(f.learning.shadow(proposed.id, {...unrelatedPassingJob, ...reviewer}), /approved review/);
  await f.learning.review(proposed.id, {...reviewer, decision: 'approved'});
  await assert.rejects(f.learning.promote(proposed.id, owner), /requires/);
  await assert.rejects(f.learning.shadow(proposed.id, {...unrelatedPassingJob, ...reviewer}), /exact candidate content/);
  const boundValidation = await f.job(0, [await f.learning.shadowSource(proposed.id)]);
  assert.equal((await f.learning.shadow(proposed.id, {...boundValidation, ...reviewer})).status, 'shadow-passed');
  assert.equal((await f.learning.promote(proposed.id, owner)).status, 'promoted');
});

test('interaction origin rejects project mismatch, missing revisions and ambiguous mixed origins', async t => {
  const f = await KnowledgeFixture.create(t), interactions = new InteractionStore(f.root);
  const interaction = await interactions.begin({idempotencyKey: 'project-conversation', projectId: 'other-project',
    title: 'Fixture project discussion', source: 'fixture'});
  const proposal = {projectId: f.profile.id, origin: {interactionId: interaction.id, revision: interaction.revision},
    title: 'Proposal', kind: 'practice' as const, content: 'Check the named gate.', author: reviewer.author, source: reviewer.source};
  await assert.rejects(f.learning.propose(proposal), /another project/);
  assert.equal(KnowledgeOriginSchema.safeParse({interactionId: interaction.id}).success, false);
  assert.equal(KnowledgeOriginSchema.safeParse({...proposal.origin, ...(await f.job(0))}).success, false);
  await assert.rejects(f.learning.propose({...proposal, projectId: 'other-project', origin: {...proposal.origin, revision: 999}}));
  assert.deepEqual((await f.learning.list()).items, []);
});

test('keyed proposal replay completes a partially written candidate and preserves the original request binding', async t => {
  const f = await KnowledgeFixture.create(t), interaction = await new InteractionStore(f.root).begin({
    idempotencyKey: 'interrupted-proposal', title: 'Interrupted proposal fixture', source: 'Fixture', projectId: f.profile.id,
  });
  const proposal = { projectId: f.profile.id, origin: { interactionId: interaction.id, revision: interaction.revision },
    title: 'Recover candidate creation', kind: 'practice' as const, content: 'Retry the stable proposal key after an interrupted write.',
    author: reviewer.author, source: reviewer.source };
  const key = 'interrupted-fixture', id = deterministicUuid('knowledge-proposal/v1', key);
  const directory = path.join(f.root, 'artifacts/learning/candidates', id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'proposal-input.json'), JSON.stringify(proposal));
  await fs.writeFile(path.join(directory, 'proposal.txt'), proposal.content);
  await assert.rejects(f.learning.proposeOnce({ ...proposal, content: 'Incompatible replacement.' }, key), /key.*different input/);
  const recovered = await f.learning.proposeOnce(proposal, key);
  assert.equal(recovered.id, id); assert.equal(recovered.revision, 1); assert.equal(recovered.status, 'proposed');
  assert.equal((await f.learning.list()).items.length, 1);
  assert.deepEqual(await f.learning.proposeOnce(proposal, key), recovered);
  assert.equal(await fs.readFile(path.join(directory, 'proposal.txt'), 'utf8'), proposal.content);
});
