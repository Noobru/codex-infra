import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test,{type TestContext} from 'node:test';
import {StateStore} from '../src/state.js';
import {EvaluationStore} from '../src/evaluation.js';
import {OperationalInsights} from '../src/operational-insights.js';

class InsightFixture {
  readonly state:StateStore;
  readonly insights:OperationalInsights;
  readonly evaluations:EvaluationStore;
  constructor(readonly root:string){this.state=new StateStore(path.join(root,'state/jobs.sqlite'));this.insights=new OperationalInsights(root);this.evaluations=new EvaluationStore(root);}
  static async create(t:TestContext) {
    const parent=fileURLToPath(new URL('../../artifacts/test-fixtures/',import.meta.url));await fs.mkdir(parent,{recursive:true});
    const fixture=new InsightFixture(await fs.mkdtemp(path.join(parent,'operational-insights-')));
    t.after(async()=>{fixture.state.close();await fs.rm(fixture.root,{recursive:true,force:true});});return fixture;
  }
  job(projectId='infra-fixture') {return this.state.create({idempotencyKey:crypto.randomUUID(),projectId,objective:'Owned evidence fixture; never execute its command',mode:'read-only',profileHash:'fixture'});}
  async attempt(jobId:string,exitCodes:number[],durations:number[],options:{command?:string;terminal?:boolean;checkIds?:string[]}={}) {
    const old=this.state.get(jobId);if(old.status==='failed')this.state.transition(jobId,'ready');
    const job=this.state.claim(jobId,process.pid),checkIds=options.checkIds??['first','second'];
    const directory=path.join(this.root,'artifacts/jobs',jobId,`attempt-${job.attempts}`);await fs.mkdir(directory,{recursive:true});
    const contract={version:1,hash:'fixture-contract',kind:'checks',mode:'read-only',checkIds};
    await fs.writeFile(path.join(directory,'task-contract.json'),JSON.stringify(contract));
    await fs.writeFile(path.join(directory,'checks.json'),JSON.stringify(exitCodes.map((exitCode,index)=>({checkId:checkIds[index],exitCode,durationMs:durations[index],
      executable:'never-run-fixture-command',args:[options.command??'stable'],cwd:path.join(this.root,'nonexistent-product-root')}))));
    this.state.transition(jobId,'validating');
    if(options.terminal!==false)this.state.transition(jobId,exitCodes.every(code=>code===0)&&exitCodes.length===checkIds.length?'completed':'failed');
    return job.attempts;
  }
}

test('capture is automatic evidence-only, concurrent/idempotent, and keeps missing checks unknown',async t=>{
  const fixture=await InsightFixture.create(t),job=fixture.job();
  await fixture.attempt(job.id,[0],[10]);
  const before=fixture.state.get(job.id),events=fixture.state.events(job.id);
  const results=await Promise.all([fixture.insights.captureJob(job.id),new OperationalInsights(fixture.root).captureJob(job.id)]);
  assert.equal(results.reduce((count,result)=>count+result.created,0),1);
  assert.equal(results.reduce((count,result)=>count+result.reused,0),1);
  assert.equal(results[0]!.evaluationIds[0],results[1]!.evaluationIds[0]);
  const receipt=await fixture.evaluations.read(results[0]!.evaluationIds[0]!);
  assert.equal(receipt.source,'operational-insights/v1');assert.equal(receipt.technical.status,'unknown');
  assert.equal(receipt.technical.criteria.find(criterion=>criterion.checkId==='second')?.status,'unknown');
  assert.equal(receipt.metrics[1]?.classification,'unknown');assert.equal(receipt.acceptance.status,'not-recorded');
  assert.equal(receipt.metrics[0]?.sample?.representative,false);assert.equal(receipt.metrics[0]?.sample?.size,1);
  assert.deepEqual(fixture.state.get(job.id),before);assert.deepEqual(fixture.state.events(job.id),events);
  assert.equal((await fixture.insights.reconcile()).created,0);
  assert.equal((await fixture.evaluations.list()).total,1);
  await assert.rejects(fs.access(path.join(fixture.root,'artifacts/learning')));
});

test('only final attempt receipts are captured; deterministic retry findings preserve the failed gate',async t=>{
  const fixture=await InsightFixture.create(t),job=fixture.job();
  await fixture.attempt(job.id,[1],[20]);
  await fixture.insights.captureJob(job.id);
  await fixture.attempt(job.id,[1],[15]);
  await fixture.insights.captureJob(job.id);
  await fixture.attempt(job.id,[0,0],[11,12],{terminal:false});
  assert.equal((await fixture.insights.captureJob(job.id)).evaluationIds.length,2);
  fixture.state.transition(job.id,'completed');
  assert.equal((await fixture.insights.captureJob(job.id)).created,1);
  const observed=await fixture.insights.observations();
  assert.deepEqual(observed.signals.map(signal=>signal.kind).sort(),['recovery','repeated-failure']);
  assert.equal(observed.comparisons.length,0); // A failed attempt is never a performance baseline.
  const evaluated=await fixture.evaluations.list();assert.equal(evaluated.total,3);
  assert.equal(evaluated.items.filter(receipt=>receipt.technical.criticalGateStatus==='failed').length,2);
  const before=await fs.readdir(path.join(fixture.root,'artifacts/evaluations'));
  assert.deepEqual(await fixture.insights.observations(),observed);
  assert.deepEqual(await fs.readdir(path.join(fixture.root,'artifacts/evaluations')),before);
});

test('suggests chronological compatible check comparisons and excludes changed commands and projects',async t=>{
  const fixture=await InsightFixture.create(t);
  const baseline=fixture.job();await fixture.attempt(baseline.id,[0,0],[10,20]);await fixture.insights.captureJob(baseline.id);
  const treatment=fixture.job();await fixture.attempt(treatment.id,[0,0],[15,18]);await fixture.insights.captureJob(treatment.id);
  const changed=fixture.job();await fixture.attempt(changed.id,[0,0],[1,1],{command:'different'});await fixture.insights.captureJob(changed.id);
  const elsewhere=fixture.job('other-project');await fixture.attempt(elsewhere.id,[0,0],[1,1]);await fixture.insights.captureJob(elsewhere.id);
  const observed=await fixture.insights.observations();
  assert.equal(observed.comparisons.length,2);
  assert.deepEqual(observed.comparisons.map(item=>item.comparison.absoluteDelta).sort((a,b)=>a!-b!),[-2,5]);
  assert.ok(observed.comparisons.every(item=>item.comparison.percentageChange===null&&!item.comparison.acceptedDeliveryComparison));
  assert.equal((await fixture.insights.observations({projectId:'other-project'})).comparisons.length,0);
  assert.equal((await fixture.insights.observations({limit:1})).truncated,true);
  assert.equal((await fixture.insights.reconcile({limit:1})).truncated,true);
});

test('changed source evidence creates a new immutable evaluation and supersedes it only in automatic observations',async t=>{
  const fixture=await InsightFixture.create(t),job=fixture.job();await fixture.attempt(job.id,[0,0],[10,20]);
  const first=await fixture.insights.captureJob(job.id);
  const receiptPath=path.join(fixture.root,'artifacts/jobs',job.id,'attempt-1/checks.json');
  const checks=JSON.parse(await fs.readFile(receiptPath,'utf8'));checks[0].durationMs=12;await fs.writeFile(receiptPath,JSON.stringify(checks));
  const second=await fixture.insights.captureJob(job.id);
  assert.equal(second.created,1);assert.notEqual(first.evaluationIds[0],second.evaluationIds[0]);
  assert.equal((await fixture.evaluations.list()).total,2);
  assert.equal((await fixture.insights.observations()).comparisons.length,0);
  const receipt=await fixture.evaluations.read(first.evaluationIds[0]!);assert.equal(receipt.metrics[0]?.value,10);
});
