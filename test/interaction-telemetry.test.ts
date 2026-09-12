import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InteractionStore, type InteractionBeginInput } from '../src/interactions.js';
import { InteractionTelemetry } from '../src/interaction-telemetry.js';

const threadId = '11111111-1111-4111-8111-111111111111';
const otherThread = '11111111-1111-4111-8111-111111111112';
const turnId = '22222222-2222-4222-8222-222222222221';
const nextTurn = '22222222-2222-4222-8222-222222222222';
const at = (minute: number) => new Date(Date.UTC(2026, 8, 12, 12, minute)).toISOString();
const event = (type: string, minute: number, payload: object) => ({ timestamp: at(minute),
  type: ['session_meta', 'turn_context'].includes(type) ? type : 'event_msg', payload: { type, ...payload } });
const count = (total: number, minute: number, extra: object = {}) => event('token_count', minute, {
  info: { total_token_usage: { total_tokens: total, input_tokens: total - 10, output_tokens: 10,
    cached_input_tokens: Math.floor(total / 2), reasoning_output_tokens: 5, ...extra },
    last_token_usage: { total_tokens: 999_999 }, model_context_window: 1_000_000 },
  rate_limits: { private_marker: 'MUST-NOT-PERSIST' },
});

class TelemetryFixture {
  readonly telemetry: InteractionTelemetry;
  readonly store: InteractionStore;
  readonly sessions: string;
  constructor(readonly root: string) {
    this.telemetry = new InteractionTelemetry(root); this.store = new InteractionStore(root);
    this.sessions = path.join(root, 'source-sessions');
  }
  static async create(t: TestContext, configured = true) {
    const parent = fileURLToPath(new URL('../../artifacts/test-fixtures/', import.meta.url));
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'interaction-telemetry-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const fixture = new TelemetryFixture(root);
    if (configured) {
      await fs.mkdir(path.join(root, 'profiles'), { recursive: true });
      await fs.writeFile(path.join(root, 'profiles/telemetry.local.json'), JSON.stringify({ sessionsRoot: fixture.sessions }));
    }
    return fixture;
  }
  async enter(extra: Partial<InteractionBeginInput> = {}) {
    return this.store.begin({ threadId, title: 'Telemetry fixture', source: 'Explicit fixture entry', ...extra });
  }
  async revisionAt(id: string, revision: number, minute: number) {
    const record = await this.store.read(id, revision);
    await fs.writeFile(path.join(this.root, record.artifactPath), JSON.stringify({ ...record, updatedAt: at(minute),
      locallyUpdatedAt: at(minute), ...(revision === 1 ? { createdAt: at(minute) } : {}) }));
  }
  async source(events: object[], id = threadId) {
    const directory = path.join(this.sessions, '2026/09/12'); await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `rollout-2026-09-12T12-00-00-${id}.jsonl`);
    await fs.writeFile(file, events.map(value => JSON.stringify(value)).join('\n') + '\n');
    return file;
  }
  baseline() { return [event('session_meta', 0, { id: threadId, cwd: 'PRIVATE-SOURCE-PATH', prompt: 'PRIVATE-PROMPT' }), count(100, 1)]; }
  turn(id = turnId, start = 3) { return [event('task_started', start, { turn_id: id }),
    event('turn_context', start, { turn_id: id, developer_instructions: 'PRIVATE-INSTRUCTIONS' })]; }
  complete(id = turnId, finish = 5) { return event('task_complete', finish, { turn_id: id, last_agent_message: 'PRIVATE-RESPONSE' }); }
}

test('telemetry is disabled without opt-in and only explicitly entered thread identities can be captured', async t => {
  const disabled = await TelemetryFixture.create(t, false);
  assert.deepEqual(await disabled.telemetry.capture(threadId), { enabled: false, turnReceipts: [], warnings: [] });
  assert.equal((await disabled.telemetry.reconcile()).enabled, false);
  assert.deepEqual(await disabled.telemetry.read(), { enabled: false, turnReceipts: [], warnings: [], truncated: false });
  await assert.rejects(fs.access(path.join(disabled.root, 'artifacts')), { code: 'ENOENT' });
  const fixture = await TelemetryFixture.create(t);
  await assert.rejects(fixture.telemetry.capture(threadId), /Interaction not found/);
  await fixture.store.importThreads({ source: 'Metadata fixture', observedAt: at(0), threads: [{ threadId,
    title: 'Imported only', sourceStatus: 'idle', sourceRef: `codex://threads/${threadId}` }] });
  await assert.rejects(fixture.telemetry.capture(threadId), /locally entered/);
  const replay = await fixture.telemetry.reconcile();
  assert.equal(replay.coverage.selected, 0);
  await assert.rejects(fs.access(path.join(fixture.root, 'artifacts/telemetry')), { code: 'ENOENT' });
});

test('closed turn delta uses the preceding cumulative snapshot, ignores duplicates and stores only approved fields', async t => {
  const fixture = await TelemetryFixture.create(t), entry = await fixture.enter({ projectId: 'fixture',
    performanceScope: { taskClass: 'implementation', language: 'TypeScript', problemCategory: 'observability' } });
  await fixture.revisionAt(entry.id, 1, 2);
  await fixture.source([...fixture.baseline(), ...fixture.turn(),
    { type: 'response_item', timestamp: at(3), payload: { type: 'message', content: 'PRIVATE-TRANSCRIPT' } },
    count(100, 3), count(160, 4, { output_tokens: 20, reasoning_output_tokens: 10 }),
    count(160, 4, { output_tokens: 20, reasoning_output_tokens: 10 }), fixture.complete()]);
  await fixture.source([{ arbitrary: 'This other thread must not be parsed.' }], otherThread);
  const result = await fixture.telemetry.capture(threadId);
  assert.deepEqual(result.warnings, []); assert.equal(result.turnReceipts.length, 1);
  const receipt = result.turnReceipts[0]!;
  assert.equal(receipt.status, 'complete'); assert.equal(receipt.projectId, 'fixture'); assert.equal(receipt.interactionRevision, 1);
  assert.deepEqual(receipt.performanceScope, { taskClass: 'implementation', language: 'TypeScript', problemCategory: 'observability' });
  assert.deepEqual(receipt.tokens, { totalTokens: 60, inputTokens: 60, outputTokens: 10,
    cachedInputTokens: 30, reasoningOutputTokens: 5, cacheWriteInputTokens: null });
  assert.equal(receipt.coverage.duplicateEvents, 2); assert.equal(receipt.coverage.tokenEvents, 3);
  const file = path.join(fixture.root, receipt.artifactPath), raw = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(raw, /PRIVATE-|MUST-NOT-PERSIST|rate_limits|last_token_usage|source-sessions/);
  assert.match(receipt.source.fingerprint, /^[a-f0-9]{64}$/);
  const stat = await fs.stat(file), replay = await fixture.telemetry.capture(threadId);
  assert.deepEqual(replay.turnReceipts, result.turnReceipts);
  assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  assert.equal((await fixture.telemetry.read({ projectId: 'fixture' })).turnReceipts.length, 1);
  assert.equal((await fixture.telemetry.read({ projectId: 'other' })).turnReceipts.length, 0);
});

test('closed turns preserve observed input/output when total counter is absent',async t=>{
  const f=await TelemetryFixture.create(t);await f.enter();
  await f.source([event('session_meta',0,{id:threadId}),count(100,1,{total_tokens:undefined}),...f.turn(),count(160,4,{total_tokens:undefined,output_tokens:20}),f.complete()]);
  const receipt=(await f.telemetry.capture(threadId)).turnReceipts[0]!;
  assert.equal(receipt.status,'complete');assert.equal(receipt.tokens?.totalTokens,null);
  assert.equal(receipt.tokens?.inputTokens,60);assert.equal(receipt.tokens?.outputTokens,10);
});

test('open turn sidecar finalizes after close and complete receipts remain immutable on replay', async t => {
  const fixture = await TelemetryFixture.create(t); await fixture.enter();
  const events = [...fixture.baseline(), ...fixture.turn(), count(130, 4)];
  const file = await fixture.source(events);
  const partial = (await fixture.telemetry.capture(threadId)).turnReceipts[0]!;
  assert.equal(partial.status, 'partial'); assert.equal(partial.tokens!.totalTokens, 30);
  const partialFile = path.join(fixture.root, partial.artifactPath), stat = await fs.stat(partialFile);
  const repeat = await fixture.telemetry.capture(threadId);
  assert.deepEqual(repeat.turnReceipts[0], partial); assert.equal((await fs.stat(partialFile)).mtimeMs, stat.mtimeMs);
  await fs.appendFile(file, JSON.stringify(count(160, 4)) + '\n' + JSON.stringify(fixture.complete()) + '\n');
  const completed = (await fixture.telemetry.capture(threadId)).turnReceipts[0]!;
  assert.equal(completed.status, 'complete'); assert.equal(completed.tokens!.totalTokens, 60);
  assert.notEqual(completed.artifactPath, partial.artifactPath);
  assert.deepEqual((await fixture.telemetry.read()).turnReceipts, [completed]);
  const original = await fs.readFile(path.join(fixture.root, completed.artifactPath), 'utf8');
  await fixture.source([...fixture.baseline(), ...fixture.turn(), count(180, 4), fixture.complete()]);
  assert.deepEqual((await fixture.telemetry.capture(threadId)).turnReceipts, [completed]);
  assert.equal(await fs.readFile(path.join(fixture.root, completed.artifactPath), 'utf8'), original);
});

test('missing baseline and counter reset remain unknown, while a subsequent epoch can be measured', async t => {
  const fixture = await TelemetryFixture.create(t); await fixture.enter();
  await fixture.source([event('session_meta', 0, { id: threadId }), ...fixture.turn(), count(500_000, 4), fixture.complete(),
    ...fixture.turn(nextTurn, 6), count(20, 7), fixture.complete(nextTurn, 8)]);
  const captured = await fixture.telemetry.capture(threadId);
  assert.equal(captured.turnReceipts[0]!.status, 'unknown'); assert.equal(captured.turnReceipts[0]!.tokens, null);
  assert.equal(captured.turnReceipts[0]!.coverage.baselineObserved, false);
  assert.equal(captured.turnReceipts[1]!.status, 'unknown'); assert.equal(captured.turnReceipts[1]!.tokens, null);
  assert.equal(captured.turnReceipts[1]!.coverage.counterResets, 1);
  assert.deepEqual(captured.turnReceipts[1]!.epoch, { start: 0, end: 1 });
  const third = '22222222-2222-4222-8222-222222222223';
  const file = await fixture.source([event('session_meta', 0, { id: threadId }), count(500_000, 1), count(20, 2),
    ...fixture.turn(third, 9), count(40, 10), fixture.complete(third, 11)]);
  assert.ok(file); const recovered = (await fixture.telemetry.capture(threadId)).turnReceipts[0]!;
  assert.equal(recovered.status, 'complete'); assert.equal(recovered.tokens!.totalTokens, 20);
  assert.deepEqual(recovered.epoch, { start: 1, end: 1 });
});

test('historical turns retain the project and declared scope active at their start, with no retroactive assignment', async t => {
  const fixture = await TelemetryFixture.create(t), initial = await fixture.enter({ projectId: 'before',
    performanceScope: { taskClass: 'analysis', language: 'TypeScript' } });
  await fixture.revisionAt(initial.id, 1, 4);
  const updated = await fixture.store.update(initial.id, { expectedRevision: 1, source: 'Explicit project switch',
    projectId: 'after', performanceScope: { taskClass: 'implementation', language: 'Python' } });
  await fixture.revisionAt(initial.id, updated.revision, 8);
  const third = '22222222-2222-4222-8222-222222222223';
  await fixture.source([...fixture.baseline(), ...fixture.turn(turnId, 2), count(120, 3), fixture.complete(turnId, 3),
    ...fixture.turn(nextTurn, 5), count(140, 6), fixture.complete(nextTurn, 9),
    ...fixture.turn(third, 10), count(160, 11), fixture.complete(third, 12)]);
  const receipts = (await fixture.telemetry.capture(threadId)).turnReceipts;
  assert.equal(receipts[0]!.projectId, null); assert.equal(receipts[0]!.performanceScope, null);
  assert.equal(receipts[0]!.assignment, 'not-recorded-at-turn-time');
  assert.equal(receipts[1]!.projectId, 'before'); assert.equal(receipts[1]!.performanceScope!.language, 'TypeScript');
  assert.equal(receipts[1]!.interactionRevision, 1);
  assert.equal(receipts[2]!.projectId, 'after'); assert.equal(receipts[2]!.performanceScope!.language, 'Python');
  assert.equal(receipts[2]!.interactionRevision, 2);
});

test('source identity mismatch and ambiguous matching filenames produce warnings without receipts', async t => {
  const fixture = await TelemetryFixture.create(t); await fixture.enter();
  const file = await fixture.source([event('session_meta', 0, { id: otherThread }), ...fixture.turn(), count(100, 4), fixture.complete()]);
  const mismatch = await fixture.telemetry.capture(threadId);
  assert.equal(mismatch.turnReceipts.length, 0); assert.match(mismatch.warnings[0]!, /confirmed session identity/);
  await assert.rejects(fs.access(path.join(fixture.root, 'artifacts/telemetry')), { code: 'ENOENT' });
  await fs.copyFile(file, path.join(path.dirname(file), `rollout-second-${threadId}.jsonl`));
  const ambiguous = await fixture.telemetry.capture(threadId);
  assert.equal(ambiguous.turnReceipts.length, 0); assert.match(ambiguous.warnings[0]!, /ambiguous/);
});

test('oversized or incomplete source lines expose partial coverage instead of complete usage', async t => {
  const fixture = await TelemetryFixture.create(t); await fixture.enter();
  const file = await fixture.source([...fixture.baseline(), ...fixture.turn()]);
  await fs.appendFile(file, JSON.stringify({ type: 'response_item', payload: 'x'.repeat(2 * 1024 * 1024) }) + '\n'
    + JSON.stringify(count(130, 4)) + '\n' + JSON.stringify(fixture.complete()) + '\n' + '{"type":');
  const result = await fixture.telemetry.capture(threadId), receipt = result.turnReceipts[0]!;
  assert.equal(receipt.status, 'partial'); assert.equal(receipt.tokens, null); assert.equal(receipt.coverage.limited, true);
  assert.match(result.warnings[0]!, /coverage is partial/);
});

test('producer reconciliation is bounded and can finalize a preceding conversation without touching imports', async t => {
  const fixture = await TelemetryFixture.create(t); await fixture.enter();
  const file = await fixture.source([...fixture.baseline(), ...fixture.turn(), count(130, 4)]);
  await fixture.telemetry.capture(threadId);
  await fixture.store.importThreads({ source: 'Metadata fixture', observedAt: at(6), threads: [{ threadId: otherThread,
    title: 'Metadata only', sourceStatus: 'idle', sourceRef: `codex://threads/${otherThread}` }] });
  await fixture.source([{ arbitrary: 'Imported rollout must never be parsed.' }], otherThread);
  await fs.appendFile(file, JSON.stringify(fixture.complete()) + '\n');
  const result = await fixture.telemetry.reconcile({ limit: 1 });
  assert.deepEqual(result.coverage, { inspected: 2, selected: 1, captured: 1, limit: 1, truncated: false });
  assert.equal(result.turnReceipts[0]!.status, 'complete'); assert.deepEqual(result.warnings, []);
  await fs.rename(fixture.sessions, path.join(fixture.root, 'source-hidden'));
  assert.equal((await fixture.telemetry.read()).turnReceipts[0]!.status, 'complete');
});
