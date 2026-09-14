import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { TaskEngine } from '../src/engine.js';
import { SupervisorManager, type SupervisorReceipt } from '../src/supervisor.js';

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 15000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(50);
  }
  throw new Error('Fixture supervisor did not reach the expected state');
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'codexinfra-supervisor-'));
  await fs.mkdir(path.join(root, 'profiles'));
  await fs.writeFile(path.join(root, 'context.md'), 'Local supervisor test fixture');
  await fs.writeFile(path.join(root, 'profiles/registry.json'), JSON.stringify({ version: 1, projects: [{
    id: 'fixture', name: 'Fixture', aliases: [], root, status: 'active', stack: ['node'], modes: ['read-only'],
    sourceRoots: [], sources: [{ path: 'context.md', label: 'Fixture context', kind: 'reference' }],
    checks: [{ id: 'slow', executable: process.execPath, args: ['-e',
      "const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync('release-check')){clearInterval(timer);console.log('fixture check completed');}},50)"], readOnly: true, timeoutMs: 30000 }],
  }] }));
  const engine = new TaskEngine(root);
  const manager = new SupervisorManager(root);
  const receipts: SupervisorReceipt[] = [];
  t.after(async () => {
    for (const receipt of receipts) {
      await manager.cancel(receipt.id);
      // A terminal receipt precedes process exit; Windows still holds the cwd/logs until then.
      await until(() => manager.status(receipt.id), (value) => ['completed', 'stopped', 'failed', 'interrupted'].includes(value.state) && value.pidExists === false);
    }
    engine.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep + 'codexinfra-supervisor-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const prepare = (key: string) => engine.prepare({ project: 'fixture', objective: 'Run the authorized local fixture check',
    idempotencyKey: key, mode: 'read-only', kind: 'checks', checkIds: ['slow'] });
  return { root, engine, manager, receipts, prepare };
}

test('detached queue outlives its starting client and persists completed local evidence', async (t) => {
  const { root, engine, manager, receipts, prepare } = await fixture(t);
  const job = await prepare('survives-client');
  const moduleUrl = new URL('../src/supervisor.js', import.meta.url).href;
  const client = `import { SupervisorManager } from ${JSON.stringify(moduleUrl)};
    const receipt = await new SupervisorManager(process.argv[1]).start({maxJobs:1,totalTimeoutMs:7200000});
    process.stdout.write(JSON.stringify(receipt));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', client, root], {
    windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 10000,
  });
  const receipt = JSON.parse(stdout) as SupervisorReceipt;
  receipts.push(receipt);
  assert.ok(receipt.pid > 0);
  // execFile resolves only after the intermediate client has exited and closed its pipes.
  await until(async () => engine.state.get(job.id), (value) => value.status === 'validating');
  assert.equal((await manager.status(receipt.id)).state, 'running');
  await fs.writeFile(path.join(root,'release-check'),'Starting client exited; allow the detached check to finish.');
  const final = await until(() => manager.status(receipt.id), (value) => value.state === 'completed');
  assert.equal(final.result?.jobs[0]?.id, job.id);
  assert.equal(engine.state.get(job.id).status, 'completed');
  const checks = JSON.parse(await fs.readFile(path.join(engine.artifactDir(job.id), 'attempt-1/checks.json'), 'utf8'));
  assert.equal(checks[0].exitCode, 0);
  assert.match(checks[0].stdout, /fixture check completed/);
  await fs.access(path.join(receipt.path, 'result.json'));
  await fs.access(path.join(receipt.path, 'stdout.log'));
});

test('cooperative supervisor cancellation waits for active checks and leaves later jobs ready', async (t) => {
  const { engine, manager, receipts, prepare } = await fixture(t);
  const first = await prepare('cancel-first');
  const later = await prepare('leave-later');
  const receipt = await manager.start({ maxJobs: 2, totalTimeoutMs: 60000 });
  receipts.push(receipt);
  await until(async () => engine.state.get(first.id), (value) => value.status === 'validating');
  const requested = await manager.cancel(receipt.id);
  assert.equal(requested.cancelRequested, true);
  assert.equal(engine.state.get(first.id).status, 'validating');
  await until(async () => fs.access(path.join(engine.artifactDir(first.id),'cancel.json')).then(()=>true,()=>false), value=>value);
  const final = await until(() => manager.status(receipt.id), (value) => value.state === 'stopped');
  assert.equal(final.result?.stopReason, 'aborted');
  assert.equal(engine.state.get(first.id).status, 'cancelled');
  assert.equal(engine.state.get(first.id).ownerPid, null);
  assert.equal(engine.state.get(later.id).status, 'ready');
  assert.equal(engine.state.get(later.id).attempts, 0);
});
