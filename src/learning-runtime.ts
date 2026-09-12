import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { KnowledgeLearningStore, KnowledgeReviewSchema } from './knowledge-learning.js';
import { KnowledgeFiles, KnowledgeContentSchema, KnowledgeDecisionSchema, KnowledgeHashSchema,
  KnowledgeKindSchema, KnowledgeOwnerDecisionSchema, KnowledgeProjectSchema, KnowledgeTextSchema } from './knowledge-store.js';
import { EvidenceSanitizer } from './evidence.js';
import { readJson, resolveRealSubPath } from './legacy/command-os-utils.js';
import type { CommandResult } from './process.js';
import type { ContextSource } from './registry.js';

const runtime = z.enum(['node', 'python']);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
const relativePath = z.string().min(1).max(240).refine(value => {
  const parts = value.split('/');
  return !/[\\:*?"<>|\x00-\x1f]/.test(value) && parts.every(part => part !== '' && part !== '.' && part !== '..'
    && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(part));
}, 'Capability paths must be portable relative file paths.');
const args = z.array(z.string().max(8000)).max(100).default([]);
const bundledFile = z.object({ path: relativePath, content: KnowledgeContentSchema }).strict();
const entrypoint = z.object({ id: identifier, runtime, path: relativePath }).strict();
const bundledTest = z.object({ id: identifier, runtime, path: relativePath, args,
  expectedExitCode: z.literal(0).default(0), expectedStdout: z.string().max(64000).optional() }).strict();

export const LearningBundleInputSchema = z.object({
  version: z.literal(1), capabilityVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  files: z.array(bundledFile).min(1).max(32), entrypoints: z.array(entrypoint).min(1).max(16),
  tests: z.array(bundledTest).min(1).max(20),
}).strict().superRefine((value, context) => {
  const names = value.files.map(file => file.path.toLowerCase());
  if (new Set(names).size !== names.length) context.addIssue({ code: 'custom', message: 'Bundle file paths must be unique.' });
  for (const group of [value.entrypoints, value.tests]) {
    if (new Set(group.map(item => item.id)).size !== group.length) context.addIssue({ code: 'custom', message: 'Entrypoint and test IDs must be unique in their group.' });
    for (const item of group) {
      if (!value.files.some(file => file.path === item.path)) context.addIssue({ code: 'custom', message: 'Executable path is absent from the bundle.' });
      if (item.runtime === 'node' ? !/\.(?:mjs|cjs|js)$/.test(item.path) : !item.path.endsWith('.py'))
        context.addIssue({ code: 'custom', message: 'Executable extension differs from its runtime.' });
    }
  }
  if (value.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 512 * 1024)
    context.addIssue({ code: 'custom', message: 'Bundle exceeds the total content budget.' });
});
export type LearningBundleInput = z.input<typeof LearningBundleInputSchema>;

/** The host persists an owner's standing authorization; each activation still names its actual agent. */
export const LearningActivationPolicySchema = z.object({
  version: z.literal(1), enabled: z.boolean(), automaticActivation: z.boolean(),
  authorizedBy: z.object({ name: KnowledgeTextSchema, role: z.literal('owner') }),
  source: KnowledgeTextSchema, evidence: KnowledgeDecisionSchema.shape.evidence,
  allowedProjectIds: z.array(z.union([z.literal('*'), KnowledgeProjectSchema])).min(1),
  allowedKinds: z.array(KnowledgeKindSchema).min(1).default(['script', 'skill', 'practice']),
  allowedRuntimes: z.array(runtime).min(1).default(['node', 'python']),
  maxTimeoutMs: z.number().int().min(100).max(120000).default(30000),
  maxBuildAttempts: z.number().int().min(1).max(5).default(2),
  maxCasesPerDrain: z.number().int().min(1).max(20).default(1),
  workerTimeoutMs: z.number().int().min(1000).max(600000).default(300000),
}).strict();
export type LearningActivationPolicy = z.output<typeof LearningActivationPolicySchema>;
export type LearningPolicyReader = () => Promise<LearningActivationPolicy | null>;
export const LearningAgentDecisionSchema = KnowledgeDecisionSchema.refine(value => value.author.role === 'model', 'Agent activation must record the model author, not the owner.');

export interface LearningSandboxRequest {
  workspace: string; runtime: 'node' | 'python'; entrypoint: string; args: string[]; timeoutMs: number; signal?: AbortSignal;
}
export const LearningIsolationSchema = z.object({
  kind: KnowledgeTextSchema, network: z.literal('denied'), filesystem: z.literal('workspace-write'),
  verified: z.literal(true), evidence: z.array(KnowledgeTextSchema).min(1),
});
/** Only a trusted host adapter implements this boundary. A CWD or JavaScript VM is not a sandbox. */
export interface LearningSandboxExecutor {
  run(request: LearningSandboxRequest): Promise<{ result: CommandResult; isolation: z.input<typeof LearningIsolationSchema> }>;
}

const descriptorSchema = z.object({
  version: z.literal(1), candidateId: z.uuid(), projectId: KnowledgeProjectSchema,
  candidateContentHash: KnowledgeHashSchema, title: KnowledgeTextSchema, kind: KnowledgeKindSchema,
  capabilityVersion: z.string(), files: z.array(z.object({ path: relativePath, sha256: KnowledgeHashSchema, bytes: z.number().int().nonnegative() })),
  entrypoints: z.array(entrypoint), tests: z.array(bundledTest),
});
export const LearningBundleManifestSchema = descriptorSchema.extend({ hash: KnowledgeHashSchema, createdAt: z.iso.datetime(), artifactPath: z.string() });
export type LearningBundleManifest = z.output<typeof LearningBundleManifestSchema>;
const decisionRecord = KnowledgeDecisionSchema.extend({ recordedAt: z.iso.datetime() });
const commandResult = z.object({ executable: z.string(), args: z.array(z.string()), cwd: z.string(), exitCode: z.number().int().nullable(),
  stdout: z.string(), stderr: z.string(), durationMs: z.number().nonnegative(), error: z.string().optional(), cleanupFailed: z.literal(true).optional(),
  ownedPid: z.number().int().optional(), outputTruncated: z.literal(true).optional() });
export const LearningValidationReceiptSchema = z.object({
  version: z.literal(1), id: z.uuid(), hash: KnowledgeHashSchema, projectId: KnowledgeProjectSchema,
  reviewRevision: z.number().int().positive(), recordedAt: z.iso.datetime(), artifactPath: z.string(),
  decision: KnowledgeDecisionSchema, status: z.enum(['passed', 'failed']),
  checks: z.array(z.object({ id: identifier, passed: z.boolean(), result: commandResult, isolation: LearningIsolationSchema,
    sourceIntegrity: z.boolean() })).min(1),
});
export type LearningValidationReceipt = z.output<typeof LearningValidationReceiptSchema>;
export const LearningRuntimeStateSchema = z.object({
  version: z.literal(1), hash: KnowledgeHashSchema, revision: z.number().int().positive(), updatedAt: z.iso.datetime(), artifactPath: z.string(),
  status: z.enum(['packaged', 'reviewed', 'rejected', 'validation-passed', 'validation-failed', 'active', 'disabled']),
  review: KnowledgeReviewSchema.extend({ recordedAt: z.iso.datetime(), hash: KnowledgeHashSchema, revision: z.number().int().positive() }).nullable(),
  validation: z.object({ path: z.string(), sha256: KnowledgeHashSchema }).nullable(),
  activation: decisionRecord.extend({ policyHash: KnowledgeHashSchema, policy: LearningActivationPolicySchema }).nullable(),
  disabled: decisionRecord.nullable(),
});
export type LearningRuntimeState = z.output<typeof LearningRuntimeStateSchema>;
export interface LearningRuntimeRecord { manifest: LearningBundleManifest; state: LearningRuntimeState }
export const LearningRunInputSchema = z.object({
  projectId: KnowledgeProjectSchema, entrypoint: identifier, args,
  attribution: z.object({ threadId: z.uuid(), turnId: z.uuid() }).strict().optional(),
  inputFiles: z.array(bundledFile).max(32).default([]), outputPaths: z.array(relativePath).max(32).default([]),
  decision: KnowledgeDecisionSchema,
}).strict();
export const LearningRunReceiptSchema = z.object({
  version: z.literal(1), id: z.uuid(), hash: KnowledgeHashSchema, projectId: KnowledgeProjectSchema, entrypoint: identifier,
  recordedAt: z.iso.datetime(), artifactPath: z.string(), decision: KnowledgeDecisionSchema,
  attribution: LearningRunInputSchema.shape.attribution,
  status: z.enum(['passed', 'failed']), result: commandResult, isolation: LearningIsolationSchema,
  outputs: z.array(z.object({ path: relativePath, content: KnowledgeContentSchema, sha256: KnowledgeHashSchema })),
  disabledDuringExecution: z.boolean(),
});
export type LearningRunReceipt = z.output<typeof LearningRunReceiptSchema>;

/** Versioned local capabilities share KnowledgeFiles and the existing candidate/review provenance. */
export class LearningRuntimeStore {
  private readonly files: KnowledgeFiles;
  private readonly learning: KnowledgeLearningStore;
  constructor(readonly root: string, private readonly executor?: LearningSandboxExecutor, private readonly policyReader?: LearningPolicyReader) {
    this.files = new KnowledgeFiles(root); this.learning = new KnowledgeLearningStore(root);
  }

  static async readPolicy(root: string): Promise<LearningActivationPolicy | null> {
    const raw = await readJson(path.join(root, 'profiles/learning-policy.json'), null);
    return raw === null ? null : LearningActivationPolicySchema.parse(raw);
  }

  async publish(candidateId: string, raw: LearningBundleInput): Promise<LearningRuntimeRecord> {
    const bundle = LearningBundleInputSchema.parse(raw), candidate = await this.learning.read(candidateId);
    await this.learning.shadowSource(candidateId);
    if (candidate.kind === 'skill' && !bundle.files.some(file => file.path === 'SKILL.md')) throw new Error('A skill bundle requires SKILL.md.');
    const descriptor = descriptorSchema.parse({ ...bundle, candidateId, projectId: candidate.projectId, candidateContentHash: candidate.contentHash,
      title: candidate.title, kind: candidate.kind, files: bundle.files.map(file => ({ path: file.path, sha256: KnowledgeFiles.hash(file.content), bytes: Buffer.byteLength(file.content) })).sort((a, b) => a.path.localeCompare(b.path)) });
    const hash = KnowledgeFiles.hash(JSON.stringify(descriptor)), base = this.base(hash);
    const names = await this.files.names(base);
    if (names.includes('manifest.json') && names.some(name => /^state-\d{6}\.json$/.test(name))) return this.read(hash);
    for (const file of bundle.files) await this.files.writeVerified(`${base}/files/${file.path}`, file.content);
    const now = new Date().toISOString();
    const manifest = LearningBundleManifestSchema.parse({ ...descriptor, hash, createdAt: now, artifactPath: `${base}/manifest.json` });
    if (!names.includes('manifest.json')) {
      try { await this.files.writeJsonNew(manifest.artifactPath, manifest); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const state = LearningRuntimeStateSchema.parse({ version: 1, hash, revision: 1, updatedAt: now, artifactPath: this.statePath(hash, 1),
      status: 'packaged', review: null, validation: null, activation: null, disabled: null });
    try { await this.files.writeJsonNew(state.artifactPath, state); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return this.read(hash);
  }

  async read(hash: string): Promise<LearningRuntimeRecord> {
    KnowledgeHashSchema.parse(hash);
    const manifest = await this.files.read(`${this.base(hash)}/manifest.json`, LearningBundleManifestSchema);
    if (manifest.hash !== hash || KnowledgeFiles.hash(JSON.stringify(descriptorSchema.parse(manifest))) !== hash) throw new Error('Capability manifest integrity mismatch.');
    const names = await this.files.names(this.base(hash));
    if (!names.includes('disabled.json')) await this.verifyFiles(manifest);
    const latest = names.filter(name => /^state-\d{6}\.json$/.test(name)).at(-1);
    const state = await this.files.read(`${this.base(hash)}/${latest ?? 'missing-state.json'}`, LearningRuntimeStateSchema);
    if (state.hash !== hash) throw new Error('Capability state identity mismatch.');
    if (names.includes('disabled.json')) {
      const disabled = await this.files.read(`${this.base(hash)}/disabled.json`, decisionRecord);
      return { manifest, state: { ...state, status: 'disabled', disabled } };
    }
    return { manifest, state };
  }

  async list(projectId?: string): Promise<{ items: LearningRuntimeRecord[]; warnings: string[] }> {
    if (projectId) KnowledgeProjectSchema.parse(projectId);
    const items: LearningRuntimeRecord[] = [], warnings: string[] = [];
    for (const hash of await this.files.names('artifacts/learning/runtime/bundles')) {
      if (!KnowledgeHashSchema.safeParse(hash).success) continue;
      try { const item = await this.read(hash); if (!projectId || item.manifest.projectId === projectId) items.push(item); }
      catch { warnings.push(`${hash}: capability record or integrity unavailable.`); }
    }
    return { items, warnings };
  }

  async review(hash: string, input: z.input<typeof KnowledgeReviewSchema>): Promise<LearningRuntimeRecord> {
    const decision = KnowledgeReviewSchema.parse(input), current = await this.read(hash);
    if (current.state.status === 'active' || current.state.status === 'disabled') throw new Error('Active or disabled capabilities cannot be revised; publish a new version.');
    return this.append(current, { status: decision.decision === 'approved' ? 'reviewed' : 'rejected', validation: null,
      review: { ...decision, hash, revision: current.state.revision + 1, recordedAt: new Date().toISOString() } });
  }

  async validate(hash: string, input: z.input<typeof KnowledgeDecisionSchema>, options: { signal?: AbortSignal } = {}): Promise<LearningValidationReceipt> {
    const decision = KnowledgeDecisionSchema.parse(input), current = await this.read(hash);
    await this.requireReview(current);
    if (current.state.status === 'active' || current.state.status === 'disabled') throw new Error('Validation requires an inactive capability.');
    const policy = await this.requirePolicy(current.manifest, false);
    const checks: LearningValidationReceipt['checks'] = [];
    for (const check of current.manifest.tests) {
      if (options.signal?.aborted) throw new Error('Capability validation cancelled.');
      const workspace = await this.materialize(current.manifest);
      const executed = await this.execute(workspace, check, policy.maxTimeoutMs, options.signal);
      const sourceIntegrity = await this.verifyWorkspace(current.manifest, workspace);
      checks.push({ id: check.id, ...executed, sourceIntegrity, passed: executed.result.exitCode === check.expectedExitCode
        && !executed.result.error && !executed.result.cleanupFailed && sourceIntegrity
        && (check.expectedStdout === undefined || executed.result.stdout === check.expectedStdout) });
      if (executed.result.cleanupFailed) break;
    }
    const id = randomUUID(), receipt = LearningValidationReceiptSchema.parse({ version: 1, id, hash, projectId: current.manifest.projectId,
      reviewRevision: current.state.review!.revision, recordedAt: new Date().toISOString(), artifactPath: `artifacts/learning/runtime/validations/${id}.json`,
      decision, status: checks.length === current.manifest.tests.length && checks.every(check => check.passed) ? 'passed' : 'failed', checks });
    await this.files.writeJsonNew(receipt.artifactPath, receipt);
    const latest = await this.read(hash);
    if (latest.state.revision !== current.state.revision || latest.state.status === 'disabled') throw new Error('Capability changed during validation; receipt is preserved but cannot be attached.');
    const receiptHash = KnowledgeFiles.hash(await fs.readFile(await this.files.file(receipt.artifactPath)));
    await this.append(current, { status: receipt.status === 'passed' ? 'validation-passed' : 'validation-failed', validation: { path: receipt.artifactPath, sha256: receiptHash } });
    return receipt;
  }

  async activate(hash: string, input: z.input<typeof LearningAgentDecisionSchema>): Promise<LearningRuntimeRecord> {
    const decision = LearningAgentDecisionSchema.parse(input), current = await this.read(hash);
    await this.requireReview(current);
    if (current.state.status !== 'validation-passed' || !current.state.validation) throw new Error('Activation requires demonstrated passing validation of this bundle.');
    const validationFile = await this.files.file(current.state.validation.path);
    if (KnowledgeFiles.hash(await fs.readFile(validationFile)) !== current.state.validation.sha256) throw new Error('Validation receipt integrity mismatch.');
    const receipt = await this.files.read(current.state.validation.path, LearningValidationReceiptSchema);
    if (receipt.hash !== hash || receipt.status !== 'passed' || receipt.reviewRevision !== current.state.review!.revision
      || receipt.checks.length !== current.manifest.tests.length || !receipt.checks.every(check => check.passed)) throw new Error('Validation does not match the reviewed capability.');
    const policy = await this.requirePolicy(current.manifest, true);
    await this.files.writeVerified(`${this.base(hash)}/invocation.md`, this.invocationContent(current.manifest));
    return this.append(current, { status: 'active', activation: { ...decision, recordedAt: new Date().toISOString(),
      policyHash: KnowledgeFiles.hash(JSON.stringify(policy)), policy } });
  }

  async disable(hash: string, input: z.input<typeof KnowledgeOwnerDecisionSchema>): Promise<LearningRuntimeRecord> {
    const decision = KnowledgeOwnerDecisionSchema.parse(input), names = await this.files.names(this.base(hash));
    if (!names.includes('manifest.json')) throw new Error('Capability hash is not registered.');
    const disabled = { ...decision, recordedAt: new Date().toISOString() };
    // A permanent exact-hash tombstone wins even if activation races or a later state write fails.
    try { await this.files.writeJsonNew(`${this.base(hash)}/disabled.json`, disabled); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return this.read(hash);
  }

  async run(hash: string, raw: z.input<typeof LearningRunInputSchema>, options: { signal?: AbortSignal } = {}): Promise<LearningRunReceipt> {
    const input = LearningRunInputSchema.parse(raw), current = await this.read(hash);
    await this.requireActive(current, input.projectId);
    const selected = current.manifest.entrypoints.find(item => item.id === input.entrypoint);
    if (!selected) throw new Error('Capability entrypoint is not registered.');
    const policy = await this.requirePolicy(current.manifest, false), workspace = await this.materialize(current.manifest, input.inputFiles);
    await this.requireActive(await this.read(hash), input.projectId);
    const execution = await this.execute(workspace, { ...selected, args: input.args }, policy.maxTimeoutMs, options.signal);
    const outputs: { path: string; content: string; sha256: string }[] = [];
    if (execution.result.exitCode === 0 && !execution.result.error && !execution.result.cleanupFailed) {
      for (const output of input.outputPaths) {
        const resolved = await resolveRealSubPath(path.join(workspace, output), workspace);
        if (!resolved || !(await fs.stat(resolved)).isFile() || (await fs.stat(resolved)).size > 64000) throw new Error('Capability output is missing, outside its workspace, or oversized.');
        const content = KnowledgeContentSchema.parse(await fs.readFile(resolved, 'utf8'));
        outputs.push({ path: output, content, sha256: KnowledgeFiles.hash(content) });
      }
    }
    const id = randomUUID(), receipt = LearningRunReceiptSchema.parse({ version: 1 as const, id, hash, projectId: input.projectId, entrypoint: input.entrypoint,
      recordedAt: new Date().toISOString(), artifactPath: `artifacts/learning/runtime/runs/${id}.json`, decision: input.decision,
      ...(input.attribution ? { attribution: input.attribution } : {}),
      status: execution.result.exitCode === 0 && !execution.result.error && !execution.result.cleanupFailed ? 'passed' : 'failed',
      ...execution, outputs, disabledDuringExecution: (await this.read(hash)).state.status === 'disabled' });
    await this.files.writeJsonNew(receipt.artifactPath, receipt);
    return receipt;
  }

  async activeSources(projectId: string): Promise<ContextSource[]> {
    const policy = await this.currentPolicy();
    if (!policy?.enabled || (!policy.allowedProjectIds.includes('*') && !policy.allowedProjectIds.includes(projectId))) return [];
    const inventory = await this.list(projectId);
    if (inventory.warnings.length) throw new Error('Active capability inventory is incomplete.');
    const sources: ContextSource[] = [];
    for (const item of inventory.items.filter(item => item.state.status === 'active')) {
      await this.requireActive(item, projectId);
      const relative = `${this.base(item.manifest.hash)}/invocation.md`;
      const content = this.invocationContent(item.manifest);
      if (KnowledgeFiles.hash(await fs.readFile(await this.files.file(relative))) !== KnowledgeFiles.hash(content)) throw new Error('Capability invocation descriptor integrity mismatch.');
      sources.push({ path: await this.files.file(relative), label: `Capability ${item.manifest.title} [${item.manifest.hash}]`, kind: 'reference',
        sha256: KnowledgeFiles.hash(content), modifiedAt: item.state.updatedAt, totalChars: content.length, excerpt: content,
        truncated: false, knowledgeStatus: 'active', knowledgeClass: 'pattern' });
      const skill = item.manifest.files.find(file => file.path === 'SKILL.md');
      if (skill) {
        const filePath = await this.files.file(`${this.base(item.manifest.hash)}/files/SKILL.md`), body = await fs.readFile(filePath, 'utf8');
        sources.push({ path: filePath, label: `Learned skill ${item.manifest.title} [${item.manifest.hash}]`, kind: 'reference', sha256: skill.sha256,
          modifiedAt: item.state.updatedAt, totalChars: body.length, excerpt: body.slice(0, 12000), truncated: body.length > 12000,
          knowledgeStatus: 'active', knowledgeClass: 'pattern' });
      }
    }
    return sources;
  }

  private async requireReview(record: LearningRuntimeRecord): Promise<void> {
    const candidate = await this.learning.read(record.manifest.candidateId);
    await this.learning.shadowSource(candidate.id);
    if (candidate.review?.decision !== 'approved' || candidate.contentHash !== record.manifest.candidateContentHash
      || record.state.review?.decision !== 'approved' || record.state.review.hash !== record.manifest.hash)
      throw new Error('Capability and source candidate require approved, content-bound reviews.');
  }
  private async requireActive(record: LearningRuntimeRecord, projectId: string): Promise<void> {
    if (record.manifest.projectId !== projectId || record.state.status !== 'active') throw new Error('Capability is not active for this exact project.');
    await this.requireReview(record);
    await this.requirePolicy(record.manifest, false);
  }
  private async requirePolicy(manifest: LearningBundleManifest, automatic: boolean): Promise<LearningActivationPolicy> {
    const policy = await this.currentPolicy();
    if (!policy?.enabled || (automatic && !policy.automaticActivation) || (!policy.allowedProjectIds.includes('*') && !policy.allowedProjectIds.includes(manifest.projectId))
      || !policy.allowedKinds.includes(manifest.kind) || [...manifest.entrypoints, ...manifest.tests].some(item => !policy.allowedRuntimes.includes(item.runtime)))
      throw new Error('Host standing learning policy does not authorize this capability.');
    return policy;
  }
  private async currentPolicy(): Promise<LearningActivationPolicy | null> {
    const raw = this.policyReader ? await this.policyReader() : await LearningRuntimeStore.readPolicy(this.root);
    return raw === null ? null : LearningActivationPolicySchema.parse(raw);
  }
  private invocationContent(manifest: LearningBundleManifest): string {
    return `# ${manifest.title}\n\nVersion: ${manifest.capabilityVersion}\nHash: ${manifest.hash}\nProject: ${manifest.projectId}\n\n` +
      `Use the registered run_learning_capability operation with this exact hash, projectId and an entrypoint below. Input files are copied into an isolated workspace; output files are returned as artifacts. Activation grants no product, network, publish or deployment authority.\n\n` +
      manifest.entrypoints.map(entry => `- ${entry.id}: ${entry.runtime}, ${entry.path}`).join('\n') + '\n';
  }
  private async execute(workspace: string, executable: { runtime: 'node' | 'python'; path: string; args: string[] }, timeoutMs: number, signal?: AbortSignal) {
    if (!this.executor) throw new Error('A verified OS sandbox adapter is required; generated code is never run directly.');
    const response = await this.executor.run({ workspace, runtime: executable.runtime, entrypoint: path.join(workspace, executable.path), args: executable.args, timeoutMs, signal });
    const isolation = LearningIsolationSchema.parse(response.isolation);
    const result = commandResult.parse({ ...response.result, stdout: EvidenceSanitizer.text(response.result.stdout, 64000),
      stderr: EvidenceSanitizer.text(response.result.stderr, 64000) });
    return { result, isolation };
  }
  private async materialize(manifest: LearningBundleManifest, inputFiles: z.output<typeof bundledFile>[] = []): Promise<string> {
    const occupied = new Set(manifest.files.map(file => file.path.toLowerCase()));
    for (const file of inputFiles) {
      if (occupied.has(file.path.toLowerCase())) throw new Error('Input file cannot replace bundle code or another input.');
      occupied.add(file.path.toLowerCase());
    }
    const relative = `artifacts/learning/runtime/workspaces/${randomUUID()}`;
    for (const file of manifest.files) {
      const content = await fs.readFile(await this.files.file(`${this.base(manifest.hash)}/files/${file.path}`), 'utf8');
      await this.files.writeNew(`${relative}/${file.path}`, content);
    }
    for (const file of inputFiles) await this.files.writeNew(`${relative}/${file.path}`, file.content);
    return this.files.file(relative);
  }
  private async verifyWorkspace(manifest: LearningBundleManifest, workspace: string): Promise<boolean> {
    try {
      for (const file of manifest.files) {
        const resolved = await resolveRealSubPath(path.join(workspace, file.path), workspace);
        if (!resolved || KnowledgeFiles.hash(await fs.readFile(resolved)) !== file.sha256) return false;
      }
      return true;
    } catch { return false; }
  }
  private async verifyFiles(manifest: LearningBundleManifest): Promise<void> {
    const workspace = await this.files.file(`${this.base(manifest.hash)}/files`);
    if (!await this.verifyWorkspace(manifest, workspace)) throw new Error('Capability file integrity mismatch.');
  }
  private base(hash: string): string { KnowledgeHashSchema.parse(hash); return `artifacts/learning/runtime/bundles/${hash}`; }
  private statePath(hash: string, revision: number): string { return `${this.base(hash)}/state-${String(revision).padStart(6, '0')}.json`; }
  private async append(current: LearningRuntimeRecord, patch: Partial<LearningRuntimeState>): Promise<LearningRuntimeRecord> {
    const latest = await this.read(current.manifest.hash);
    if (latest.state.revision !== current.state.revision || latest.state.status === 'disabled') throw new Error('Capability state changed; reload before updating.');
    const revision = current.state.revision + 1;
    const state = LearningRuntimeStateSchema.parse({ ...current.state, ...patch, revision, updatedAt: new Date().toISOString(), artifactPath: this.statePath(current.manifest.hash, revision) });
    await this.files.writeJsonNew(state.artifactPath, state);
    return this.read(current.manifest.hash);
  }
}
