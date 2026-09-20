import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TaskEngine} from '../src/engine.js';
import {WorkCoordinator} from '../src/work-coordinator.js';
import {InteractionStore} from '../src/interactions.js';
import type {CodexWorker} from '../src/codex-worker.js';
import {fixtureQualification} from './qualification-fixture.js';
import {DEFAULT_ROUTING_CONFIGURATION} from '../src/routing.js';

async function fixture(t:TestContext,worker?:Pick<CodexWorker,'run'>){
  const parent=fileURLToPath(new URL('../../artifacts/test-fixtures/',import.meta.url));await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'work-unit-'));
  await fs.mkdir(path.join(root,'profiles'));await fs.writeFile(path.join(root,'context.md'),'Owned routing fixture.');
  await fs.writeFile(path.join(root,'verify.cjs'),"const fs=require('fs'); const v=JSON.parse(fs.readFileSync('result.json','utf8')); if(v.answer!==42||v.completed!==true)process.exit(1);");
  await fs.writeFile(path.join(root,'profiles/registry.json'),JSON.stringify({version:1,projects:[{id:'test',name:'Test',root,status:'active',modes:['read-only','workspace-write'],stack:['node'],sourceRoots:[],sources:[{path:'context.md',label:'fixture',kind:'reference'}],checks:[{id:'functional',executable:process.execPath,args:['verify.cjs'],readOnly:true}]}]}));
  const engine=new TaskEngine(root,worker),work=new WorkCoordinator(engine),interactions=new InteractionStore(root);
  const interaction=await interactions.begin({threadId:'00000000-0000-4000-8000-000000000001',title:null,projectId:'test',intent:'work',objective:'Produce fixture result',source:'Authorized fixture'});
  t.after(async()=>{engine.close();if(path.dirname(root)!==path.resolve(parent))throw new Error('Unexpected fixture target');await fs.rm(root,{recursive:true,force:true});});
  const input={interactionId:interaction.id,expectedRevision:1,unitId:'slice',objective:'Compute 6 times 7 into result.json',mode:'workspace-write' as const,routing:fixtureQualification,
    decisionEvidence:['verify.cjs validates answer and completed state'],recoveryReason:'Owner authorized one repair of a local fixture',checkIds:['functional'],
    taskDetails:{outcomeCriteria:[{id:'answer',kind:'check' as const,checkId:'functional',description:'Functional output is 42 and completed'}],resolution:{maxAttempts:2,source:'Fixture authorization',actions:[{id:'repair',instruction:'Finish the saved fixture result without repeating completed work',triggers:['worker-blocked' as const],causes:['environment' as const]}]}}};
  return {root,engine,work,interactions,interaction,input};
}

test('governed slice preserves worker progress, recovers by cause, verifies functional output and deduplicates usage',async t=>{
  let calls=0;const f=await fixture(t,{run:async input=>{
    calls++;input.onProgress?.({threadId:'fixture-worker',turnId:'turn-'+calls});
    if(calls===1){await fs.writeFile(path.join(input.cwd,'partial.txt'),'prepared');return {status:'blocked',summary:'Prepared partial.txt; local dependency missing',threadId:'fixture-worker',blocker:{kind:'recoverable',cause:'environment',reason:'Missing owned fixture',evidence:['partial.txt'],nextAction:'Complete fixture',recoveryActionId:'repair'},receipt:{model:'gpt-5.6-sol',tokenUsageScope:'thread-cumulative',tokenUsage:{totalTokens:100,inputTokens:80,cachedInputTokens:20,outputTokens:20}}};}
    const context=JSON.parse(input.context);assert.match(context.previousAttempt.progress.summary,/partial.txt/);assert.equal(input.threadId,'fixture-worker');assert.equal(context.recovery.actionId,'repair');
    assert.equal(context.contextPack.unchangedSources,true);
    assert.equal(await fs.readFile(path.join(input.cwd,'partial.txt'),'utf8'),'prepared');
    await fs.writeFile(path.join(input.cwd,'result.json'),JSON.stringify({answer:42,completed:true}));
    return {status:'completed',summary:'Output verified by host',threadId:'fixture-worker',receipt:{model:'gpt-5.6-sol',tokenUsageScope:'thread-cumulative',tokenUsage:{totalTokens:160,inputTokens:120,cachedInputTokens:30,outputTokens:40}}};
  }});
  const prepared=await f.work.prepare(f.input);assert.equal(prepared.unit.route,'worker');
  const done=await f.work.run({interactionId:f.interaction.id,unitId:'slice',background:false,timeoutMs:20000});
  assert.equal(done.delivery?.outcomeStatus,'passed');assert.equal(done.job?.attempts,2);assert.equal(calls,2);
  const summary=await f.work.summary(f.interaction.id);assert.equal(summary.usage.unitWorkers.totals.totalTokens!.observed,160);assert.equal(summary.coverage.verified,1);
  assert.equal((await f.work.prepare(f.input)).job?.id,done.job?.id);
  await f.work.run({interactionId:f.interaction.id,unitId:'slice',background:false,timeoutMs:20000});assert.equal(calls,2);
});

test('direct work needs prospective rationale and declaration; verification executes real checks',async t=>{
  const f=await fixture(t);const input={...f.input,routing:{...fixtureQualification,contextCoupling:'high' as const,rationale:'Changes require inseparable parent state'}};
  const planned=await f.work.prepare(input);assert.equal(planned.job,null);assert.equal(planned.unit.route,'coordinator');
  await assert.rejects(f.work.run({interactionId:f.interaction.id,unitId:'slice',background:false,timeoutMs:20000}),/Record the direct result/);
  await fs.writeFile(path.join(f.root,'result.json'),JSON.stringify({answer:41,completed:true}));
  await f.work.recordDirect({interactionId:f.interaction.id,unitId:'slice',summary:'Claims completed',evidence:['result.json']});
  const result=await f.work.run({interactionId:f.interaction.id,unitId:'slice',background:false,timeoutMs:20000});
  assert.equal(result.job?.status,'failed');assert.equal(result.delivery?.outcomeStatus,'unverified');assert.equal(result.directExecution?.coverage,'reported-not-intercepted');
});

test('changed objective, stale revision and forged execution cannot reuse a planned decision',async t=>{
  const f=await fixture(t);await f.work.prepare(f.input);
  await assert.rejects(f.work.prepare({...f.input,objective:'Different objective'}),/different decision/);
  await assert.rejects(f.work.prepare({...f.input,unitId:'new',expectedRevision:2}),/revision conflict/);
  const unit=await f.work.units.read(f.interaction.id,'slice');
  await assert.rejects(f.engine.prepare({project:'test',objective:'Different objective',idempotencyKey:'forged',mode:'workspace-write',kind:'codex',checkIds:['functional'],routing:fixtureQualification,taskDetails:{...f.input.taskDetails,workUnit:f.work.units.ref(unit)}}),/differs from the planned/);
  await f.interactions.update(f.interaction.id,{expectedRevision:1,source:'pause',status:'blocked'});
  await assert.rejects(f.work.run({interactionId:f.interaction.id,unitId:'slice'}),/no longer active/);
});

test('approval is not repaired even when worker mislabels it recoverable',async t=>{
  let calls=0;const f=await fixture(t,{run:async()=>{calls++;return {status:'blocked',summary:'Approval needed',blocker:{kind:'recoverable',cause:'approval',reason:'Need approval',evidence:['approval receipt'],nextAction:'Review operation',recoveryActionId:'repair'}};}});
  await f.work.prepare(f.input);const done=await f.work.run({interactionId:f.interaction.id,unitId:'slice',background:false,timeoutMs:20000});
  assert.equal(calls,1);assert.equal(done.job?.status,'waiting_user');
  const resolution=JSON.parse(await fs.readFile(path.join(f.engine.artifactDir(done.job!.id),'resolution.json'),'utf8'));assert.match(resolution.reason,/Approval blockers/);
});

test('failed environment preflight stops before spending a model turn',async t=>{
  let calls=0;const f=await fixture(t,{run:async()=>{calls++;return {status:'completed',summary:'Should not run'};}});
  const input={...f.input,taskDetails:{...f.input.taskDetails,capabilities:[{id:'fixture-ready',kind:'deterministic' as const,purpose:'Verify fixture prerequisite before any model turn',stage:'execution' as const,checkId:'functional'}]}};
  await f.work.prepare(input);const done=await f.work.run({interactionId:f.interaction.id,unitId:'slice',background:false,timeoutMs:20000});
  assert.equal(calls,0);assert.equal(done.job?.status,'waiting_user');assert.equal(done.delivery?.blocker?.cause,'environment');
});

test('a recovery action for environment cannot repair a solution failure',async t=>{
  let calls=0;const f=await fixture(t,{run:async()=>{calls++;return {status:'blocked',summary:'Wrong algorithm',blocker:{kind:'recoverable',cause:'solution',reason:'Algorithm failed',evidence:['counterexample'],nextAction:'Requalify solution',recoveryActionId:'repair'}};}});
  await f.work.prepare(f.input);const result=await f.work.run({interactionId:f.interaction.id,unitId:'slice',background:false,timeoutMs:20000});
  assert.equal(calls,1);assert.equal(result.job?.status,'waiting_user');
  const receipt=JSON.parse(await fs.readFile(path.join(f.engine.artifactDir(result.job!.id),'resolution.json'),'utf8'));assert.match(receipt.reason,/does not cover/);
});

test('inadmissible worker placement is not silently retained by the coordinator',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.work.prepare({...f.input,routing:{...fixtureQualification,executionTarget:'worker',risk:'high',evidenceRefs:['fixture risk evidence']}}),/worker placement was not admitted/);
});

test('review: material steering invalidates an old decision even when objective text stays unchanged',async t=>{
  let calls=0;const f=await fixture(t,{run:async()=>{calls++;return {status:'completed',summary:'Should not run'};}});
  await f.work.prepare(f.input);
  await f.interactions.update(f.interaction.id,{expectedRevision:1,source:'owner-correction',steering:{kind:'correction',source:'owner',approvedPlanRefs:[],interpretation:'Do not write result.json until the revised constraint is qualified'}});
  await assert.rejects(f.work.run({interactionId:f.interaction.id,unitId:'slice',background:false,timeoutMs:20000}),/steering|decision/i);assert.equal(calls,0);
});

test('review: a bound job and its recovery preserve the pinned policy after configuration changes',async t=>{
  let calls=0;const f=await fixture(t,{run:async input=>{
    calls++;assert.deepEqual(input.routingPolicy,DEFAULT_ROUTING_CONFIGURATION);
    if(calls===1){await fs.writeFile(path.join(f.root,'profiles/model-routing.json'),JSON.stringify({...DEFAULT_ROUTING_CONFIGURATION,coordinator:{model:'gpt-6-astra',reasoningEffort:'high'}}));return {status:'blocked',summary:'Synthetic environment repair',blocker:{kind:'recoverable',cause:'environment',reason:'Fixture prerequisite',evidence:['fixture'],nextAction:'Finish fixture',recoveryActionId:'repair'}};}
    await fs.writeFile(path.join(input.cwd,'result.json'),JSON.stringify({answer:42,completed:true}));return {status:'completed',summary:'Done'};
  }});
  await f.work.prepare(f.input);
  await fs.writeFile(path.join(f.root,'profiles/model-routing.json'),JSON.stringify({...DEFAULT_ROUTING_CONFIGURATION,coordinator:{model:'gpt-6-astra',reasoningEffort:'low'}}));
  const done=await f.work.run({interactionId:f.interaction.id,unitId:'slice',background:false,timeoutMs:20000});assert.equal(done.delivery?.outcomeStatus,'passed');assert.equal(calls,2);
});

test('review: later coordinator turns on a worker thread survive deduplication; uncertain overlap stays visible',async t=>{
  const threadId='00000000-0000-4000-8000-000000000001';
  const f=await fixture(t,{run:async input=>{await fs.writeFile(path.join(input.cwd,'result.json'),JSON.stringify({answer:42,completed:true}));return {status:'completed',summary:'done',threadId,turnId:'00000000-0000-4000-8000-000000000011',receipt:{model:'gpt-5.6-sol',finishedAt:'2026-09-20T12:00:10.000Z',tokenUsageScope:'thread-cumulative',tokenUsage:{totalTokens:100,inputTokens:80,cachedInputTokens:20,outputTokens:20}}};}});
  await f.work.prepare(f.input);await f.work.run({interactionId:f.interaction.id,unitId:'slice',background:false,timeoutMs:20000});
  const directory=`artifacts/telemetry/${f.interaction.id}`;await fs.mkdir(path.join(f.root,directory),{recursive:true});
  for(const [suffix,start,finish] of [['012','12:00:11','12:00:12'],['013','12:00:09','12:00:12'],['011','12:00:01','12:00:09']]){
    const turnId='00000000-0000-4000-8000-'+suffix!.padStart(12,'0'),artifactPath=`${directory}/turn-${turnId}.json`;
    await fs.writeFile(path.join(f.root,artifactPath),JSON.stringify({version:1,interactionId:f.interaction.id,threadId,turnId,projectId:'test',interactionRevision:1,performanceScope:null,modelIdentity:{model:'gpt-6-astra',effort:'high'},assignment:'interaction-revision',status:'complete',startedAt:`2026-09-20T${start}.000Z`,finishedAt:`2026-09-20T${finish}.000Z`,tokens:{totalTokens:20,inputTokens:10,cachedInputTokens:0,cacheWriteInputTokens:null,outputTokens:10,reasoningOutputTokens:null},coverage:{baselineObserved:true,terminalObserved:true,tokenEvents:1,duplicateEvents:0,counterResets:0,limited:false},epoch:{start:0,end:0},source:{kind:'codex-rollout-token-count/v1',fingerprint:'a'.repeat(64),startLine:1,endLine:2,cursor:200},capturedAt:'2026-09-20T12:00:13.000Z',artifactPath,warnings:[]}));
  }
  const summary=await f.work.summary(f.interaction.id);
  assert.equal(summary.usage.coordinator.totals.totalTokens!.observed,20);
  assert.equal(summary.usage.combined.totals.totalTokens!.observed,120);
  assert.equal((summary.usage as any).ambiguousOverlap.length,1);
});
