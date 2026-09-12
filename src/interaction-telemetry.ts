import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { InteractionIdSchema, InteractionStore, type InteractionRecord } from './interactions.js';
import { PerformanceScopeSchema } from './performance-scope.js';
import { KnowledgeFiles, KnowledgeHashSchema, KnowledgeProjectSchema } from './knowledge-store.js';
import { atomicWriteJson, readJson } from './legacy/command-os-utils.js';

export const InteractionTelemetryConfigSchema = z.object({ sessionsRoot: z.string().min(1).refine(path.isAbsolute, 'sessionsRoot must be absolute.') }).strict();
const count = z.number().int().nonnegative().nullable();
export const InteractionTokenDeltaSchema = z.object({
  inputTokens: count, cachedInputTokens: count, cacheWriteInputTokens: count,
  outputTokens: count, reasoningOutputTokens: count, totalTokens: count,
});
export const InteractionTelemetryReceiptSchema = z.object({
  version: z.literal(1), interactionId: InteractionIdSchema, threadId: z.uuid(), turnId: z.uuid(),
  projectId: KnowledgeProjectSchema.nullable(), interactionRevision: z.number().int().positive().nullable(),
  performanceScope: PerformanceScopeSchema.nullable(),
  assignment: z.enum(['interaction-revision', 'not-recorded-at-turn-time']),
  status: z.enum(['complete', 'partial', 'unknown']), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(),
  tokens: InteractionTokenDeltaSchema.nullable(),
  coverage: z.object({ baselineObserved: z.boolean(), terminalObserved: z.boolean(), tokenEvents: z.number().int().nonnegative(),
    duplicateEvents: z.number().int().nonnegative(), counterResets: z.number().int().nonnegative(), limited: z.boolean() }),
  epoch: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
  source: z.object({ kind: z.literal('codex-rollout-token-count/v1'), fingerprint: KnowledgeHashSchema,
    startLine: z.number().int().positive(), endLine: z.number().int().positive(), cursor: z.number().int().nonnegative() }),
  capturedAt: z.iso.datetime(), artifactPath: z.string(), warnings: z.array(z.string()),
});
export type InteractionTelemetryReceipt = z.output<typeof InteractionTelemetryReceiptSchema>;
type Tokens = z.output<typeof InteractionTokenDeltaSchema>;
type Event = { type: 'session_meta' | 'turn_context' | 'task_started' | 'task_complete' | 'token_count';
  timestamp: string; id?: string; tokens?: Tokens; line: number; cursor: number; invalid?: boolean };
type Snapshot = { tokens: Tokens; line: number; cursor: number };
type TurnCapture = { id: string; startedAt: string; finishedAt: string | null; startLine: number;
  endLine: number; cursor: number; baseline: Snapshot | null; last: Snapshot | null; epoch: number; endEpoch: number;
  tokenEvents: number; duplicateEvents: number; counterResets: number; limited: boolean; warnings: string[]; fingerprint: string };

const limits = { fileBytes: 128 * 1024 * 1024, lineBytes: 2 * 1024 * 1024, lines: 200_000, filenames: 20_000, receipts: 2000 };
const tokenKeys = { inputTokens: 'input_tokens', cachedInputTokens: 'cached_input_tokens', cacheWriteInputTokens: 'cache_write_input_tokens',
  outputTokens: 'output_tokens', reasoningOutputTokens: 'reasoning_output_tokens', totalTokens: 'total_tokens' } as const;

/** Opt-in derivation from one registered Desktop thread. No transcript, account quota or source path is persisted. */
export class InteractionTelemetry {
  private readonly files: KnowledgeFiles;
  constructor(readonly root: string) { this.files = new KnowledgeFiles(root); }

  async capture(threadId: string) {
    z.uuid().parse(threadId);
    const configured = await this.configuration();
    if (!configured.config) return { enabled: false, turnReceipts: [] as InteractionTelemetryReceipt[], warnings: configured.warnings };
    const id = InteractionStore.idFor({ threadId });
    const interaction = await new InteractionStore(this.root).read(id);
    if (interaction.threadId !== threadId || interaction.locallyUpdatedAt === null || interaction.status === 'imported') {
      throw new Error('Telemetry requires a locally entered, explicitly registered thread identity.');
    }
    const warnings: string[] = [];
    let source: string | null;
    try { source = await this.locate(configured.config.sessionsRoot, threadId, warnings); }
    catch { return { enabled: true, turnReceipts: [] as InteractionTelemetryReceipt[], warnings: ['Registered thread rollout could not be located.'] }; }
    if (!source) return { enabled: true, turnReceipts: [] as InteractionTelemetryReceipt[], warnings };
    const history = await this.history(interaction.id);
    const scanned = await this.scan(source, threadId);
    warnings.push(...scanned.warnings);
    const turnReceipts: InteractionTelemetryReceipt[] = [];
    for (const turn of scanned.turns) {
      const revision = [...history].reverse().find(record => Date.parse(record.updatedAt) <= Date.parse(turn.startedAt));
      const safeDelta = turn.baseline !== null && turn.last !== null && turn.counterResets === 0 && !turn.limited;
      const tokens = safeDelta ? this.delta(turn.baseline!.tokens, turn.last!.tokens) : null;
      const complete = turn.finishedAt !== null && safeDelta && tokens !== null && Object.values(tokens).some(value=>value!==null);
      const status = complete ? 'complete' : turn.finishedAt === null || turn.limited ? 'partial' : 'unknown';
      const record = InteractionTelemetryReceiptSchema.parse({
        version: 1, interactionId: interaction.id, threadId, turnId: turn.id, projectId: revision?.projectId ?? null,
        interactionRevision: revision?.revision ?? null, performanceScope: revision?.performanceScope ?? null,
        assignment: revision ? 'interaction-revision' : 'not-recorded-at-turn-time', status, startedAt: turn.startedAt, finishedAt: turn.finishedAt,
        tokens, coverage: { baselineObserved: turn.baseline !== null, terminalObserved: turn.finishedAt !== null,
          tokenEvents: turn.tokenEvents, duplicateEvents: turn.duplicateEvents, counterResets: turn.counterResets, limited: turn.limited },
        epoch: { start: turn.epoch, end: turn.endEpoch },
        source: { kind: 'codex-rollout-token-count/v1', fingerprint: turn.fingerprint,
          startLine: turn.startLine, endLine: turn.endLine, cursor: turn.cursor },
        capturedAt: new Date().toISOString(), artifactPath: this.receiptPath(interaction.id, turn.id, !complete),
        warnings: [...turn.warnings, ...(!turn.baseline ? ['No preceding token snapshot; cumulative usage was not attributed to this turn.'] : []),
          ...(!turn.finishedAt ? ['Turn is still open; usage covers only observed token events.'] : []),
          ...(turn.counterResets ? ['Token counters reset or decreased; usage across that boundary is unknown.'] : [])],
      });
      try { turnReceipts.push(await this.persist(record)); }
      catch { warnings.push(`Turn ${turn.id}: derived telemetry receipt could not be saved.`); }
    }
    return { enabled: true, turnReceipts, warnings: [...new Set(warnings)] };
  }

  /** Explicit producer replay: close earlier turns from a bounded recent set, never inventory-only imports. */
  async reconcile(raw: { limit?: number } = {}) {
    const { limit } = z.object({ limit: z.number().int().min(1).max(10).default(10) }).strict().parse(raw);
    const configured = await this.configuration();
    if (!configured.config) return { enabled: false, turnReceipts: [] as InteractionTelemetryReceipt[], warnings: configured.warnings,
      coverage: { inspected: 0, selected: 0, captured: 0, limit, truncated: false } };
    const listed = await new InteractionStore(this.root).list({ limit: 100 });
    const eligible = listed.items.filter(item => item.locallyUpdatedAt !== null && item.status !== 'imported' && z.uuid().safeParse(item.threadId).success);
    const selected = eligible.slice(0, limit), warnings = [...listed.warnings], turnReceipts: InteractionTelemetryReceipt[] = [];
    let captured = 0;
    for (const interaction of selected) {
      try {
        const result = await this.capture(interaction.threadId!);
        captured++; turnReceipts.push(...result.turnReceipts); warnings.push(...result.warnings);
      } catch { warnings.push(`Interaction ${interaction.id}: telemetry replay could not be completed.`); }
    }
    const truncated = listed.nextOffset !== null || eligible.length > selected.length;
    if (truncated) warnings.push('Telemetry replay covered only the bounded recent interaction set.');
    return { enabled: true, turnReceipts, warnings: [...new Set(warnings)],
      coverage: { inspected: listed.items.length, selected: selected.length, captured, limit, truncated } };
  }

  /** Dashboard path: only existing derived receipts are read; source rollouts are never scanned here. */
  async read(raw: { projectId?: string; days?: number } = {}) {
    const options = z.object({ projectId: KnowledgeProjectSchema.optional(), days: z.number().int().min(1).max(3650).optional() }).strict().parse(raw);
    const configured = await this.configuration(), warnings = [...configured.warnings];
    const turnReceipts: InteractionTelemetryReceipt[] = [];
    const cutoff = options.days === undefined ? -Infinity : Date.now() - options.days * 86400000;
    let inspected = 0, truncated = false;
    for (const interactionId of await this.files.names('artifacts/telemetry')) {
      if (!InteractionIdSchema.safeParse(interactionId).success) continue;
      const directory = `artifacts/telemetry/${interactionId}`;
      const names = await this.files.names(directory), completed = new Set(names.filter(name => /^turn-[a-f0-9-]{36}\.json$/.test(name)));
      for (const name of names) {
        if (!/^turn-[a-f0-9-]{36}(?:\.partial)?\.json$/.test(name)) continue;
        if (name.endsWith('.partial.json') && completed.has(name.replace('.partial.json', '.json'))) continue;
        if (++inspected > limits.receipts) { truncated = true; break; }
        try {
          const receipt = await this.files.read(`${directory}/${name}`, InteractionTelemetryReceiptSchema);
          if (receipt.interactionId !== interactionId || receipt.artifactPath !== `${directory}/${name}`) throw new Error('Receipt identity mismatch');
          if (options.projectId !== undefined && receipt.projectId !== options.projectId) continue;
          if (Date.parse(receipt.finishedAt ?? receipt.startedAt) < cutoff) continue;
          turnReceipts.push(receipt);
        } catch { warnings.push('One derived telemetry receipt is unavailable or invalid.'); }
      }
      if (truncated) break;
    }
    if (truncated) warnings.push('Derived telemetry inventory exceeded the read limit.');
    turnReceipts.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.turnId.localeCompare(b.turnId));
    return { enabled: configured.config !== null, turnReceipts, warnings: [...new Set(warnings)], truncated };
  }

  private async configuration(): Promise<{ config: z.output<typeof InteractionTelemetryConfigSchema> | null; warnings: string[] }> {
    try {
      const file = path.join(this.root, 'profiles/telemetry.local.json');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Invalid telemetry configuration');
      return { config: InteractionTelemetryConfigSchema.parse(await readJson(file, null)), warnings: [] };
    } catch (error) {
      return { config: null, warnings: (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : ['Local telemetry opt-in configuration is invalid or unavailable.'] };
    }
  }

  private async locate(root: string, threadId: string, warnings: string[]): Promise<string | null> {
    const found: string[] = []; let visited = 0, limited = false;
    const walk = async (directory: string, depth: number): Promise<void> => {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      const entries = await fs.opendir(directory);
      for await (const entry of entries) {
        if (++visited > limits.filenames) { limited = true; return; }
        if (entry.isSymbolicLink()) continue;
        if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${threadId}.jsonl`)) found.push(path.join(directory, entry.name));
        if (entry.isDirectory() && depth < 3 && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) await walk(path.join(directory, entry.name), depth + 1);
        if (limited || found.length > 1) return;
      }
    };
    await walk(root, 0);
    if (limited) warnings.push('Session filename inventory exceeded the read limit; no ambiguous source was selected.');
    else if (found.length !== 1) warnings.push(found.length ? 'More than one rollout matches this registered thread; source selection is ambiguous.' : 'No rollout filename matches the registered thread.');
    return !limited && found.length === 1 ? found[0]! : null;
  }

  private async history(id: string): Promise<InteractionRecord[]> {
    const names = (await this.files.names(`artifacts/interactions/${id}`)).filter(name => /^revision-\d{8}\.json$/.test(name));
    if (names.length > limits.receipts) throw new Error('Interaction revision history exceeds the telemetry read limit.');
    const records: InteractionRecord[] = [];
    const store = new InteractionStore(this.root);
    for (const name of names) records.push(await store.read(id, Number(name.slice(9, 17))));
    return records.sort((a, b) => a.revision - b.revision);
  }

  private async scan(file: string, threadId: string) {
    const turns: TurnCapture[] = [], warnings: string[] = [];
    let active: TurnCapture | null = null, previous: Snapshot | null = null, epoch = 0, sessionConfirmed = false;
    let fingerprint = KnowledgeFiles.hash('codex-rollout-token-count/v1'), parseLimited = false;
    const snapshot = await fs.stat(file);
    const capped = snapshot.size > limits.fileBytes;
    const end = Math.min(snapshot.size, limits.fileBytes);
    let currentLine = 0, cursor = 0, lineBytes = 0, parts: Buffer[] = [], oversized = false;
    const consume = (raw: string | null) => {
      currentLine++;
      if (currentLine > limits.lines) { parseLimited = true; return; }
      if (raw === null) { parseLimited = true; if (active) active.limited = true; return; }
      const relevant = /"type"\s*:\s*"(?:session_meta|turn_context)"/.test(raw)
        || /"payload"\s*:\s*\{\s*"type"\s*:\s*"(?:task_started|task_complete|token_count)"/.test(raw);
      if (!relevant) return;
      let event: Event | null;
      try { event = this.event(JSON.parse(raw), currentLine, cursor); }
      catch { parseLimited = true; if (active) active.limited = true; return; }
      if (!event) return;
      if (event.type === 'session_meta') {
        if (event.id !== threadId) throw new Error('Rollout session identity differs from the registered thread.');
        sessionConfirmed = true;
      }
      if (!sessionConfirmed) throw new Error('Rollout session identity is not confirmed.');
      fingerprint = KnowledgeFiles.hash(fingerprint + JSON.stringify(event));
      if (event.type === 'task_started') {
        if (!event.id) { parseLimited = true; return; }
        if (active) { active.limited = true; active.warnings.push('A new turn started before the preceding turn was closed.'); }
        active = { id: event.id, startedAt: event.timestamp, finishedAt: null, startLine: event.line,
          endLine: event.line, cursor: event.cursor, baseline: previous, last: null, epoch, endEpoch: epoch,
          tokenEvents: 0, duplicateEvents: 0, counterResets: 0, limited: parseLimited, warnings: [], fingerprint };
        turns.push(active);
      } else if (event.type === 'turn_context' && active && event.id !== active.id) {
        active.limited = true; active.warnings.push('Turn context identity differs from the active turn.');
      } else if (event.type === 'token_count') {
        if (!event.tokens || event.invalid) { if (active) active.limited = true; previous = null; return; }
        const reset = previous !== null && (Object.keys(tokenKeys) as (keyof Tokens)[]).some(key => event.tokens![key] !== null && previous!.tokens[key] !== null && event.tokens![key]! < previous!.tokens[key]!);
        const duplicate = previous !== null && JSON.stringify(previous.tokens) === JSON.stringify(event.tokens);
        if (reset) epoch++;
        const current = { tokens: event.tokens, line: event.line, cursor: event.cursor };
        if (active) {
          active.tokenEvents++; active.duplicateEvents += duplicate ? 1 : 0; active.counterResets += reset ? 1 : 0;
          active.last = current; active.endEpoch = epoch;
        }
        previous = current;
      } else if (event.type === 'task_complete') {
        if (!active || event.id !== active.id) { parseLimited = true; return; }
        active.finishedAt = event.timestamp;
      }
      if (active) { active.endLine = event.line; active.cursor = event.cursor; active.fingerprint = fingerprint; }
      if (event.type === 'task_complete') active = null;
    };
    try {
      if (end > 0) for await (const chunk of createReadStream(file, { start: 0, end: end - 1, highWaterMark: 64 * 1024 })) {
        const bytes = chunk as Buffer;
        let start = 0;
        while (start < bytes.length) {
          const newline = bytes.indexOf(10, start), stop = newline === -1 ? bytes.length : newline;
          const piece = bytes.subarray(start, stop); lineBytes += piece.length;
          if (lineBytes <= limits.lineBytes && !oversized) parts.push(piece); else { oversized = true; parts = []; }
          cursor += stop - start + (newline === -1 ? 0 : 1);
          if (newline !== -1) {
            consume(oversized ? null : Buffer.concat(parts).toString('utf8'));
            parts = []; lineBytes = 0; oversized = false;
            if (currentLine >= limits.lines) { parseLimited = true; break; }
          }
          start = stop + 1;
        }
        if (currentLine >= limits.lines) break;
      }
      // A trailing incomplete line may be concurrently written. It is not parsed or treated as a final event.
      if (lineBytes > 0) parseLimited = true;
      if (!sessionConfirmed) throw new Error('Missing session identity');
    } catch { return { turns: [] as TurnCapture[], warnings: ['Registered rollout could not be read with a confirmed session identity.'] }; }
    if (capped || parseLimited) {
      warnings.push('Rollout read reached a byte/line limit, invalid metadata or an incomplete line; coverage is partial.');
      for (const turn of turns) if (turn.finishedAt === null) turn.limited = true;
    }
    return { turns, warnings };
  }

  private event(raw: unknown, line: number, cursor: number): Event | null {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> }, payload = value.payload;
    if (!payload || typeof payload !== 'object') return null;
    const type = value.type === 'event_msg' ? payload.type : value.type;
    if (!['session_meta', 'turn_context', 'task_started', 'task_complete', 'token_count'].includes(String(type))) return null;
    const timestamp = z.iso.datetime().parse(value.timestamp);
    if (type === 'token_count') {
      const info = payload.info && typeof payload.info === 'object' ? payload.info as Record<string, unknown> : null;
      const usage = info?.total_token_usage && typeof info.total_token_usage === 'object' ? info.total_token_usage as Record<string, unknown> : null;
      if (!usage) return { type, timestamp, line, cursor, invalid: true };
      let invalid = false;
      const tokens = Object.fromEntries(Object.entries(tokenKeys).map(([key, source]) => {
        const item = usage[source]; if (item != null && (!Number.isSafeInteger(item) || (item as number) < 0)) invalid = true;
        return [key, typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 ? item : null];
      })) as Tokens;
      return { type, timestamp, tokens, line, cursor, invalid };
    }
    return { type: type as Event['type'], timestamp, id: z.uuid().parse(type === 'session_meta' ? payload.id : payload.turn_id), line, cursor };
  }

  private delta(before: Tokens, after: Tokens): Tokens {
    return Object.fromEntries((Object.keys(tokenKeys) as (keyof Tokens)[]).map(key => [key,
      before[key] === null || after[key] === null || after[key]! < before[key]! ? null : after[key]! - before[key]!,
    ])) as Tokens;
  }

  private receiptPath(interactionId: string, turnId: string, partial: boolean) {
    return `artifacts/telemetry/${interactionId}/turn-${turnId}${partial ? '.partial' : ''}.json`;
  }

  private async persist(receipt: InteractionTelemetryReceipt): Promise<InteractionTelemetryReceipt> {
    const completePath = this.receiptPath(receipt.interactionId, receipt.turnId, false);
    const names = await this.files.names(`artifacts/telemetry/${receipt.interactionId}`);
    if (names.includes(path.basename(completePath))) return this.files.read(completePath, InteractionTelemetryReceiptSchema);
    if (receipt.status === 'complete') {
      try { await this.files.writeJsonNew(completePath, receipt); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      return this.files.read(completePath, InteractionTelemetryReceiptSchema);
    }
    if (names.includes(path.basename(receipt.artifactPath))) {
      const existing = await this.files.read(receipt.artifactPath, InteractionTelemetryReceiptSchema);
      if (JSON.stringify({ ...existing, capturedAt: '' }) === JSON.stringify({ ...receipt, capturedAt: '' })) return existing;
      await atomicWriteJson(await this.files.file(receipt.artifactPath), receipt);
    } else {
      try { await this.files.writeJsonNew(receipt.artifactPath, receipt); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    return receipt;
  }
}
