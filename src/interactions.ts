import { z } from 'zod';
import { EvidenceSanitizer } from './evidence.js';
import { PerformanceScopeSchema } from './performance-scope.js';
import {IntentSchema} from './delegation-contract.js';
import { KnowledgeFiles, KnowledgeProjectSchema, KnowledgeTextSchema, KnowledgeEvidenceSchema,
  KnowledgeKindSchema, KnowledgeContentSchema, KnowledgeImpactSchema } from './knowledge-store.js';

const identity = z.string().trim().min(1).max(200);
const titleInput = z.string().min(1).max(1_000_000).refine(value => value.trim().length > 0, 'Title cannot be blank.').nullable();
const cwd = z.string().max(8192).transform(value => EvidenceSanitizer.text(value, 8192));
const timestamp = z.iso.datetime();
export const InteractionIdSchema = z.string().regex(/^interaction_[a-f0-9]{32}$/);
export const InteractionIntentSchema = z.enum(['conversation', 'project-context', 'work']);
export const InteractionRouteSchema = z.enum(['direct', 'job', 'workflow']);
export const InteractionStatusSchema = z.enum(['imported', 'open', 'completed', 'blocked', 'cancelled']);
export const InteractionOriginSchema = z.object({
  source: KnowledgeTextSchema, observedAt: timestamp, sourceRef: KnowledgeTextSchema.nullable().default(null),
});
export const InteractionFindingSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  projectId: KnowledgeProjectSchema, title: KnowledgeTextSchema, kind: KnowledgeKindSchema,
  content: KnowledgeContentSchema, evidence: KnowledgeEvidenceSchema, impact: KnowledgeImpactSchema.optional(),
}).strict();
export const InteractionRecordedFindingSchema = InteractionFindingSchema.extend({ recordedRevision: z.number().int().positive() });
const links = {
  jobIds: z.array(z.uuid()).max(500),
  workflowIds: z.array(z.string().regex(/^workflow_[a-f0-9-]{36}$/)).max(500),
};
const titleFields = { title: z.string().min(1).max(240).nullable(), titleOriginalChars: z.number().int().nonnegative(), titleTruncated: z.boolean() };
const importedMetadata = z.object({
  ...titleFields, cwd: cwd.nullable(), sourceStatus: KnowledgeTextSchema,
  updatedAt: timestamp.nullable(), origin: InteractionOriginSchema,
});

export const InteractionBeginSchema = z.object({
  threadId: identity.optional(), idempotencyKey: identity.optional(),
  projectId: KnowledgeProjectSchema.nullable().default(null), title: titleInput,
  cwd: cwd.nullable().default(null), intent: InteractionIntentSchema.default('conversation'),
  route: InteractionRouteSchema.default('direct'), objective: KnowledgeTextSchema.nullable().default(null),
  performanceScope: PerformanceScopeSchema.optional(),
  source: KnowledgeTextSchema, observedAt: timestamp.optional(), sourceRef: KnowledgeTextSchema.nullable().optional(),
}).strict().refine(input => Boolean(input.threadId || input.idempotencyKey), 'threadId or idempotencyKey is required.');

export const InteractionUpdateSchema = z.object({
  steering: IntentSchema.optional(),
  expectedRevision: z.number().int().positive(), source: KnowledgeTextSchema,
  observedAt: timestamp.optional(), sourceRef: KnowledgeTextSchema.nullable().optional(),
  title: titleInput.optional(), projectId: KnowledgeProjectSchema.nullable().optional(), cwd: cwd.nullable().optional(),
  intent: InteractionIntentSchema.optional(), route: InteractionRouteSchema.optional(),
  status: z.enum(['open', 'completed', 'blocked', 'cancelled']).optional(),
  objective: KnowledgeTextSchema.nullable().optional(), summary: KnowledgeTextSchema.nullable().optional(),
  performanceScope: PerformanceScopeSchema.optional(),
  evidence: z.array(KnowledgeTextSchema).max(50).default([]),
  findings: z.array(InteractionFindingSchema).max(50).default([]),
  jobIds: links.jobIds.default([]), workflowIds: links.workflowIds.default([]),
}).strict();

export const InteractionImportSchema = z.object({
  source: KnowledgeTextSchema, observedAt: timestamp,
  threads: z.array(z.object({
    threadId: identity, title: titleInput, cwd: cwd.nullable().default(null), sourceStatus: KnowledgeTextSchema,
    updatedAt: timestamp.nullable().default(null), sourceRef: KnowledgeTextSchema,
  }).strict()).max(500),
}).strict().refine(input => new Set(input.threads.map(thread => thread.threadId)).size === input.threads.length, 'Duplicate thread IDs in import.');

export const InteractionListSchema = z.object({
  threadId: identity.optional(), projectId: KnowledgeProjectSchema.nullable().optional(), status: InteractionStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().nonnegative().default(0),
}).strict();

export const InteractionRecordSchema = z.object({
  steering: IntentSchema.optional(),
  version: z.literal(1), id: InteractionIdSchema, revision: z.number().int().positive(),
  threadId: identity.nullable(), idempotencyKey: KnowledgeTextSchema.nullable(), projectId: KnowledgeProjectSchema.nullable(),
  ...titleFields, cwd: cwd.nullable(), intent: InteractionIntentSchema, route: InteractionRouteSchema, status: InteractionStatusSchema,
  objective: KnowledgeTextSchema.nullable(), summary: KnowledgeTextSchema.nullable(),
  performanceScope: PerformanceScopeSchema.optional(),
  evidence: z.array(KnowledgeTextSchema).max(1000), ...links,
  findings: z.array(InteractionRecordedFindingSchema).max(1000).default([]),
  origin: InteractionOriginSchema, createdAt: timestamp, updatedAt: timestamp, locallyUpdatedAt: timestamp.nullable(),
  imported: importedMetadata.nullable(),
  change: z.object({ kind: z.enum(['begin', 'update', 'import']), origin: InteractionOriginSchema, previousRevision: z.number().int().positive().nullable() }),
  artifactPath: z.string(),
});

export type InteractionBeginInput = z.input<typeof InteractionBeginSchema>;
export type InteractionUpdateInput = z.input<typeof InteractionUpdateSchema>;
export type InteractionImportInput = z.input<typeof InteractionImportSchema>;
export type InteractionListInput = z.input<typeof InteractionListSchema>;
export type InteractionRecord = z.output<typeof InteractionRecordSchema>;
export interface InteractionListResult { items: InteractionRecord[]; total: number; limit: number; offset: number; nextOffset: number | null; warnings: string[] }
export interface InteractionImportResult {
  imported: number; updated: number; unchanged: number;
  items: { id: string; threadId: string; revision: number; status: InteractionRecord['status']; action: 'imported' | 'updated' | 'unchanged' }[];
}

/** Conversation/direct-work records share immutable evidence files, never the execution queue. */
export class InteractionStore {
  private readonly files: KnowledgeFiles;
  constructor(readonly root: string) { this.files = new KnowledgeFiles(root); }

  static idFor(input: { threadId?: string | null; idempotencyKey?: string | null }): string {
    const key = input.threadId ? ['thread', identity.parse(input.threadId)] : ['key', identity.parse(input.idempotencyKey)];
    return 'interaction_' + KnowledgeFiles.hash(JSON.stringify(key)).slice(0, 32);
  }

  async begin(raw: InteractionBeginInput): Promise<InteractionRecord> {
    const input = InteractionBeginSchema.parse(raw), id = InteractionStore.idFor(input);
    const existing = await this.current(id);
    if (existing && existing.status !== 'imported') return existing;
    const now = new Date().toISOString(), origin = this.origin(input, now);
    const record = existing ? {
      ...existing, ...(existing.locallyUpdatedAt === null ? {
        ...this.title(input.title), projectId: input.projectId, cwd: input.cwd ?? existing.cwd,
        intent: input.intent, route: input.route, objective: input.objective, performanceScope: input.performanceScope,
      } : {}), status: 'open' as const,
      revision: existing.revision + 1, updatedAt: now, locallyUpdatedAt: now,
      change: { kind: 'begin' as const, origin, previousRevision: existing.revision },
    } : this.initial(id, {
      threadId: input.threadId ?? null, idempotencyKey: input.idempotencyKey ? EvidenceSanitizer.text(input.idempotencyKey, 200) : null,
      projectId: input.projectId, ...this.title(input.title), cwd: input.cwd, intent: input.intent,
      route: input.route, objective: input.objective, performanceScope: input.performanceScope, origin,
    }, 'open', now);
    try { return await this.publish(record); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const winner = await this.read(id);
      if (winner.status === 'imported') throw new Error('Interaction revision conflict; re-read and begin again.');
      return winner;
    }
  }

  async read(id: string, revision?: number): Promise<InteractionRecord> {
    InteractionIdSchema.parse(id);
    if (revision !== undefined) z.number().int().positive().parse(revision);
    const record = revision === undefined ? await this.current(id) : await this.files.read(this.revisionPath(id, revision), InteractionRecordSchema);
    if (!record) throw new Error('Interaction not found: ' + id);
    if (record.id !== id || (revision !== undefined && record.revision !== revision)) throw new Error('Interaction identity differs from its record.');
    return record;
  }

  async list(raw: InteractionListInput = {}): Promise<InteractionListResult> {
    const input = InteractionListSchema.parse(raw), records: InteractionRecord[] = [], warnings: string[] = [];
    for (const id of await this.files.names('artifacts/interactions')) {
      if (!InteractionIdSchema.safeParse(id).success) continue;
      try {
        const record = await this.read(id);
        if (input.threadId !== undefined && record.threadId !== input.threadId) continue;
        if (input.projectId !== undefined && record.projectId !== input.projectId) continue;
        if (input.status !== undefined && record.status !== input.status) continue;
        records.push(record);
      } catch (error) { warnings.push(EvidenceSanitizer.text(id + ': ' + String(error), 2000)); }
    }
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const items = records.slice(input.offset, input.offset + input.limit);
    return { items, total: records.length, limit: input.limit, offset: input.offset,
      nextOffset: input.offset + items.length < records.length ? input.offset + items.length : null, warnings };
  }

  async update(id: string, raw: InteractionUpdateInput): Promise<InteractionRecord> {
    const input = InteractionUpdateSchema.parse(raw), existing = await this.read(id);
    if (input.expectedRevision !== existing.revision) throw new Error('Interaction revision conflict; re-read before updating.');
    if(input.steering&&['question','example','continuation'].includes(input.steering.kind)) {
      for(const key of ['projectId','objective'] as const)if(input[key]!==undefined&&input[key]!==existing[key])throw new Error('Question, example or continuation preserves the active project and objective; use a sourced request or correction for a change');
      if(['question','example'].includes(input.steering.kind)&&input.status!==undefined&&input.status!==existing.status)throw new Error('A question or example does not end or suspend active work');
    }
    const now = new Date().toISOString();
    const { expectedRevision: _revision, source: _source, observedAt: _observed, sourceRef: _ref,
      title: newTitle, evidence, findings, jobIds, workflowIds, ...fields } = input;
    const mergedFindings = new Map(existing.findings.map(finding => [finding.id, finding]));
    for (const finding of findings) {
      const prior = mergedFindings.get(finding.id);
      if (prior) {
        const { recordedRevision: _recordedRevision, ...original } = prior;
        if (JSON.stringify(original) !== JSON.stringify(finding)) throw new Error('Interaction finding ID is already bound to different input: ' + finding.id);
      } else mergedFindings.set(finding.id, { ...finding, recordedRevision: existing.revision + 1 });
    }
    const record: InteractionRecord = {
      ...existing, ...fields, ...(newTitle === undefined ? {} : this.title(newTitle)),
      evidence: [...new Set([...existing.evidence, ...evidence])],
      findings: [...mergedFindings.values()],
      jobIds: [...new Set([...existing.jobIds, ...jobIds])], workflowIds: [...new Set([...existing.workflowIds, ...workflowIds])],
      revision: existing.revision + 1, updatedAt: now, locallyUpdatedAt: now,
      change: { kind: 'update', origin: this.origin(input, now), previousRevision: existing.revision },
    };
    try { return await this.publish(record); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Interaction revision conflict; no update was overwritten.'); throw error; }
  }

  async importThreads(raw: InteractionImportInput): Promise<InteractionImportResult> {
    const input = InteractionImportSchema.parse(raw), result: InteractionImportResult = { imported: 0, updated: 0, unchanged: 0, items: [] };
    for (const thread of input.threads) {
      const id = InteractionStore.idFor(thread), existing = await this.current(id), now = new Date().toISOString();
      const metadata = { ...this.title(thread.title), cwd: thread.cwd, sourceStatus: thread.sourceStatus,
        updatedAt: thread.updatedAt, origin: this.origin({ ...input, sourceRef: thread.sourceRef }, now) };
      const sameMetadata = existing?.imported && JSON.stringify({ ...existing.imported, origin: { ...existing.imported.origin, observedAt: '' } })
        === JSON.stringify({ ...metadata, origin: { ...metadata.origin, observedAt: '' } });
      const older = existing?.imported && (Date.parse(metadata.origin.observedAt) < Date.parse(existing.imported.origin.observedAt)
        || (metadata.updatedAt && existing.imported.updatedAt && Date.parse(metadata.updatedAt) < Date.parse(existing.imported.updatedAt)));
      let record: InteractionRecord, action: InteractionImportResult['items'][number]['action'];
      if (existing && (sameMetadata || older)) { record = existing; action = 'unchanged'; }
      else {
        record = existing ? {
          ...existing,
          ...(existing.locallyUpdatedAt === null ? { ...this.title(thread.title), cwd: thread.cwd } : {}),
          imported: metadata, revision: existing.revision + 1, updatedAt: now,
          change: { kind: 'import', origin: metadata.origin, previousRevision: existing.revision },
        } : { ...this.initial(id, {
          threadId: thread.threadId, idempotencyKey: null, projectId: null, ...this.title(thread.title), cwd: thread.cwd,
          intent: 'conversation', route: 'direct', objective: null, origin: metadata.origin,
        }, 'imported', now), imported: metadata };
        try { record = await this.publish(record); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Interaction import revision conflict; retry this metadata import.'); throw error; }
        action = existing ? 'updated' : 'imported';
      }
      result[action]++;
      result.items.push({ id, threadId: thread.threadId, revision: record.revision, status: record.status, action });
    }
    return result;
  }

  private title(value: string | null): Pick<InteractionRecord, 'title' | 'titleOriginalChars' | 'titleTruncated'> {
    if (value === null) return { title: null, titleOriginalChars: 0, titleTruncated: false };
    const sanitized = EvidenceSanitizer.text(value.trim(), 1_000_000);
    return { title: sanitized.slice(0, 240), titleOriginalChars: value.length, titleTruncated: sanitized.length > 240 };
  }
  private origin(input: { source: string; observedAt?: string; sourceRef?: string | null }, now: string) {
    return InteractionOriginSchema.parse({ source: input.source, observedAt: input.observedAt ?? now, sourceRef: input.sourceRef ?? null });
  }
  private initial(id: string, fields: Pick<InteractionRecord, 'threadId' | 'idempotencyKey' | 'projectId' | 'title' | 'titleOriginalChars' | 'titleTruncated' | 'cwd' | 'intent' | 'route' | 'objective' | 'origin' | 'performanceScope'>,
    status: 'imported' | 'open', now: string): InteractionRecord {
    return { version: 1, id, revision: 1, ...fields, status, summary: null, evidence: [], findings: [], jobIds: [], workflowIds: [],
      createdAt: now, updatedAt: now, locallyUpdatedAt: status === 'open' ? now : null, imported: null,
      change: { kind: status === 'open' ? 'begin' : 'import', origin: fields.origin, previousRevision: null }, artifactPath: this.revisionPath(id, 1) };
  }
  private revisionPath(id: string, revision: number) { return `artifacts/interactions/${id}/revision-${String(revision).padStart(8, '0')}.json`; }
  private async current(id: string): Promise<InteractionRecord | null> {
    InteractionIdSchema.parse(id);
    const names = (await this.files.names(`artifacts/interactions/${id}`)).filter(name => /^revision-\d{8}\.json$/.test(name));
    const latest = names.at(-1);
    if (!latest) return null;
    const record = await this.files.read(`artifacts/interactions/${id}/${latest}`, InteractionRecordSchema);
    if (record.id !== id || record.artifactPath !== this.revisionPath(id, record.revision)
      || latest !== `revision-${String(record.revision).padStart(8, '0')}.json`) throw new Error('Interaction revision identity mismatch.');
    return record;
  }
  private async publish(record: InteractionRecord): Promise<InteractionRecord> {
    const parsed = InteractionRecordSchema.parse({ ...record, artifactPath: this.revisionPath(record.id, record.revision) });
    await this.files.writeJsonNew(parsed.artifactPath, parsed);
    return parsed;
  }
}
