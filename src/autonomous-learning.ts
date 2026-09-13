import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { KnowledgeFiles, KnowledgeContentSchema, KnowledgeDecisionSchema, KnowledgeProjectSchema } from './knowledge-store.js';
import { KnowledgeLearningStore, KnowledgeOriginSchema } from './knowledge-learning.js';
import { LearningRuntimeStore, type LearningActivationPolicy, type LearningSandboxExecutor } from './learning-runtime.js';
import { ReworkDiscovery, type ReworkCluster } from './rework-discovery.js';
import { SupervisorManager } from './supervisor.js';
import { EvidenceSanitizer } from './evidence.js';
import { atomicWriteJson, readJson } from './legacy/command-os-utils.js';
import type { DrainResult } from './queue.js';
import { LearningBuildArtifacts, LearningBuildInputSchema, type LearningBuilder } from './learning-builder.js';
import { StateStore } from './state.js';

const caseId = z.string().regex(/^learning_[a-f0-9]{32}$/);
export const LearningRecoverySchema = KnowledgeDecisionSchema.extend({
  expectedRevision: z.number().int().positive(),
  action: z.enum(['resume', 'supersede']),
  successorId: caseId.optional(),
}).strict();
export const LearningCaseSchema = z.object({
  version: z.literal(1), id: caseId, projectId: KnowledgeProjectSchema,
  revision: z.number().int().positive(), title: z.string(), content: z.string(),
  kind: z.enum(['script', 'skill', 'practice']), origin: KnowledgeOriginSchema,
  candidateId: z.uuid().optional(), hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  status: z.enum(['queued', 'building', 'reviewing', 'validating', 'active', 'attention', 'disabled', 'superseded']),
  recovery: LearningRecoverySchema.extend({ recordedAt: z.iso.datetime() }).nullable().default(null),
  attempts: z.number().int().nonnegative(), jobIds: z.array(z.uuid()), evidence: z.array(z.string()),
  ownerPid: z.number().int().positive().nullable(), lastError: z.string().nullable(),
  retryAfter: z.iso.datetime().nullable().default(null),
  resumeAttempt: z.boolean().default(false), buildFeedback: z.string().nullable().default(null),
  buildInput: LearningBuildInputSchema.nullable().default(null),
  reviewDecision: KnowledgeDecisionSchema.nullable().default(null),
  validationAttempts: z.number().int().nonnegative().default(0),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), artifactPath: z.string(),
});
export type LearningCase = z.output<typeof LearningCaseSchema>;
type Builder = Pick<LearningBuilder, 'build'>;
type Sandbox = LearningSandboxExecutor & {
  available?: (runtime: 'node' | 'python') => Promise<{ available: boolean; reason?: string }>;
};

/** Persistent learning cases use the existing bounded supervisor and TaskEngine worker admission. */
export class AutonomousLearning {
  private readonly files: KnowledgeFiles;
  constructor(readonly root: string, private readonly builder?: Builder, private readonly sandbox?: Sandbox) {
    this.files = new KnowledgeFiles(root);
  }

  async list(projectId?: string): Promise<{ items: LearningCase[]; warnings: string[] }> {
    if (projectId) KnowledgeProjectSchema.parse(projectId);
    const items: LearningCase[] = [], warnings: string[] = [];
    const lastError = await readJson(path.join(this.root,'artifacts/learning/last-error.json'),null) as {warning?:string;resolvedAt?:string}|null;
    if(lastError?.warning&&!lastError.resolvedAt)warnings.push(EvidenceSanitizer.text(lastError.warning,2000));
    const pointer = await readJson(path.join(this.root, 'artifacts/learning/supervisor.json'), null) as {id?: string} | null;
    if (pointer?.id) {
      try {
        const supervisor = await new SupervisorManager(this.root).status(pointer.id);
        if (supervisor.state === 'failed') warnings.push(`Learning supervisor ${pointer.id}: ${EvidenceSanitizer.text(supervisor.error ?? 'Failed before completion; inspect its receipt.', 1200)}`);
      } catch { warnings.push('Learning supervisor receipt unavailable.'); }
    }
    for (const id of await this.files.names('artifacts/learning/cases')) {
      if (!caseId.safeParse(id).success) continue;
      try {
        let item = await this.read(id);
        if (item.hash && item.status === 'active') {
          const runtime = await new LearningRuntimeStore(this.root).read(item.hash);
          if (runtime.state.status === 'disabled') item = { ...item, status: 'disabled' };
        }
        if (!projectId || item.projectId === projectId) items.push(item);
      } catch { warnings.push(`${id}: learning case unavailable.`); }
    }
    return { items: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), warnings };
  }

  async read(id: string): Promise<LearningCase> {
    caseId.parse(id);
    const names = await this.files.names(`artifacts/learning/cases/${id}`);
    return this.files.read(`artifacts/learning/cases/${id}/${names.filter(name => /^revision-\d{6}\.json$/.test(name)).at(-1) ?? 'missing.json'}`, LearningCaseSchema);
  }

  /** Explicit, evidence-backed disposition; never resets attempts or retries a worker implicitly. */
  async recover(id: string, raw: unknown): Promise<LearningCase> {
    const input = LearningRecoverySchema.parse(raw);
    return this.withLock('drain', async () => {
      const item = await this.read(id);
      if (item.revision !== input.expectedRevision) throw new Error('Learning case revision changed; read current evidence first.');
      if (item.status !== 'attention' || this.alive(item.ownerPid)) throw new Error('Recovery requires an unattended attention case.');
      const recovery = { ...input, recordedAt: new Date().toISOString() };
      const evidence = [...new Set([...item.evidence, ...input.evidence])];
      if (input.action === 'supersede') {
        if (!input.successorId || input.successorId === id) throw new Error('A different successor case is required.');
        const successor = await this.read(input.successorId);
        if (!successor.hash || !['active', 'disabled'].includes(successor.status) || successor.kind !== item.kind)
          throw new Error('Successor must have a validated capability of the same kind.');
        const record = await new LearningRuntimeStore(this.root).read(successor.hash);
        if (record.manifest.candidateId !== successor.candidateId || record.manifest.projectId !== successor.projectId
          || !record.state.activation || !record.state.validation || !['active', 'disabled'].includes(record.state.status))
          throw new Error('Successor activation and validation evidence are required.');
        return this.append(item, { status: 'superseded', recovery, evidence: [...new Set([...evidence, successor.artifactPath,
          record.state.validation.path])], ownerPid: null, retryAfter: null, resumeAttempt: false });
      }
      if (input.successorId || item.hash || !item.buildInput || !item.jobIds.length)
        throw new Error('Resume requires an interrupted build with its immutable input and job.');
      const key = LearningBuildArtifacts.key(item.buildInput);
      const state = new StateStore(path.join(this.root, 'state/jobs.sqlite'), { readOnly: true });
      try {
        const job = state.get(item.jobIds.at(-1)!);
        if (job.status !== 'completed' || ![`learning-${key}-build`, `learning-${key}-review`].includes(job.projectId))
          throw new Error('Inspect and explicitly retry the interrupted worker first; its named checks must complete before case recovery.');
      } finally { state.close(); }
      const result = await readJson(path.join(this.root, `artifacts/learning/builds/${key}/result.json`), null) as {review?: {decision?: string}} | null;
      if (result && result.review?.decision !== 'approved') throw new Error('A rejected build requires a new reviewed version, not resuming its cached result.');
      return this.append(item, { status: 'queued', recovery, evidence, ownerPid: null, retryAfter: null, resumeAttempt: true });
    });
  }

  /** Called after material execution/interaction events. Dashboard reads never enter this path. */
  async reconcile(projectId?: string) {
    const policy = await LearningRuntimeStore.readPolicy(this.root);
    if (!policy?.enabled) return { enabled: false, created: 0, warnings: [] as string[] };
    const permitted = (id: string) => !id.startsWith('learning-') && (policy.allowedProjectIds.includes('*') || policy.allowedProjectIds.includes(id));
    if (projectId && !permitted(projectId)) return { enabled: true, created: 0, warnings: [] as string[] };
    const discovery = await new ReworkDiscovery(this.root).reconcile({ projectId, limit: 50 });
    let created = 0;
    const warnings = [...discovery.warnings];
    for (const cluster of discovery.clusters.filter(item => permitted(item.projectId))) {
      const first = cluster.occurrences[0]!, capture = discovery.captures.find(item => item.clusterId === cluster.id);
      if (!capture) continue;
      created += Number(await this.enqueue(cluster.id, {
        projectId: cluster.projectId, title: cluster.summary, kind: 'skill',
        content: this.clusterContent(cluster, capture.artifactPath),
        origin: { jobId: first.jobId, attempt: first.attempt }, evidence: [capture.artifactPath, ...first.evidence],
      }));
    }
    const candidates = await new KnowledgeLearningStore(this.root).list(projectId);
    warnings.push(...candidates.warnings);
    for (const candidate of candidates.items.filter(item => permitted(item.projectId) && 'interactionId' in item.origin && item.status === 'proposed')) {
      created += Number(await this.enqueue(`candidate:${candidate.id}`, {
        projectId: candidate.projectId, title: candidate.title, content: candidate.content, kind: candidate.kind,
        origin: candidate.origin, candidateId: candidate.id, evidence: [candidate.artifactPath, ...candidate.originEvidence.refs],
      }));
    }
    return { enabled: true, created, warnings };
  }

  async kick() {
    const policy = await LearningRuntimeStore.readPolicy(this.root);
    if (!policy?.enabled || !policy.automaticActivation) return { started: false, reason: 'policy-disabled' };
    const pending = (await this.list()).items.some(item => this.eligible(item, policy.maxBuildAttempts));
    if (!pending) return { started: false, reason: 'no-pending-cases' };
    return this.withLock('dispatch', async () => {
      const pointer = await readJson(path.join(this.root, 'artifacts/learning/supervisor.json'), null) as { id: string } | null;
      const supervisors = new SupervisorManager(this.root);
      if (pointer) {
        const existing = await supervisors.status(pointer.id).catch(() => null);
        if (existing && ['starting', 'running'].includes(existing.state)) return { started: false, reason: 'already-running', supervisor: existing };
      }
      const supervisor = await supervisors.start({ mode: 'learning', maxJobs: policy.maxCasesPerDrain,
        totalTimeoutMs: Math.min(7_200_000, policy.maxCasesPerDrain * policy.maxBuildAttempts * (2 * Math.max(policy.workerTimeoutMs,LearningRuntimeStore.workerTimeout(policy,2)) + 120_000)) });
      await atomicWriteJson(path.join(this.root, 'artifacts/learning/supervisor.json'), supervisor);
      return { started: true, supervisor };
    });
  }

  async onEvent(projectId?: string) {
    try {
      const result={...await this.reconcile(projectId),dispatch:await this.kick()};
      if(result.enabled){
        const previous=await readJson(path.join(this.root,'artifacts/learning/last-error.json'),null) as {warning?:string;resolvedAt?:string}|null;
        if(previous?.warning&&!previous.resolvedAt)await atomicWriteJson(path.join(this.root,'artifacts/learning/last-error.json'),{...previous,resolvedAt:new Date().toISOString()});
      }
      return result;
    }
    catch (error) {
      const warning = this.error(error);
      await atomicWriteJson(path.join(this.root, 'artifacts/learning/last-error.json'), { recordedAt: new Date().toISOString(), warning }).catch(() => {});
      return { enabled: null, created: 0, warnings: [warning], dispatch: { started: false } };
    }
  }

  async drain(options: { maxJobs: number; totalTimeoutMs: number; signal?: AbortSignal }): Promise<DrainResult> {
    const policy = await LearningRuntimeStore.readPolicy(this.root);
    if (!policy?.enabled || !policy.automaticActivation) return { jobs: [], stopReason: 'no_ready_jobs' };
    const controller = new AbortController(), abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(abort, options.totalTimeoutMs);
    try {
      return await this.withLock('drain', async () => {
        const pending = (await this.list()).items.filter(item => this.eligible(item, policy.maxBuildAttempts))
          .slice(0, Math.min(options.maxJobs, policy.maxCasesPerDrain));
        for (const item of pending) {
          if (controller.signal.aborted) return { jobs: [], stopReason: 'aborted' };
          try { await this.process(item, policy, controller.signal); }
          catch (error) {
            // Includes readiness/input failures before a model job exists. Park once, preserving history.
            const current = await this.read(item.id);
            await this.append(current, {status:'attention', ownerPid:null, lastError:this.error(error), retryAfter:null, resumeAttempt:false});
          }
          if (controller.signal.aborted) return { jobs: [], stopReason: 'aborted' };
        }
        return { jobs: [], stopReason: pending.length ? 'max_jobs' : 'no_ready_jobs' };
      });
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  }

  private async process(initial: LearningCase, policy: LearningActivationPolicy, signal: AbortSignal) {
    const maxAttempts = policy.maxBuildAttempts;
    const builder = this.builder ?? new (await import('./learning-builder.js')).LearningBuilder(this.root);
    const sandbox: Sandbox = this.sandbox ?? new (await import('./learning-sandbox.js')).LearningSandbox(this.root);
    const runtime = new LearningRuntimeStore(this.root, sandbox), candidates = new KnowledgeLearningStore(this.root);
    let item = initial;
    // A completed bundle has its own durable phase and budget. Restarting the supervisor
    // must not spend another model attempt or erase a passed, content-bound validation.
    if (item.hash) {
      item = await this.finishBundle(item, runtime, maxAttempts, signal);
      if (item.status !== 'queued') return;
    } else if (['building', 'reviewing'].includes(item.status) && !this.alive(item.ownerPid)) {
      item = await this.append(item, { resumeAttempt: true, ownerPid: null });
    }
    const readiness = await Promise.all([...new Set(policy.allowedRuntimes)].map(async runtime => ({ runtime,
      ...await sandbox.available?.(runtime) ?? { available: true } })));
    const availableRuntimes = readiness.filter(item => item.available).map(item => item.runtime);
    if (!availableRuntimes.length) {
      await this.append(item, { status: 'attention', lastError: readiness.map(item => `${item.runtime}: ${item.reason ?? 'sandbox unavailable'}`).join('; '),
        retryAfter: new Date(Date.now()+30_000).toISOString(), ownerPid: null });
      return;
    }
    while ((item.attempts < maxAttempts || item.resumeAttempt) && !signal.aborted) {
      // Keep exactly the same data and runtime choices for a resumed TaskEngine attempt.
      const input = item.resumeAttempt && item.buildInput ? item.buildInput : LearningBuildInputSchema.parse({
        caseId: item.id, projectId: item.projectId, title: item.title, content: item.content, kind: item.kind,
        evidence: LearningBuildArtifacts.evidence(item.evidence, item.artifactPath), attempt: item.resumeAttempt ? item.attempts : item.attempts + 1,
        allowedRuntimes: availableRuntimes, ...((item.resumeAttempt ? item.buildFeedback : item.lastError)
          ? { feedback: item.resumeAttempt ? item.buildFeedback : item.lastError } : {}),
      });
      if (input.allowedRuntimes?.some(runtime => !availableRuntimes.includes(runtime))) {
        await this.append(item, { status: 'attention', ownerPid: null, resumeAttempt: true,
          lastError: 'A runtime selected for this immutable attempt is unavailable or no longer authorized.',
          retryAfter: new Date(Date.now()+30_000).toISOString() });
        return;
      }
      item = await this.append(item, { status: 'building', ownerPid: process.pid,
        attempts: input.attempt, buildInput: input, hash: undefined, reviewDecision: null, validationAttempts: 0,
        buildFeedback: input.feedback ?? null, resumeAttempt: false, retryAfter: null });
      try {
        const built = await builder.build(input, { signal,
          onJobPrepared: async job => { item = await this.append(item, {
            status: job.projectId.startsWith('learning-') && job.projectId.endsWith('-review') ? 'reviewing' : 'building',
            jobIds: [...new Set([...item.jobIds,job.id])],
          }); } });
        item = await this.append(item, { status: 'reviewing', jobIds: [...new Set([...item.jobIds, ...built.jobIds])] });
        const decision = KnowledgeDecisionSchema.parse({ author: { name: 'Autonomous learning reviewer', role: 'model' },
          source: `Independent TaskEngine review: ${built.review.reason}`,
          evidence: LearningBuildArtifacts.evidence([...built.review.evidence, ...built.jobIds.map(id => `artifacts/jobs/${id}`)], built.artifactPath) });
        if (built.review.decision !== 'approved') throw new Error(`Review rejected: ${built.review.reason}`);
        const candidate = item.candidateId ? await candidates.read(item.candidateId) : await candidates.proposeOnce({
          projectId: item.projectId, origin: item.origin, title: item.title, kind: item.kind, content: item.content,
          author: { name: 'Autonomous rework discovery', role: 'model' }, source: item.evidence[0]!,
        }, item.id);
        await candidates.review(candidate.id, { ...decision, decision: 'approved' });
        const packaged = await runtime.publish(candidate.id, built.bundle);
        item = await this.append(item, { status: 'validating', candidateId: candidate.id, hash: packaged.manifest.hash, reviewDecision: decision });
        item = await this.finishBundle(item, runtime, maxAttempts, signal);
        if (item.status !== 'queued') return;
      } catch (error) {
        const extra = typeof error === 'object' && error !== null && 'jobIds' in error && Array.isArray(error.jobIds) ? error.jobIds.filter((id): id is string => typeof id === 'string' && z.uuid().safeParse(id).success) : [];
        const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : null;
        if (status === 'waiting_user' || status === 'cancelled') {
          await this.append(item, { status: 'attention', ownerPid: null, lastError: this.error(error), resumeAttempt: false,
            retryAfter: null, jobIds: [...new Set([...item.jobIds, ...extra])] });
          return;
        }
        if(status === 'waiting_quota' || status === 'busy') {
          await this.append(item,{status:'attention',ownerPid:null,lastError:this.error(error),resumeAttempt:true,
            retryAfter:new Date(Date.now()+(status==='waiting_quota'?1_800_000:30_000)).toISOString(),jobIds:[...new Set([...item.jobIds,...extra])]});
          return;
        }
        item = await this.append(item, { status: signal.aborted || item.attempts >= maxAttempts ? 'attention' : 'queued',
          ownerPid: null, lastError: this.error(error), jobIds: [...new Set([...item.jobIds, ...extra])] });
        if (/quota|rate.?limit|admission|resource.*busy|cleanup/i.test(item.lastError!)) {
          await this.append(item, { status: 'attention' }); return;
        }
      }
    }
  }

  private async finishBundle(initial: LearningCase, runtime: LearningRuntimeStore, max: number, signal: AbortSignal): Promise<LearningCase> {
    let item = initial;
    try {
      let record = await runtime.read(item.hash!);
      if (record.manifest.projectId !== item.projectId || record.manifest.candidateId !== item.candidateId)
        throw new Error('Persisted capability differs from its learning case.');
      if (record.state.status === 'disabled') return this.append(item, { status: 'disabled', ownerPid: null, retryAfter: null, resumeAttempt: false });
      if (record.state.status === 'active') {
        // Reuse the runtime's current policy/review/integrity checks without executing it.
        const sources = await runtime.activeSources(item.projectId);
        if (!sources.some(source => source.label.includes(`[${item.hash}]`))) throw new Error('Active capability is unavailable under current policy and reviews.');
        return this.append(item, { status: 'active', ownerPid: null, lastError: null, retryAfter: null, resumeAttempt: false });
      }
      if (record.state.status === 'validation-failed' || record.state.status === 'rejected')
        return this.append(item, { status: item.attempts < max ? 'queued' : 'attention', ownerPid: null, retryAfter: null,
          lastError: item.lastError ?? `Capability ${record.state.status}; a new reviewed build is required.`, hash: undefined, resumeAttempt: false });
      const decision = item.reviewDecision ?? record.state.review;
      if (!decision) throw new Error('Independent build review is unavailable for this packaged capability.');
      if (record.state.status !== 'validation-passed') {
        if (item.validationAttempts >= max) throw new Error('Capability validation attempt budget exhausted.');
        item = await this.append(item, { status: 'validating', ownerPid: process.pid, validationAttempts: item.validationAttempts + 1, retryAfter: null });
        if (record.state.status === 'packaged') record = await runtime.review(item.hash!, { ...decision, decision: 'approved' });
        const receipt = await runtime.validate(item.hash!, decision, { signal });
        item = await this.append(item, { evidence: [...new Set([...item.evidence, receipt.artifactPath])] });
        if (receipt.status !== 'passed') {
          const failure = 'Capability tests failed: ' + JSON.stringify(receipt.checks.map(check => ({ id: check.id, passed: check.passed,
            stdout: check.result.stdout.slice(0, 2000), stderr: check.result.stderr.slice(0, 2000), error: check.result.error })));
          return this.append(item, { status: !signal.aborted && item.attempts < max ? 'queued' : 'attention', ownerPid: null,
            lastError: this.error(failure), hash: undefined, resumeAttempt: false, retryAfter: null });
        }
        record = await runtime.read(item.hash!);
      }
      await runtime.activate(item.hash!, { ...decision, author: { name: 'Autonomous learning coordinator', role: 'model' },
        source: 'Owner standing policy; independent review and isolated tests passed for this exact version.',
        evidence: LearningBuildArtifacts.evidence([...decision.evidence,record.state.validation!.path,...item.evidence],item.artifactPath) });
      return this.append(item, { status: 'active', ownerPid: null, lastError: null, retryAfter: null, resumeAttempt: false });
    } catch (error) {
      // Exceptions (interruption/unavailable executor) resume the same reviewed hash, with a
      // separate bounded budget. A failed behavior test above instead requires a new build.
      return this.append(item, { status: 'attention', ownerPid: null, lastError: this.error(error), resumeAttempt: false,
        retryAfter: item.validationAttempts > initial.validationAttempts && item.validationAttempts < max
          ? new Date(Date.now()+30_000).toISOString() : null });
    }
  }

  private clusterContent(cluster: ReworkCluster, capturePath: string): string {
    const occurrences: ReworkCluster['occurrences'] = [];
    const summarize = () => ({ signature: cluster.signature, language: cluster.language, problemCategory: cluster.problemCategory,
      recommendation: cluster.recommendation, capturePath, totalOccurrences: cluster.occurrences.length,
      distinctJobs: cluster.distinctJobs, minimumDistinctJobs: 2, selectedDistinctJobs: new Set(occurrences.map(item => item.jobId)).size,
      selectedOccurrences: occurrences.length, truncated: occurrences.length < cluster.occurrences.length, occurrences });
    // Prefer a real occurrence from each job before adding repeat attempts. Never slice the
    // serialized JSON or fabricate diagnostics to make an oversized cluster fit the contract.
    const firstByJob = new Map<string, ReworkCluster['occurrences'][number]>();
    for (const occurrence of cluster.occurrences) if (!firstByJob.has(occurrence.jobId)) firstByJob.set(occurrence.jobId, occurrence);
    const first = [...firstByJob.values()], remainder = cluster.occurrences.filter(item => firstByJob.get(item.jobId) !== item);
    for (const occurrence of [...first, ...remainder]) {
      occurrences.push(occurrence);
      if (JSON.stringify(summarize()).length > 60000) occurrences.pop();
    }
    if (new Set(occurrences.map(item => item.jobId)).size < 2) throw new Error('Cluster evidence cannot preserve two distinct jobs within the learning input budget.');
    return KnowledgeContentSchema.parse(JSON.stringify(summarize()));
  }

  private async enqueue(key: string, input: Pick<LearningCase, 'projectId' | 'title' | 'content' | 'kind' | 'origin' | 'evidence' | 'candidateId'>) {
    const id = 'learning_' + KnowledgeFiles.hash(key).slice(0, 32);
    if ((await this.files.names(`artifacts/learning/cases/${id}`)).length) return false;
    const now = new Date().toISOString();
    const item = LearningCaseSchema.parse({ ...input, version: 1, id, revision: 1, status: 'queued', attempts: 0, jobIds: [],
      ownerPid: null, lastError: null, createdAt: now, updatedAt: now, artifactPath: this.relative(id, 1) });
    try { await this.files.writeJsonNew(item.artifactPath, item); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  }
  private async append(current: LearningCase, update: Partial<LearningCase>) {
    const revision = current.revision + 1, item = LearningCaseSchema.parse({ ...current, ...update, revision,
      updatedAt: new Date().toISOString(), artifactPath: this.relative(current.id, revision) });
    await this.files.writeJsonNew(item.artifactPath, item); return item;
  }
  private relative(id: string, revision: number) { return `artifacts/learning/cases/${id}/revision-${String(revision).padStart(6, '0')}.json`; }
  private eligible(item: LearningCase, max: number) {
    if (['building', 'reviewing', 'validating'].includes(item.status) && !this.alive(item.ownerPid)) return true;
    const due = item.status === 'attention' && item.retryAfter !== null && Date.parse(item.retryAfter) <= Date.now();
    return (item.attempts < max || item.resumeAttempt || (item.hash && item.validationAttempts < max)) && (item.status === 'queued' || due);
  }
  private alive(pid: number | null) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  }
  private async withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const directory = path.join(this.root, 'artifacts/learning');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(await this.files.file('artifacts/learning'), `${name}.lock`);
    let handle;
    try { handle = await fs.open(file, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lock = await readJson(file, null) as { pid: number } | null;
      if (!lock || this.alive(lock.pid)) throw new Error('Learning coordination is already in progress.');
      // Only this owned lock with an absent process is reclaimed. Evidence/capability files are immutable.
      await fs.unlink(file); handle = await fs.open(file, 'wx');
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return await operation(); }
    finally { await handle.close(); await fs.unlink(file); }
  }
  private error(error: unknown) { return EvidenceSanitizer.text(error instanceof Error ? error.message : String(error), 6000); }
}
