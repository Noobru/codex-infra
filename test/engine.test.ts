import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TaskEngine} from '../src/engine.js';
import {CodexWorker} from '../src/codex-worker.js';

async function fixture(t: TestContext, worker?: Pick<CodexWorker,'run'>) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'infra-engine-'));
  await fs.mkdir(path.join(root,'profiles'));
  await fs.writeFile(path.join(root,'context.md'),'initial context');
  await fs.writeFile(path.join(root,'profiles/registry.json'),JSON.stringify({version:1,projects:[{
    id:'test',name:'Test',aliases:['alias'],root,status:'active',stack:['node'],modes:['read-only'],sourceRoots:[],
    sources:[{path:'context.md',label:'test',kind:'reference'}],checks:[
      {id:'pass',executable:process.execPath,args:['--version'],readOnly:true},
      {id:'fail',executable:process.execPath,args:['-e','process.exit(3)'],readOnly:true},
    ]}]}));
  const engine=new TaskEngine(root,worker);
  t.after(async()=>{engine.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,engine};
}
test('job preserves its original contract, validates real checks and is idempotent after completion',async t=>{
  const {root,engine}=await fixture(t);
  const input={project:'alias',objective:'Verify Node runtime',idempotencyKey:'same',mode:'read-only' as const,kind:'checks' as const,checkIds:['pass']};
  const job=await engine.prepare(input);
  await fs.writeFile(path.join(root,'context.md'),'changed after preparation');
  assert.equal((await engine.prepare(input)).id,job.id);
  const saved=JSON.parse(await fs.readFile(path.join(engine.artifactDir(job.id),'manifest.json'),'utf8'));
  assert.equal(saved.context.sources[0].excerpt,'initial context');
  await assert.rejects(engine.prepare({...input,checkIds:['fail']}),/different execution contract/);
  const completed=await engine.run(job.id);
  assert.equal(completed.status,'completed'); assert.match(completed.result!,/does not certify/);
  assert.deepEqual(await engine.run(job.id),completed);
  assert.equal(engine.state.events(job.id).filter(e=>e.toStatus==='validating').length,1);
});
test('a successful model answer cannot override a failed acceptance check',async t=>{
  const {engine}=await fixture(t,{run:async()=>({status:'completed',summary:'Model claims success'})});
  const job=await engine.prepare({project:'test',objective:'Read diagnostics',idempotencyKey:'failure',mode:'read-only',kind:'codex',checkIds:['fail']});
  assert.equal((await engine.run(job.id)).status,'failed');
  const evidence=JSON.parse(await fs.readFile(path.join(engine.artifactDir(job.id),'attempt-1/checks.json'),'utf8'));
  assert.equal(evidence[0].exitCode,3);
  await assert.rejects(engine.run(job.id),/explicit retry/);
});

test('a task pins explicit criteria and regenerates current context for the worker',async t=>{
 let received:any;
 const {root,engine}=await fixture(t,{run:async input=>{received=JSON.parse(input.context);return {status:'completed',summary:'Inspected source'};}});
 const input={project:'test',objective:'Inspect reference',idempotencyKey:'pack',mode:'read-only' as const,kind:'codex' as const,checkIds:['pass'],taskDetails:{acceptanceCriteria:['Read current context'],requiredSourceLabels:['test']}};
 const job=await engine.prepare(input);
 await assert.rejects(engine.prepare({...input,taskDetails:{acceptanceCriteria:['Changed acceptance']}}),/different execution contract/);
 await fs.writeFile(path.join(root,'context.md'),'fresh current source');
 assert.equal((await engine.run(job.id)).status,'completed');
 assert.equal(received.contextPack.sources[0].excerpt,'fresh current source');
 assert.equal(received.taskContract.acceptance.human,'not-recorded');
 const prepared=JSON.parse(await fs.readFile(path.join(engine.artifactDir(job.id),'context-pack.json'),'utf8'));
 assert.equal(prepared.sources[0].excerpt,'initial context');
});

test('a corrective retry includes prior failed checks and retains its attempt provenance',async t=>{
 let received:any;
 const {engine}=await fixture(t,{run:async input=>{received=JSON.parse(input.context);return {status:'completed',summary:'Inspected the controlled fixture'};}});
 const job=await engine.prepare({project:'test',objective:'Diagnose the fixture failure',idempotencyKey:'feedback',mode:'read-only',kind:'codex',checkIds:['fail']});
 assert.equal((await engine.run(job.id)).status,'failed');
 engine.retry(job.id);
 assert.equal((await engine.run(job.id)).status,'failed');
 assert.equal(received.previousAttempt.attempt,1);
 assert.equal(received.previousAttempt.checks[0].checkId,'fail');
 assert.equal(received.previousAttempt.checks[0].exitCode,3);
 assert.ok(received.previousAttempt.evidenceRefs.includes('attempt-1/checks.json'));
 const policy=JSON.parse(await fs.readFile(path.join(engine.artifactDir(job.id),'attempt-2/policy.json'),'utf8'));
 assert.ok(policy.effects.some((effect:any)=>effect.action==='check:fail'));
 assert.equal(engine.state.get(job.id).attempts,2);
});

test('open validation decision permits independent model work but parks the affected validation',async t=>{
 let called=0;
 const {engine}=await fixture(t,{run:async()=>{called++;return {status:'completed',summary:'Independent inspection complete'};}});
 const job=await engine.prepare({project:'test',objective:'Inspect before a material validation choice',idempotencyKey:'decision',mode:'read-only',kind:'codex',checkIds:['pass'],taskDetails:{openDecisions:[{id:'validation-choice',question:'Choose acceptance evidence',stage:'validation'}]}});
 assert.equal((await engine.run(job.id)).status,'waiting_user');assert.equal(called,1);
 const policy=JSON.parse(await fs.readFile(path.join(engine.artifactDir(job.id),'attempt-1/policy.json'),'utf8'));
 assert.ok(policy.effects.some((effect:any)=>effect.action==='validation'&&effect.decision==='deny'));
 assert.equal(policy.effects.some((effect:any)=>effect.action==='check:pass'),false);
});

test('legacy model tasks and unactivated restored projects never silently dispatch',async t=>{
 let called=0;
 const {root,engine}=await fixture(t,{run:async()=>{called++;return {status:'completed',summary:'Unexpected execution'};}});
 const input={project:'test',objective:'Controlled task',idempotencyKey:'legacy',mode:'read-only' as const,kind:'codex' as const,checkIds:['pass']};
 const job=await engine.prepare(input);
 const manifestPath=path.join(engine.artifactDir(job.id),'manifest.json');
 const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));delete manifest.routing;
 await fs.writeFile(manifestPath,JSON.stringify(manifest));
 await assert.rejects(engine.run(job.id),/Legacy model task/);
 assert.equal(called,0);assert.equal(engine.state.get(job.id).attempts,0);
 await fs.mkdir(path.join(root,'recovery'));
 await fs.writeFile(path.join(root,'recovery/RESTORE.json'),JSON.stringify({requiresReconciliation:false,dispatchEnabled:true,activatedProjectIds:['other']}));
 await assert.rejects(engine.run(job.id),/not activated/);
 await assert.rejects(engine.prepare({...input,idempotencyKey:'new'}),/not activated/);
});
test('cancellation keeps the active lock until the worker confirms shutdown',async t=>{
  let started!:()=>void; const ready=new Promise<void>(resolve=>{started=resolve;});
  let released!:()=>void; const release=new Promise<void>(resolve=>{released=resolve;});
  const {engine}=await fixture(t,{run:async input=>{
    started();
    await new Promise<void>(resolve=>input.signal!.addEventListener('abort',()=>resolve(),{once:true}));
    await release;
    return {status:'cancelled',summary:'Worker stopped'};
  }});
  const job=await engine.prepare({project:'test',objective:'Read diagnostics',idempotencyKey:'cancel',mode:'read-only',kind:'codex',checkIds:['pass']});
  const running=engine.run(job.id); await ready;
  assert.equal((await engine.cancel(job.id)).status,'running');
  assert.equal(engine.state.get(job.id).ownerPid,process.pid);
  released(); assert.equal((await running).status,'cancelled');
  assert.equal(engine.state.get(job.id).ownerPid,null);
});

test('unconfirmed worker shutdown retains the lock until an explicit evidenced confirmation',async t=>{
  const {engine}=await fixture(t,{run:async()=>({status:'failed',summary:'Transport did not confirm shutdown',cleanupFailed:true})});
  const job=await engine.prepare({project:'test',objective:'Read diagnostics',idempotencyKey:'cleanup',mode:'read-only',kind:'codex',checkIds:['pass']});
  assert.equal((await engine.run(job.id)).status,'running');
  assert.deepEqual(engine.state.reconcile(()=>false),[]);
  assert.throws(()=>engine.retry(job.id),/Illegal/);
  await assert.rejects(engine.confirmProcessesStopped(job.id,''),/evidence/);
  assert.equal((await engine.confirmProcessesStopped(job.id,'Fixture owns no process; simulated cleanup failure reviewed')).status,'waiting_user');
  assert.equal(engine.retry(job.id).status,'ready');
});

test('unconfirmed check shutdown retains its validating lock',async t=>{
  const {engine}=await fixture(t);
  engine.registry.check=async()=>({checkId:'pass',executable:process.execPath,args:[],cwd:engine.root,exitCode:null,stdout:'',stderr:'',durationMs:1,cleanupFailed:true});
  const job=await engine.prepare({project:'test',objective:'Read diagnostics',idempotencyKey:'check-cleanup',mode:'read-only',kind:'checks',checkIds:['pass']});
  assert.equal((await engine.run(job.id)).status,'validating');
  assert.deepEqual(engine.state.reconcile(()=>false),[]);
});

test('explicit fresh-thread retry ignores cancellation of an older attempt',async t=>{
  const {engine}=await fixture(t,{run:async input=>{
    assert.equal(input.threadId,undefined);
    assert.equal(input.signal?.aborted,false);
    return {status:'completed',summary:'New thread inspected current files'};
  }});
  const job=await engine.prepare({project:'test',objective:'Read diagnostics',idempotencyKey:'retry',mode:'read-only',kind:'codex',checkIds:['pass']});
  engine.state.claim(job.id,process.pid);
  engine.state.transition(job.id,'running',{threadId:'lost-session'});
  await engine.cancel(job.id);
  engine.state.transition(job.id,'waiting_user');
  assert.equal(engine.retry(job.id,true).threadId,null);
  const result=await engine.run(job.id);
  assert.equal(result.status,'completed'); assert.equal(result.attempts,2);
});

test('validation targets the context after the worker and supplies a recoverable attempt artifact location',async t=>{
 const {root,engine}=await fixture(t,{run:async()=>({status:'completed',summary:'Fixture advanced the candidate commit'})});
 let contexts=0;
 const originalContext=engine.registry.context.bind(engine.registry);
 engine.registry.context=async profile=>{
   const context=await originalContext(profile);
   return {...context,git:{...context.git,head: (++contexts<3?'a':'b').repeat(40)}};
 };
 const job=await engine.prepare({project:'test',objective:'Validate the resulting commit',idempotencyKey:'target',mode:'read-only',kind:'codex',checkIds:['pass']});
 engine.registry.check=async (_profile,checkId,_mode,options)=>{
   assert.equal(options?.execution?.targetSha,'b'.repeat(40));
   assert.equal(options?.execution?.jobId,job.id);
   assert.equal(options?.execution?.attempt,1);
   assert.equal(options?.execution?.artifactDir,path.join(engine.artifactDir(job.id),'attempt-1/check-1'));
   return {checkId,executable:'fixture',args:[],cwd:root,exitCode:0,stdout:'',stderr:'',durationMs:0};
 };
 assert.equal((await engine.run(job.id)).status,'completed');
 const captured=JSON.parse(await fs.readFile(path.join(engine.artifactDir(job.id),'attempt-1/validation-context.json'),'utf8'));
 assert.equal(captured.git.head,'b'.repeat(40));
});

