import assert from 'node:assert/strict';
import test from 'node:test';
import { AppServerClient, AppServerError } from '../src/app-server.js';

// Each test launches only this inline JSONL fixture, never Codex or a model.
function fixture(body = '', timeout = 2_000): AppServerClient {
  const script = `
    const readline = require('node:readline');
    const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
    let initialized = false;
    readline.createInterface({input: process.stdin}).on('line', line => {
      const message = JSON.parse(line);
      if(message.method === 'initialize') return send({id:message.id,result:{userAgent:'fixture'}});
      if(message.method === 'initialized') {initialized = true; return;}
      ${body}
    });
  `;
  return new AppServerClient({ command: process.execPath, args: ['-e', script], requestTimeoutMs: timeout });
}

test('initializes once, correlates out-of-order requests and streams notifications', async t => {
  const client = fixture(`
    if(message.method === 'echo') {
      if(!initialized) throw Error('handshake missing');
      setTimeout(() => {
        send({method:'turn/started',params:{value:message.params.value}});
        send({id:message.id,result:message.params});
      }, message.params.delay);
    }
  `);
  t.after(() => client.close());
  const values: number[] = [];
  const unsubscribe = client.onNotification((method, params) => { if(method === 'turn/started') values.push(params.value); });
  await Promise.all([client.connect(), client.connect()]);
  const results = await Promise.all([
    client.request('echo', { value: 1, delay: 30 }),
    client.request('echo', { value: 2, delay: 0 }),
  ]);
  assert.deepEqual(results, [{ value: 1, delay: 30 }, { value: 2, delay: 0 }]);
  assert.deepEqual(values, [2, 1]);
  unsubscribe();
  await client.request('echo', { value: 3, delay: 0 });
  assert.deepEqual(values, [2, 1]);
});

test('surfaces RPC code without retaining sensitive server error text', async t => {
  const client = fixture(`send({id:message.id,error:{code:429,message:'secret@example.com sk-private'}});`);
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.request('failure'), error => {
    assert.ok(error instanceof AppServerError);
    assert.equal(error.code, 429);
    assert.ok(!error.message.includes('secret@example.com'));
    return true;
  });
});

test('decodes JSONL split across chunks including a multibyte character', async t => {
  const client = fixture(`
    const payloadBytes = Buffer.from(JSON.stringify({id:message.id,result:{text:'ação'}}) + '\\n');
    const split = payloadBytes.indexOf(Buffer.from('ç')) + 1;
    process.stdout.write(payloadBytes.subarray(0, split));
    setTimeout(() => process.stdout.write(payloadBytes.subarray(split)), 10);
  `);
  t.after(() => client.close());
  await client.connect();
  assert.deepEqual(await client.request('split'), { text: 'ação' });
});

test('times out requests and closes outstanding work', async t => {
  const client = fixture('', 150);
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.request('timeout'), { code: 'REQUEST_TIMEOUT' });
  const pending = assert.rejects(client.request('pending'), { code: 'CLOSED' });
  await client.close();
  await pending;
  await assert.rejects(client.connect(), { code: 'CLOSED' });
});

test('process exit rejects pending requests without logging stderr', async t => {
  const client = fixture(`process.stderr.write('secret@example.com sk-private'); process.exit(7);`);
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.request('exit'), error => {
    assert.ok(error instanceof AppServerError);
    assert.equal(error.code, 'PROCESS_EXIT');
    assert.ok(!error.message.includes('sk-private'));
    return true;
  });
});

test('malformed JSON rejects pending work', async t => {
  const client = fixture(`process.stdout.write('not json\\n');`);
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.request('malformed'), { code: 'PROTOCOL_ERROR' });
});

test('rejects server approval requests and reports the need for user input', async t => {
  const client = fixture(`
    if(message.method === 'approval') {
      global.replyId = message.id;
      send({id:'approval-1',method:'item/commandExecution/requestApproval',params:{command:'sensitive command'}});
    } else if(message.id === 'approval-1') send({id:global.replyId,result:message});
  `);
  t.after(() => client.close());
  const notices: unknown[] = [];
  client.onServerRequest(notice => notices.push(notice));
  client.onNotification(() => { throw Error('observer failure'); });
  await client.connect();
  const response = await client.request<{ error: { code: number }; result?: unknown }>('approval');
  assert.equal(response.error.code, -32004);
  assert.equal(response.result, undefined);
  assert.equal(notices.length, 1);
  assert.ok(!JSON.stringify(notices).includes('sensitive command'));
});

test('account probe returns only plan and sanitized quota fields', async t => {
  const client = fixture(`
    if(message.method === 'account/read') send({id:message.id,result:{account:{type:'chatgpt',planType:'pro',email:'private@example.com',id:'private-id'}}});
    if(message.method === 'account/rateLimits/read') send({id:message.id,result:{
      rateLimits:{limitId:'codex',primary:{usedPercent:93,windowDurationMins:10080,resetsAt:123,email:'private@example.com'}},
      rateLimitsByLimitId:{codex:{limitId:'codex',secondary:{usedPercent:93,windowDurationMins:10080,resetsAt:123}}},
      rateLimitResetCredits:{credits:[{id:'private-reset-credit'}]}
    }});
  `);
  t.after(() => client.close());
  const account = await client.probeAccount();
  assert.equal(account.type, 'chatgpt');
  assert.equal(account.planType, 'pro');
  const serialized = JSON.stringify(account);
  assert.ok(serialized.includes('10080'));
  assert.ok(!serialized.includes('private'));
});

test('account probe refuses API key auth and preserves unauthenticated status', async t => {
  const api = fixture(`send({id:message.id,result:{account:{type:'apiKey'}}});`);
  const none = fixture(`send({id:message.id,result:{account:null}});`);
  t.after(() => Promise.all([api.close(), none.close()]));
  await assert.rejects(api.probeAccount(), { code: 'AUTH_MODE_REFUSED' });
  assert.deepEqual(await none.probeAccount(), { type: null, rateLimits: null });
});

test('child environment omits API credentials while preserving existing login location', async t => {
  const previousKey = process.env.OPENAI_API_KEY;
  const existingLoginLocation = process.env.CODEX_HOME ?? null;
  process.env.OPENAI_API_KEY = 'test-only-placeholder';
  const client = fixture(`send({id:message.id,result:{hasKey:!!process.env.OPENAI_API_KEY,home:process.env.CODEX_HOME ?? null}});`);
  try {
    await client.connect();
  } finally {
    if(previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
  t.after(() => client.close());
  assert.deepEqual(await client.request('environment'), { hasKey: false, home: existingLoginLocation });
});

test('spawn errors reject initialization and close cleanly', async () => {
  const client = new AppServerClient({ command: 'codex-infra-fixture-does-not-exist' });
  await assert.rejects(client.connect(), { code: 'PROCESS_ERROR' });
  await client.close();
});
