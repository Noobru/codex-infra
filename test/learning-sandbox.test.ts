import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { LearningSandbox } from '../src/learning-sandbox.js';
import { ProcessRunner } from '../src/process.js';

test('sandbox availability fails closed for a missing local Docker client without running a capability', async () => {
  const sandbox = new LearningSandbox(process.cwd(), { dockerPath: path.join(process.cwd(), 'missing-fixture-docker-client') });
  const result = await sandbox.available(); assert.equal(result.available, false); assert.ok(result.reason);
});

test('sandbox rejects nonmaterialized entrypoints, host arguments and already cancelled runs before invoking Docker', async () => {
  const sandbox = new LearningSandbox(process.cwd(), { dockerPath: 'never-call-fixture-command' });
  const request = { workspace: process.cwd(), entrypoint: path.join(process.cwd(), 'package.json'), runtime: 'node' as const, args: [], timeoutMs: 1000 };
  await assert.rejects(sandbox.run(request), /materialized capability directory/);
  await assert.rejects(sandbox.run({ ...request, args: [path.resolve('host-file.txt')] }), /relative workspace paths/);
  await assert.rejects(sandbox.run({ ...request, signal: AbortSignal.abort() }), /cancelled before preparation/);
});

test('ProcessRunner complete environment override omits the host environment and retains the explicit values', async () => {
  const previous = process.env.INFRA_FIXTURE_HOST_VALUE;
  process.env.INFRA_FIXTURE_HOST_VALUE = 'must not be inherited';
  try {
    const result = await new ProcessRunner().run(process.execPath, ['-e', 'console.log(JSON.stringify({only:process.env.INFRA_FIXTURE_ONLY,host:process.env.INFRA_FIXTURE_HOST_VALUE??null}))'], process.cwd(), 3000,
      { env: { INFRA_FIXTURE_ONLY: 'owned fixture' } });
    assert.equal(result.exitCode, 0); assert.deepEqual(JSON.parse(result.stdout), { only: 'owned fixture', host: null });
  } finally { if (previous === undefined) delete process.env.INFRA_FIXTURE_HOST_VALUE; else process.env.INFRA_FIXTURE_HOST_VALUE = previous; }
});
