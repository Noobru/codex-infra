import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test,{type TestContext} from 'node:test';
import {InteractionStore} from '../src/interactions.js';
import {KnowledgeLearningStore} from '../src/knowledge-learning.js';
import {KnowledgeFiles} from '../src/knowledge-store.js';
import {LearningRuntimeStore,LearningRunReceiptSchema} from '../src/learning-runtime.js';
import {LearningRuntimeEffects} from '../src/learning-runtime-effects.js';
import {DashboardReader} from '../src/dashboard.js';
import {StateStore} from '../src/state.js';

const decision={author:{name:'Fixture agent',role:'model' as const},source:'reader fixture only',evidence:['synthetic receipt fixture; no execution or OS isolation claim']};
const history={observedAt:'2026-09-12T23:59:59.000Z',timeZone:'America/Sao_Paulo',window:{days:7 as const,startDay:'2026-09-06',endDay:'2026-09-12'}};

async function fixture(t:TestContext){
  const parent=fileURLToPath(new URL('../../artifacts/test-fixtures/',import.meta.url));await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'runtime-effects-'));
  t.after(async()=>{if(!path.resolve(root).startsWith(path.resolve(parent)+path.sep))throw new Error('Fixture cleanup escaped its root');await fs.rm(root,{recursive:true,force:true});});
  const interaction=await new InteractionStore(root).begin({idempotencyKey:'runtime-effects-fixture',projectId:'effects-fixture',source:'fixture',title:'Reader fixture'});
  const learning=new KnowledgeLearningStore(root);
  const candidate=await learning.propose({projectId:'effects-fixture',origin:{interactionId:interaction.id,revision:interaction.revision},title:'Fixture transformer',
    kind:'script',content:'Only a small reader fixture.',author:decision.author,source:decision.source});
  await learning.review(candidate.id,{...decision,decision:'approved'});
  const published=await new LearningRuntimeStore(root).publish(candidate.id,{version:1,capabilityVersion:'1.0.0',files:[{path:'main.mjs',content:'// Reader fixture; never executed.\n'}],
    entrypoints:[{id:'transform',runtime:'node',path:'main.mjs'}],tests:[{id:'fixture-test',runtime:'node',path:'main.mjs'}]});
  const files=new KnowledgeFiles(root);
  const record=async(at:string,durationMs:number,passed=true,attribution?:{threadId:string;turnId:string})=>{
    const id=randomUUID();const receipt=LearningRunReceiptSchema.parse({version:1,id,hash:published.manifest.hash,projectId:'effects-fixture',entrypoint:'transform',
      recordedAt:at,artifactPath:`artifacts/learning/runtime/runs/${id}.json`,decision,status:passed?'passed':'failed',
      result:{executable:'fixture-node',args:[],cwd:'fixture-only',exitCode:passed?0:1,stdout:'',stderr:'',durationMs},
      isolation:{kind:'synthetic reader fixture',network:'denied',filesystem:'workspace-write',verified:true,evidence:decision.evidence},
      outputs:passed?[{path:'result.txt',content:'CORRECTED',sha256:KnowledgeFiles.hash('CORRECTED')}]:[],disabledDuringExecution:false,...(attribution?{attribution}:{})});
    await files.writeJsonNew(receipt.artifactPath,receipt);return receipt;
  };
  return {root,record,published,files};
}

test('runtime effects aggregate distinct receipts and local days, preserve attribution, and never expose output contents',async t=>{
  const f=await fixture(t);const attribution={threadId:randomUUID(),turnId:randomUUID()};
  const a=await f.record('2026-09-12T01:30:00.000Z',100,true,attribution);
  const b=await f.record('2026-09-12T13:30:00.000Z',300,false);
  await f.record('2026-09-01T12:00:00.000Z',900);
  const before=await fs.readFile(path.join(f.root,a.artifactPath));
  const result=await new LearningRuntimeEffects(f.root).read({projectId:'effects-fixture',history});
  assert.equal(result.items.length,1);const item=result.items[0]!;
  assert.equal(item.executions,2);assert.equal(item.passed,1);assert.equal(item.failed,1);
  assert.equal(item.metrics.totalDuration.value,400);assert.equal(item.metrics.meanDuration.value,200);
  assert.equal(item.metrics.meanDuration.classification,'observed');assert.equal(item.metrics.meanDuration.sample?.representative,false);
  assert.deepEqual(item.days.map(day=>[day.day,day.executions,day.totalDurationMs]),[['2026-09-11',1,100],['2026-09-12',1,300]]);
  assert.equal(item.attributedExecutions,1);assert.deepEqual(item.runs[0]!.attribution,attribution);
  assert.deepEqual(item.runs[0]!.outputs,[{path:'result.txt',sha256:KnowledgeFiles.hash('CORRECTED'),bytes:9}]);
  assert.ok(item.evidence.includes(a.artifactPath)&&item.evidence.includes(b.artifactPath));
  assert.equal(result.coverage.included,2);assert.deepEqual(result.warnings,[]);assert.equal(result.tokenComparison.metrics,null);
  assert.equal(JSON.stringify(result).includes('CORRECTED'),false);
  assert.deepEqual(await fs.readFile(path.join(f.root,a.artifactPath)),before);
  assert.deepEqual((await new LearningRuntimeEffects(f.root).read({projectId:'other-fixture',history})).items,[]);
  new StateStore(path.join(f.root,'state/jobs.sqlite')).close();
  const dashboard=new DashboardReader(f.root);
  try {
    const screen=await dashboard.screen({view:'learning',projectId:'effects-fixture'});
    assert.equal(screen.runtimeEffects?.data?.items[0]?.executions,3,'learning includes verified use before the efficiency window');
    assert.equal(screen.runtimeEffects?.data?.window,null);
    assert.equal(screen.learningRuntime?.data?.items[0]?.state.activation,null,'recorded use never fabricates activation');
  } finally {dashboard.close();}
});

test('missing durations remain unknown and mismatched outcome or output receipts do not become successful executions',async t=>{
  const f=await fixture(t);const reader=new LearningRuntimeEffects(f.root);
  const empty=await reader.read({history});assert.equal(empty.items[0]!.executions,0);
  assert.equal(empty.items[0]!.metrics.totalDuration.value,null);assert.equal(empty.items[0]!.metrics.meanDuration.classification,'unknown');
  const bad=await f.record('2026-09-12T12:00:00.000Z',20);bad.result.exitCode=1;
  await fs.writeFile(path.join(f.root,bad.artifactPath),JSON.stringify(bad));
  const changed=await f.record('2026-09-12T12:10:00.000Z',30);changed.outputs[0]!.sha256='f'.repeat(64);
  await fs.writeFile(path.join(f.root,changed.artifactPath),JSON.stringify(changed));
  const result=await reader.read({history});assert.equal(result.items[0]!.executions,0);assert.equal(result.coverage.included,0);
  assert.equal(result.warnings.length,2);assert.equal(result.items[0]!.metrics.meanDuration.value,null);
});
