import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { InteractionEntry } from '../src/interaction-entry.js';
import { StateStore } from '../src/state.js';

test('read-only conversation entry leaves no files, persistence reuses identity and does not create a queue', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-entry-'));
  const entry = new InteractionEntry(root);
  const interaction = { threadId: randomUUID(), title: 'Conversation', source: 'owner request' };
  const preview = await entry.enter({ interaction, persist: false });
  assert.equal(preview.interaction, null);
  assert.deepEqual(await fs.readdir(root), []);
  const opened = await entry.enter({ interaction });
  assert.equal(opened.dispatchStarted, false);
  assert.equal(opened.projectContext, null);
  const repeat = await entry.enter({ interaction });
  assert.equal(repeat.interaction!.id, opened.interaction!.id);
  assert.equal(repeat.interaction!.revision, 1);
  const done = await entry.record(opened.interaction!.id, { expectedRevision: 1, source: 'local result', status: 'completed', summary: 'Answer delivered' });
  assert.equal(done.revision, 2);
  await assert.rejects(fs.access(path.join(root, 'state/jobs.sqlite')));
});

test('entry verifies execution links and rejects cross-project links without writing a revision', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-entry-'));
  await fs.mkdir(path.join(root, 'profiles'));
  await fs.writeFile(path.join(root, 'profiles/registry.json'), JSON.stringify({ version: 1, projects: [
    { id: 'fixture', name: 'Fixture', root, status: 'active', stack: [], modes: ['read-only'], sourceRoots: [], sources: [], checks: [] },
  ] }));
  const state = new StateStore(path.join(root, 'state/jobs.sqlite'));
  let job;
  try { job = state.create({ projectId: 'another', objective: 'fixture only', mode: 'read-only', profileHash: 'fixture', idempotencyKey: 'fixture' }); }
  finally { state.close(); }
  const entry = new InteractionEntry(root);
  const opened = await entry.enter({ interaction: { threadId: randomUUID(), title: 'Direct', source: 'owner', projectId: 'fixture' }, includeProjectContext: false });
  await assert.rejects(entry.record(opened.interaction!.id, { expectedRevision: 1, source: 'reported', jobIds: [job.id] }), /another project/);
  assert.equal((await entry.interactions.read(opened.interaction!.id)).revision, 1);
});
