import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TaskEngine} from '../src/engine.js';
import {WorkflowManager} from '../src/workflow.js';
import {OutcomeVerifier,OutcomeCriterionSchema} from '../src/outcome.js';
import {TaskContractBuilder} from '../src/task-contract.js';
import type {CodexWorker} from '../src/codex-worker.js';
import type {TaskBlocker} from '../src/delegation-contract.js';
import {ResolutionPolicySchema} from '../src/delegation-contract.js';
import {fixtureQualification} from './qualification-fixture.js';
import {EvaluationStore} from '../src/evaluation.js';

class DelegationFixture {
  constructor(readonly root:string,readonly engine:TaskEngine){}
  static async create(t:TestContext,worker?:Pick<CodexWorker,'run'>) {
    const parent=fileURLToPath(new URL('../../artifacts/test-fixtures/',import.meta.url));
    await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'delegation-'));
    await fs.mkdir(path.join(root,'profiles'));await fs.writeFile(path.join(root,'context.md'),'Approved fixture only.');
    await fs.writeFile(path.join(root,'profiles/registry.json'),JSON.stringify({version:1,projects:[{id:'test',name:'Test',root,status:'active',modes:['read-only','workspace-write'],stack:['node'],sourceRoots:[],sources:[{path:'context.md',label:'fixture',kind:'reference'}],checks:[{id:'node',executable:process.execPath,args:['--version'],readOnly:true}]}]}));
    const engine=new TaskEngine(root,worker);
    t.after(async()=>{engine.close();if(path.dirname(root)!==path.resolve(parent))throw new Error('Unexpected fixture cleanup target');await fs.rm(root,{recursive:true,force:true});});
    return new DelegationFixture(root,engine);
  }
  task(key:string) {return {project:'test',objective:key,idempotencyKey:key,mode:'workspace-write' as const,kind:'codex' as const,checkIds:['node'],routing:fixtureQualification};}
  resolution={source:'Owner authorized local fixture recovery',maxAttempts:3,actions:[{id:'repair',instruction:'Regenerate result.txt using the approved fixture routine, then verify it.',triggers:['worker-blocked','outcome-failed'] as ('worker-blocked'|'outcome-failed')[]}]};
  criterion={id:'result',description:'Report contains accepted fixture result',kind:'artifact' as const,path:'result.txt',contains:'accepted'};
  blocker:TaskBlocker={kind:'recoverable',reason:'Fixture result missing',evidence:['result.txt absent'],nextAction:'Regenerate local fixture result',recoveryActionId:'repair'};
}

test('first slice recovers a local blocker, validates the artifact and does not replay completed effects',async t=>{
  let calls=0;let fixture:DelegationFixture;
  fixture=await DelegationFixture.create(t,{run:async input=>{
    calls++;assert.equal(input.structuredBlockers,true);
    if(calls===1)return {status:'blocked',summary:'Missing fixture',blocker:fixture.blocker};
    const context=JSON.parse(input.context);assert.equal(context.recovery.actionId,'repair');assert.equal(context.recovery.fromAttempt,1);
    await fs.writeFile(path.join(input.cwd,'result.txt'),'accepted fixture result');
    return {status:'completed',summary:'Regenerated and inspected'};
  }});
  const job=await fixture.engine.prepare({...fixture.task('recover'),taskDetails:{resolution:fixture.resolution,outcomeCriteria:[fixture.criterion],intent:{kind:'continuation',source:'Owner approval',approvedPlanRefs:['PRD-approved'],interpretation:'Continue approved work'}}});
  const done=await fixture.engine.run(job.id);
  assert.equal(done.status,'completed');assert.equal(done.attempts,2);assert.equal(calls,2);
  const outcome=JSON.parse(await fs.readFile(path.join(fixture.engine.artifactDir(job.id),'attempt-2/outcome.json'),'utf8'));
  assert.equal(outcome.status,'passed');assert.match(outcome.criteria[0].evidence.sha256,/^[a-f0-9]{64}$/);
  assert.equal((await fixture.engine.run(job.id)).status,'completed');assert.equal(calls,2);
  assert.equal(JSON.parse(await fs.readFile(path.join(fixture.engine.artifactDir(job.id),'attempt-1/worker.json'),'utf8')).status,'blocked');
  assert.equal(JSON.parse(await fs.readFile(path.join(fixture.engine.artifactDir(job.id),'resolution.json'),'utf8')).reason,null);
});

test('unchanged blockers stop automatically and restart does not reset the recovery budget',async t=>{
  let calls=0;let fixture:DelegationFixture;
  fixture=await DelegationFixture.create(t,{run:async()=>{calls++;return {status:'blocked',summary:'Same failure',blocker:fixture.blocker};}});
  const job=await fixture.engine.prepare({...fixture.task('no-progress'),taskDetails:{resolution:fixture.resolution}});
  assert.equal((await fixture.engine.run(job.id)).status,'waiting_user');assert.equal(calls,2);
  assert.equal((await fixture.engine.run(job.id)).status,'waiting_user');assert.equal(calls,2);
  const resolution=JSON.parse(await fs.readFile(path.join(fixture.engine.artifactDir(job.id),'resolution.json'),'utf8'));
  assert.match(resolution.reason,/without new evidence/);
});

test('owner decisions and quota are never automatically repaired',async t=>{
  let calls=0;
  const fixture=await DelegationFixture.create(t,{run:async input=>{
    calls++;return input.objective==='quota'?{status:'quota',summary:'Quota exhausted'}:{status:'blocked',summary:'Package ready for approval',blocker:{kind:'owner-decision',reason:'Signature required',evidence:['Package ready'],nextAction:'Approve the prepared package',recoveryActionId:null}};
  }});
  const owner=await fixture.engine.prepare({...fixture.task('owner'),taskDetails:{resolution:fixture.resolution}});
  assert.equal((await fixture.engine.run(owner.id)).status,'waiting_user');assert.equal(calls,1);
  const quota=await fixture.engine.prepare({...fixture.task('quota'),taskDetails:{resolution:fixture.resolution}});
  assert.equal((await fixture.engine.run(quota.id)).status,'waiting_quota');assert.equal(calls,2);
});

test('independent workflow continues after a human decision and exposes the prepared next action',async t=>{
  const fixture=await DelegationFixture.create(t,{run:async input=>input.objective==='owner'?{status:'blocked',summary:'Decision prepared',blocker:{kind:'owner-decision',reason:'Need owner signature',evidence:['Decision package ready'],nextAction:'Review package and sign',recoveryActionId:null}}:{status:'completed',summary:'Independent work complete'}});
  const workflows=new WorkflowManager(fixture.engine);
  const plan=await workflows.prepare({idempotencyKey:'independent',objective:'Prepare delivery',continueIndependent:true,nodes:[{id:'owner',task:fixture.task('owner')},{id:'other',task:fixture.task('other')}]});
  const result=await workflows.run(plan.id,{totalTimeoutMs:20000});
  assert.equal(result.status,'blocked');assert.equal(result.nodes[1]!.job!.status,'completed');
  assert.equal(result.decisions[0]!.nextAction,'Review package and sign');
  assert.equal(result.nodes[0]!.job!.attempts,1);
});

test('green checks do not conceal missing outcome; contracted recovery fixes it',async t=>{
  let calls=0;
  const fixture=await DelegationFixture.create(t,{run:async input=>{calls++;if(calls===2)await fs.writeFile(path.join(input.cwd,'result.txt'),'accepted');return {status:'completed',summary:'Claims success'};}});
  const job=await fixture.engine.prepare({...fixture.task('missing-outcome'),taskDetails:{resolution:fixture.resolution,outcomeCriteria:[fixture.criterion]}});
  assert.equal((await fixture.engine.run(job.id)).status,'completed');assert.equal(calls,2);
  const failed=JSON.parse(await fs.readFile(path.join(fixture.engine.artifactDir(job.id),'attempt-1/outcome.json'),'utf8'));
  assert.equal(failed.status,'failed');
});

test('research artifact without code checks supports dependency handoff and workflow outcome',async t=>{
  const fixture=await DelegationFixture.create(t,{run:async input=>{await fs.writeFile(path.join(input.cwd,'result.txt'),'accepted');return {status:'completed',summary:'Research artifact prepared'};}});
  const workflows=new WorkflowManager(fixture.engine);
  const plan=await workflows.prepare({idempotencyKey:'artifact-only',objective:'Research delivery',acceptance:[{id:'research',description:'Research artifact delivered',nodeId:'research',criterionId:'result'}],nodes:[{id:'research',task:{...fixture.task('research'),checkIds:[],taskDetails:{outcomeCriteria:[fixture.criterion]}}},{id:'handoff',dependsOn:['research'],task:fixture.task('handoff')}]});
  const result=await workflows.run(plan.id,{totalTimeoutMs:20000});assert.equal(result.status,'completed');assert.equal(result.outcome.status,'passed');
  assert.equal(result.nodes[1]!.job!.status,'completed');
  const evaluations=await new EvaluationStore(fixture.root).list();
  const research= evaluations.items.find(item=>item.jobId===result.nodes[0]!.job!.id);
  assert.equal(research?.technical.status,'passed');assert.equal(research?.technical.outcomes?.[0]?.id,'result');
});

test('artifact verifier records hashes without content and rejects stale content or escaping paths',async t=>{
  const fixture=await DelegationFixture.create(t);await fs.writeFile(path.join(fixture.root,'result.txt'),'accepted sensitive fixture text');
  const verifier=new OutcomeVerifier(),input={root:fixture.root,criteria:[fixture.criterion],checks:[],taskContractHash:'hash'};
  const valid=await verifier.verify(input);assert.equal(valid.status,'passed');assert.equal(JSON.stringify(valid).includes('sensitive fixture text'),false);
  assert.equal((await verifier.verify({...input,criteria:[{...fixture.criterion,contains:'missing'}]})).status,'failed');
  assert.equal((await verifier.verify({...input,criteria:[{...fixture.criterion,sha256:'0'.repeat(64)}]})).status,'failed');
  assert.equal(OutcomeCriterionSchema.safeParse({...fixture.criterion,path:'../outside.txt'}).success,false);
  assert.equal(OutcomeCriterionSchema.safeParse({...fixture.criterion,path:path.win32.resolve('outside.txt')}).success,false);
  assert.equal((await verifier.verify({...input,criteria:[]})).status,'not-recorded');
});

test('questions examples and pause do not create execution contracts; approved continuation preserves references',()=>{
  const builder=new TaskContractBuilder(),base={projectId:'test',objective:'Approved goal',mode:'read-only' as const,kind:'checks' as const,checkIds:['node']};
  for(const kind of ['question','example','pause'] as const)assert.throws(()=>builder.build({...base,details:{intent:{kind,source:'User message',approvedPlanRefs:[],interpretation:'Discussion'}}}),/cannot authorize/);
  const contract=builder.build({...base,details:{intent:{kind:'continuation',source:'Owner approval',approvedPlanRefs:['PRD-generated-and-approved'],interpretation:'Continue approved work'}}});
  assert.deepEqual(contract.details.intent!.approvedPlanRefs,['PRD-generated-and-approved']);
});

test('cancellation before recovery does not start a second worker',async t=>{
  const controller=new AbortController();let calls=0;let fixture:DelegationFixture;
  fixture=await DelegationFixture.create(t,{run:async()=>{calls++;controller.abort();return {status:'blocked',summary:'Interrupted',blocker:fixture.blocker};}});
  const job=await fixture.engine.prepare({...fixture.task('pause'),taskDetails:{resolution:fixture.resolution}});
  assert.equal((await fixture.engine.run(job.id,20000,{signal:controller.signal})).status,'cancelled');assert.equal(calls,1);
});

test('review: a prior attempt cancellation does not block an explicitly resumed recovery',async t=>{
  let calls=0;let fixture:DelegationFixture;
  fixture=await DelegationFixture.create(t,{run:async()=>{calls++;if(calls===1)return {status:'failed',summary:'Cleanup unknown',cleanupFailed:true};if(calls===2)return {status:'blocked',summary:'Recoverable',blocker:fixture.blocker};return {status:'completed',summary:'Recovered'};}});
  const job=await fixture.engine.prepare({...fixture.task('old-cancel'),taskDetails:{resolution:fixture.resolution}});
  assert.equal((await fixture.engine.run(job.id)).status,'running');
  await fixture.engine.cancel(job.id);await fixture.engine.confirmProcessesStopped(job.id,'Fixture process stopped');fixture.engine.retry(job.id);
  assert.equal((await fixture.engine.run(job.id)).status,'completed');assert.equal(calls,3);
});

test('review: validation recovery is unambiguous and cannot select an unrelated first action',()=>{
  assert.equal(ResolutionPolicySchema.safeParse({source:'Approved fixture',maxAttempts:3,actions:[{id:'first',instruction:'Repair first',triggers:['outcome-failed']},{id:'second',instruction:'Repair second',triggers:['outcome-failed']}]}).success,false);
});

test('independent continuation stops on a global blocker',async t=>{
  let calls=0;
  const fixture=await DelegationFixture.create(t,{run:async()=>{calls++;return {status:'blocked',summary:'Global fixture unavailable',blocker:{kind:'global',reason:'Shared runtime unavailable',evidence:['Fixture runtime unavailable'],nextAction:'Restore shared runtime',recoveryActionId:null}};}});
  const workflows=new WorkflowManager(fixture.engine);
  const plan=await workflows.prepare({idempotencyKey:'global-stop',objective:'Scoped fixture',continueIndependent:true,nodes:[{id:'first',task:fixture.task('first')},{id:'other',task:fixture.task('other')}]});
  const result=await workflows.run(plan.id,{totalTimeoutMs:20000,concurrency:1});
  assert.equal(result.status,'blocked');assert.equal(calls,1);assert.equal(result.nodes[1]!.job!.attempts,0);
});

test('new evidence never exceeds the saved total recovery budget',async t=>{
  let calls=0;let fixture:DelegationFixture;
  fixture=await DelegationFixture.create(t,{run:async()=>{calls++;return {status:'blocked',summary:'Different fixture failure',blocker:{...fixture.blocker,evidence:['Observed failure '+calls]}};}});
  const job=await fixture.engine.prepare({...fixture.task('bounded'),taskDetails:{resolution:{...fixture.resolution,maxAttempts:2}}});
  assert.equal((await fixture.engine.run(job.id)).attempts,2);assert.equal(calls,2);
  assert.equal((await fixture.engine.run(job.id)).attempts,2);assert.equal(calls,2);
});
