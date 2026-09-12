import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import test,{type TestContext} from 'node:test';
import {StateStore,type JobStatus} from '../src/state.js';
import {InteractionStore} from '../src/interactions.js';
import {KnowledgeFiles} from '../src/knowledge-store.js';
import {OperationalInsights} from '../src/operational-insights.js';
import {EfficiencyHistory} from '../src/efficiency-history.js';
import {InteractionTelemetryReceiptSchema,type InteractionTelemetryReceipt} from '../src/interaction-telemetry.js';

const asOf='2026-09-14T12:00:00.000Z';
class HistoryFixture {
  readonly state:StateStore;
  readonly interactions:InteractionStore;
  constructor(readonly root:string){this.state=new StateStore(path.join(root,'state/jobs.sqlite'));this.interactions=new InteractionStore(root);}
  static async create(t:TestContext) {
    const parent=fileURLToPath(new URL('../../artifacts/test-fixtures/',import.meta.url));await fs.mkdir(parent,{recursive:true});
    const fixture=new HistoryFixture(await fs.mkdtemp(path.join(parent,'efficiency-history-')));
    t.after(async()=>{fixture.state.close();await fs.rm(fixture.root,{recursive:true,force:true});});
    await fs.mkdir(path.join(fixture.root,'profiles'));
    await fs.writeFile(path.join(fixture.root,'profiles/registry.json'),JSON.stringify({version:1,projects:[{id:'fixture',name:'Owned fixture',root:path.join(fixture.root,'never-visit-a-product'),aliases:[],status:'active',stack:['TypeScript','Node.js'],modes:['read-only'],sourceRoots:[],sources:[],checks:[]}]}));
    return fixture;
  }
  job(kind:'codex'|'checks'='codex',projectId='fixture') {return this.state.create({idempotencyKey:randomUUID(),projectId,objective:'Synthetic receipt history; command is never executed',mode:'read-only',profileHash:'fixture',executionKind:kind});}
  async attempt(jobId:string,at:string,exitCode:number,options:{model?:string;effort?:string;contextHash?:string;sourceHash?:string;profileHash?:string;routingHash?:string;duration?:number;tokenTotal?:number;sourcePath?:string}={}) {
    const old=this.state.get(jobId);if(old.status==='failed')this.state.transition(jobId,'ready');
    const job=this.state.claim(jobId,process.pid);this.state.transition(jobId,'validating');this.state.transition(jobId,exitCode===0?'completed':'failed');
    const kind=this.state.resource(jobId).executionKind,base=path.join(this.root,'artifacts/jobs',jobId,`attempt-${job.attempts}`);await fs.mkdir(base,{recursive:true});
    const start=new Date(Date.parse(at)-1000).toISOString(),contract={version:1,hash:'a'.repeat(64),kind,mode:'read-only',checkIds:['syntax']};
    await fs.writeFile(path.join(base,'task-contract.json'),JSON.stringify(contract));
    await fs.writeFile(path.join(base,'checks.json'),JSON.stringify([{checkId:'syntax',exitCode,durationMs:options.duration??10,executable:'synthetic-only',args:['syntax'],cwd:path.join(this.root,'never-run-this-fixture')}]));
    await fs.writeFile(path.join(base,'context-pack.json'),JSON.stringify({version:1,hash:options.contextHash??'b'.repeat(64),selectorVersion:'fixture/v1',capturedAt:start,taskContractHash:contract.hash,profileHash:options.profileHash??'c'.repeat(64),sources:[{path:options.sourcePath??path.join(this.root,'not-read/reference.md'),label:'Fixture reference',sha256:options.sourceHash??'d'.repeat(64)}],excludedSources:[],budget:{limitChars:4000,includedChars:100,availableChars:100}}));
    await fs.writeFile(path.join(base,'routing.json'),JSON.stringify({status:'candidate',assignment:'coordinator',candidate:{model:'fixture-model',reasoningEffort:'high'},reason:'Synthetic routing receipt',rule:'coordinator',policyVersion:'1',policyHash:options.routingHash??'e'.repeat(64),inputHash:'f'.repeat(64),evidenceLevel:'hypothesis',requiresCapabilityValidation:false,capabilityValidation:'not-required',fallback:null,limits:{automaticRetries:0,automaticEscalation:false,fixedModelChain:false}}));
    if(kind==='codex')await fs.writeFile(path.join(base,'worker.json'),JSON.stringify({status:'completed',turnId:`fixture-turn-${jobId}-${job.attempts}`,receipt:{startedAt:start,finishedAt:at,model:options.model??'fixture-old',reasoningEffort:options.effort??'high',cleanupConfirmed:true,tokenUsage:{inputTokens:options.tokenTotal??100,totalTokens:options.tokenTotal??100},tokenUsageScope:'thread-cumulative'}}));
    // Pin controlled fixture event timestamps; no project or process execution is involved.
    const db=new DatabaseSync(path.join(this.root,'state/jobs.sqlite'));
    try {const events=this.state.events(jobId),claim=[...events].reverse().find(event=>event.detail.action==='claim')!;
      for(const event of events.filter(event=>event.id>=claim.id))db.prepare('UPDATE job_events SET createdAt=? WHERE id=?').run(event.toStatus==='running'?start:at,event.id);
      db.prepare('UPDATE jobs SET createdAt=?,updatedAt=? WHERE id=?').run(start,at,jobId);
    }finally{db.close();}
    return job.attempts;
  }
  history() {return new EfficiencyHistory(this.root,{clock:()=>new Date(asOf),timeZone:'UTC'});}
  async turn(input:Partial<InteractionTelemetryReceipt>={}) {
    const threadId=randomUUID(),interactionId=InteractionStore.idFor({threadId}),turnId=randomUUID(),at='2026-09-12T12:00:00.000Z';
    const receipt=InteractionTelemetryReceiptSchema.parse({version:1,interactionId,threadId,turnId,projectId:'fixture',interactionRevision:1,performanceScope:{taskClass:'syntax-repair',language:'TypeScript',problemCategory:'syntax'},assignment:'interaction-revision',status:'complete',startedAt:'2026-09-12T11:59:00.000Z',finishedAt:at,
      tokens:{inputTokens:100,cachedInputTokens:40,cacheWriteInputTokens:null,outputTokens:20,reasoningOutputTokens:null,totalTokens:120},coverage:{baselineObserved:true,terminalObserved:true,tokenEvents:1,duplicateEvents:0,counterResets:0,limited:false},epoch:{start:0,end:0},source:{kind:'codex-rollout-token-count/v1',fingerprint:'a'.repeat(64),startLine:1,endLine:4,cursor:500},capturedAt:at,artifactPath:`artifacts/telemetry/${interactionId}/turn-${turnId}.json`,warnings:[],...input});
    await new KnowledgeFiles(this.root).writeJsonNew(receipt.artifactPath,receipt);return receipt;
  }
  async learning(at:string,reversedAt:string) {
    const id=randomUUID(),content='Synthetic TypeScript syntax guidance',contentHash=KnowledgeFiles.hash(content),directory=`artifacts/learning/candidates/${id}`;
    const releasePath=`artifacts/learning/releases/${id}/revision-2/practice.md`,author={name:'Synthetic fixture owner',role:'owner'},decision={author,source:'Synthetic lifecycle evidence',evidence:['fixture-decision'],recordedAt:at};
    const base={version:1,id,projectId:'fixture',origin:{jobId:randomUUID(),attempt:1},title:'Synthetic syntax practice',kind:'practice',content,author,source:'Synthetic historical learning receipt',createdAt:at,updatedAt:at,contentHash,contentPath:`${directory}/proposal.txt`,originEvidence:{refs:['fixture-origin'],checkResults:[],jobStatusAtCapture:'completed'},review:null,shadow:null,promotion:null,reversal:null};
    const files=new KnowledgeFiles(this.root);
    await files.writeJsonNew(`${directory}/revision-000001.json`,{...base,revision:1,status:'proposed',artifactPath:`${directory}/revision-000001.json`});
    await files.writeJsonNew(`${directory}/revision-000002.json`,{...base,revision:2,status:'promoted',artifactPath:`${directory}/revision-000002.json`,promotion:{...decision,path:releasePath,contentHash}});
    await files.writeJsonNew(`${directory}/revision-000003.json`,{...base,revision:3,status:'reverted',updatedAt:reversedAt,artifactPath:`${directory}/revision-000003.json`,promotion:{...decision,path:releasePath,contentHash},reversal:{...decision,recordedAt:reversedAt,previousPromotionRevision:2}});
    await files.writeNew(releasePath,content);
    return {id,contentHash,releasePath};
  }
}

test('daily jobs separate model work from checks and preserve earlier failures after a later retry',async t=>{
  const fixture=await HistoryFixture.create(t),job=fixture.job(),checks=fixture.job('checks');
  await fixture.attempt(job.id,'2026-09-11T12:00:00.000Z',1,{duration:30,tokenTotal:100});
  await fixture.attempt(job.id,'2026-09-12T12:00:00.000Z',0,{duration:20,tokenTotal:250});
  await fixture.attempt(checks.id,'2026-09-12T13:00:00.000Z',0,{duration:5});
  // Old state migrations defaulted executionKind to codex even for prepared deterministic checks.
  const legacy=new DatabaseSync(path.join(fixture.root,'state/jobs.sqlite'));
  try{legacy.prepare("UPDATE jobs SET executionKind='codex' WHERE id=?").run(checks.id);}finally{legacy.close();}
  await fs.writeFile(path.join(fixture.root,'artifacts/jobs',checks.id,'manifest.json'),JSON.stringify({kind:'checks',checkIds:['syntax']}));
  await new OperationalInsights(fixture.root).reconcile();
  const beforeEvents=fixture.state.events(job.id),beforeFiles=await fs.readdir(path.join(fixture.root,'artifacts/evaluations'));
  const history=await fixture.history().history({days:7,projectId:'fixture'});
  assert.equal(history.points.length,7);assert.equal(history.window.startDay,'2026-09-08');
  const failed=history.points.find(point=>point.day==='2026-09-11')!.jobs.codex;
  assert.equal(failed.finished,1);assert.equal(failed.failedRate,1);assert.equal(failed.firstPassRate,0);
  const later=history.points.find(point=>point.day==='2026-09-12')!;
  assert.equal(later.jobs.codex.completed,1);assert.equal(later.jobs.codex.firstPassRate,0);assert.equal(later.jobs.codex.retries,1);
  assert.equal(later.jobs.checks.completed,1);assert.equal(later.jobs.checks.firstPassRate,1);
  assert.ok(history.limitations.some(note=>note.includes('legacy scheduling default')));assert.equal(fixture.state.resource(checks.id).executionKind,'codex');
  assert.equal(history.points[0]!.jobs.codex.firstPassRate,null);
  assert.equal(history.durationSeries.length,2);assert.deepEqual(history.durationSeries.map(series=>series.executionKind).sort(),['checks','codex']);
  assert.deepEqual(history.tokenObservations.map(item=>item.usage.totalTokens).sort((a,b)=>a!-b!),[100,250]);
  assert.ok(history.tokenObservations.every(item=>item.scope==='thread-cumulative'));
  assert.deepEqual(history.projects[0]!.languages,['TypeScript']);assert.deepEqual(history.projects[0]!.declaredStack,['TypeScript','Node.js']);
  assert.deepEqual(fixture.state.events(job.id),beforeEvents);assert.deepEqual(await fs.readdir(path.join(fixture.root,'artifacts/evaluations')),beforeFiles);
});

test('direct history counts reopened completed cycles and excludes imports and the still-open cycle',async t=>{
  const fixture=await HistoryFixture.create(t);
  await fixture.interactions.importThreads({source:'Synthetic imported metadata',observedAt:'2026-09-10T00:00:00.000Z',threads:[{threadId:'imported-only',title:'Imported task',sourceStatus:'completed',sourceRef:'fixture-thread'}]});
  let interaction=await fixture.interactions.begin({threadId:'direct-work',title:'Synthetic direct work',projectId:'fixture',intent:'work',source:'Fixture start',observedAt:'2026-09-10T00:00:00.000Z'});
  interaction=await fixture.interactions.update(interaction.id,{expectedRevision:interaction.revision,status:'blocked',source:'Fixture waiting',observedAt:'2026-09-10T12:00:00.000Z'});
  interaction=await fixture.interactions.update(interaction.id,{expectedRevision:interaction.revision,status:'completed',source:'Fixture completion',observedAt:'2026-09-11T00:00:00.000Z'});
  interaction=await fixture.interactions.update(interaction.id,{expectedRevision:interaction.revision,summary:'Metadata-only outcome detail',source:'Fixture detail',observedAt:'2026-09-11T05:00:00.000Z'});
  interaction=await fixture.interactions.update(interaction.id,{expectedRevision:interaction.revision,status:'open',source:'Fixture reopen',observedAt:'2026-09-12T00:00:00.000Z'});
  interaction=await fixture.interactions.update(interaction.id,{expectedRevision:interaction.revision,status:'completed',source:'Fixture second completion',observedAt:'2026-09-13T00:00:00.000Z'});
  await fixture.interactions.update(interaction.id,{expectedRevision:interaction.revision,status:'open',source:'Still working',observedAt:'2026-09-14T00:00:00.000Z'});
  const history=await fixture.history().history({days:7});
  assert.equal(history.points.reduce((sum,point)=>sum+point.direct.completedCycles,0),2);
  assert.equal(history.points.reduce((sum,point)=>sum+point.direct.timedCycles,0),2);
  assert.equal(history.points.find(point=>point.day==='2026-09-11')!.direct.elapsedWallClockMsMean,86400000);
  assert.equal(history.points.find(point=>point.day==='2026-09-13')!.direct.elapsedWallClockMsMean,86400000);
  assert.equal(history.points.find(point=>point.day==='2026-09-14')!.direct.elapsedWallClockMsMean,null);
  assert.ok(history.points.every(point=>point.direct.classification==='reported'));
});

test('markers require changed recorded values, and learning bindings mean context inclusion only',async t=>{
  const fixture=await HistoryFixture.create(t),learning=await fixture.learning('2026-09-10T00:00:00.000Z','2026-09-13T00:00:00.000Z');
  const old=fixture.job();await fixture.attempt(old.id,'2026-09-09T12:00:00.000Z',0);
  const changed=fixture.job();await fixture.attempt(changed.id,'2026-09-11T12:00:00.000Z',0,{model:'fixture-new',effort:'low',routingHash:'1'.repeat(64),profileHash:'2'.repeat(64),contextHash:'3'.repeat(64),sourceHash:learning.contentHash,sourcePath:path.resolve(fixture.root,learning.releasePath)});
  const recapture=fixture.job();await fixture.attempt(recapture.id,'2026-09-12T12:00:00.000Z',0,{model:'fixture-new',effort:'low',routingHash:'1'.repeat(64),profileHash:'2'.repeat(64),contextHash:'4'.repeat(64),sourceHash:learning.contentHash,sourcePath:path.resolve(fixture.root,learning.releasePath)});
  const history=await fixture.history().history({days:7});
  for(const kind of ['model','effort','routing-policy','profile','context','promotion','reversal'])assert.equal(history.changes.filter(change=>change.kind===kind).length,1,kind);
  assert.equal(history.knowledgeBindings.length,2);assert.ok(history.knowledgeBindings.every(binding=>binding.bindingKind==='context-inclusion'&&binding.candidateId===learning.id));
  assert.ok(history.changes.filter(change=>change.kind==='knowledge-use').every(change=>change.label==='Learned content included in attempt context'));
});

test('bounded inventory exposes incomplete coverage and local calendar buckets are explicit',async t=>{
  const fixture=await HistoryFixture.create(t);const first=fixture.job(),second=fixture.job();
  await fixture.attempt(first.id,'2026-09-10T01:00:00.000Z',0);await fixture.attempt(second.id,'2026-09-12T01:00:00.000Z',0);
  const history=await new EfficiencyHistory(fixture.root,{clock:()=>new Date(asOf),timeZone:'America/Sao_Paulo',limits:{jobs:1}}).history({days:7});
  assert.equal(history.timeZone,'America/Sao_Paulo');assert.equal(history.coverage.jobs.available,2);assert.equal(history.coverage.jobs.inspected,1);assert.equal(history.coverage.truncated,true);
  assert.equal(history.points.find(point=>point.day==='2026-09-11')!.jobs.codex.completed,1);
  assert.equal(history.points.find(point=>point.day==='2026-09-12')!.jobs.codex.completed,0);
});

test('token history sums complete turn deltas by declared scope with independent metric coverage and null gaps',async t=>{
  const fixture=await HistoryFixture.create(t),first=await fixture.turn();
  await fixture.turn({tokens:{inputTokens:null,cachedInputTokens:0,cacheWriteInputTokens:null,outputTokens:10,reasoningOutputTokens:null,totalTokens:null}});
  await fixture.turn({performanceScope:{taskClass:'syntax-repair',language:'Python',problemCategory:'syntax'}});
  await fixture.turn({performanceScope:null});
  await fixture.turn({status:'partial',finishedAt:null,tokens:{inputTokens:9999,cachedInputTokens:null,cacheWriteInputTokens:null,outputTokens:null,reasoningOutputTokens:null,totalTokens:9999}});
  await fixture.turn({status:'unknown',tokens:null});
  await fixture.turn({finishedAt:'2026-09-01T12:00:00.000Z',startedAt:'2026-09-01T11:00:00.000Z'});
  // A saved partial for the same completed turn is historical producer state, not a second observation.
  await fixture.turn({...first,status:'partial',artifactPath:first.artifactPath.replace('.json','.partial.json')});
  const filesBefore=await fs.readdir(path.join(fixture.root,'artifacts/telemetry',first.interactionId));
  const history=await fixture.history().history({days:7});
  assert.equal(history.tokenSeries.length,2);assert.equal(history.telemetry.completeTurns,4);assert.equal(history.telemetry.unassignedTurns,1);assert.equal(history.telemetry.incompleteTurns,2);
  const series=history.tokenSeries.find(series=>series.performanceScope.language==='TypeScript')!;
  const point=series.points.find(point=>point.day==='2026-09-12')!;
  assert.equal(point.n,2);assert.equal(point.totalTokens,120);assert.equal(point.metricSamples.totalTokens,1);
  assert.equal(point.inputTokens,100);assert.equal(point.metricSamples.inputTokens,1);assert.equal(point.uncachedInputTokens,60);assert.equal(point.metricSamples.uncachedInputTokens,1);
  assert.equal(point.cachedInputTokens,40);assert.equal(point.metricSamples.cachedInputTokens,2);assert.equal(point.outputTokens,30);assert.equal(point.reasoningOutputTokens,null);
  assert.equal(point.metricSamples.reasoningOutputTokens,0);assert.equal(series.points[0]!.totalTokens,null);assert.equal(series.points[0]!.n,0);
  assert.equal(series.scope,'complete-turn-delta');assert.equal(series.classification,'observed');assert.equal(history.tokenObservations.length,0);
  assert.deepEqual(await fs.readdir(path.join(fixture.root,'artifacts/telemetry',first.interactionId)),filesBefore);
});
