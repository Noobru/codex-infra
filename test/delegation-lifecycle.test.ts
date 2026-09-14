import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {StateStore} from '../src/state.js';
import {KnowledgeFiles} from '../src/knowledge-store.js';
import {DelegationLifecycle,AppServerWorkerArchive} from '../src/delegation-lifecycle.js';

test('finishing a delegation checks exact stopped worker, records failure and retries idempotently',async t=>{
  const parent=fileURLToPath(new URL('../../artifacts/test-fixtures/',import.meta.url));await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'delegation-lifecycle-'));
  const state=new StateStore(path.join(root,'state/jobs.sqlite'));
  t.after(async()=>{state.close();assert.ok(path.resolve(root).startsWith(path.resolve(parent)+path.sep));await fs.rm(root,{recursive:true,force:true});});
  const job=state.create({idempotencyKey:'worker',projectId:'fixture',objective:'Fixture worker',mode:'read-only',profileHash:'a'.repeat(64),executionKind:'codex'});
  await new KnowledgeFiles(root).writeJsonNew(`artifacts/jobs/${job.id}/manifest.json`,{kind:'codex'});
  const threadId=randomUUID();state.claim(job.id,process.pid);state.transition(job.id,'running',{threadId});
  const decision={expectedAttempt:1,threadId,integrated:true,author:{name:'Fixture coordinator',role:'model'},source:'Fixture integration',evidence:['Fixture result integrated']};
  let calls=0,fail=true;
  const lifecycle=new DelegationLifecycle(root,{async archive(id){assert.equal(id,threadId);calls++;if(fail)throw new Error('Fixture transport unavailable');}});
  await assert.rejects(lifecycle.finish(job.id,decision),/exact stopped/);assert.equal(calls,0);
  assert.equal(state.cancelPending(job.id).status,'running');
  state.transition(job.id,'failed',{error:'Fixture timeout'});
  await assert.rejects(lifecycle.finish(job.id,{...decision,threadId:randomUUID()}),/exact stopped/);
  await assert.rejects(lifecycle.finish(job.id,{...decision,integrated:false}));
  const pending=await lifecycle.finish(job.id,decision);assert.equal(pending.status,'pending');
  fail=false;const archived=await lifecycle.finish(job.id,decision);assert.equal(archived.status,'archived');
  assert.deepEqual(await lifecycle.finish(job.id,decision),archived);assert.equal(calls,2);
  assert.equal(state.get(job.id).status,'failed');assert.equal(state.get(job.id).error,'Fixture timeout');
  assert.ok((await new KnowledgeFiles(root).names(`artifacts/jobs/${job.id}/delegation`)).includes(path.basename(pending.artifactPath)));
});

test('already archived worker requires positive archived inventory evidence after protocol error',async()=>{
  const threadId=randomUUID();let listed=false,closed=0;
  const adapter=new AppServerWorkerArchive('fixture',()=>({async connect(){},async close(){closed++;},async request<T>(method:string){
    if(method==='thread/read')return {thread:{id:threadId,status:{type:'notLoaded'}}} as T;
    if(method==='thread/archive')throw new Error('already archived or unavailable');
    assert.equal(method,'thread/list');return {data:listed?[{id:threadId}]:[],nextCursor:null} as T;
  }}));
  await assert.rejects(adapter.archive(threadId),/unavailable/);
  listed=true;await adapter.archive(threadId);assert.equal(closed,2);
});
