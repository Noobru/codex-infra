import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DockerRecovery,type DockerRecoveryHost,type DockerSocketInventory} from '../src/docker-recovery.js';

const decision={author:{name:'Fixture owner',role:'owner'},source:'Explicit fixture authorization',evidence:['Fixture diagnosis']};
const inventory=():DockerSocketInventory=>({owners:[],knownSocketError:true,directories:[{relative:'Docker/run',exists:true,safe:true,entries:[{name:'sailor-ingest.sock',known:true,socketEntry:true}]},{relative:'docker-secrets-engine',exists:true,safe:true,entries:[{name:'engine.sock',known:true,socketEntry:true}]}]});
async function fixture(t:import('node:test').TestContext){
  const parent=fileURLToPath(new URL('../../artifacts/test-fixtures/',import.meta.url));await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'docker-recovery-'));
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(parent)+path.sep));await fs.rm(root,{recursive:true,force:true});});
  const state={inventory:inventory(),healthy:false,startFails:false,partial:false,quarantines:0,starts:0};
  const host:DockerRecoveryHost={async inspect(){return structuredClone(state.inventory);},async healthy(){return state.healthy;},
    async quarantine(){state.quarantines++;return {quarantined:state.inventory.directories.slice(0,state.partial?1:2).map(d=>({original:d.relative,preserved:d.relative+'.recovery-fixture'})),deleted:false,...(state.partial?{error:'Second directory could not be renamed'}:{})};},async start(){state.starts++;if(state.startFails)throw new Error('Fixture start failed');}};
  return {root,state,recovery:new DockerRecovery(root,host)};
}
test('Docker preflight is read-only and does not interpret launch as health',async t=>{
  const {root,state,recovery}=await fixture(t);
  assert.equal((await recovery.inspect()).status,'orphan-sockets');
  assert.match((await recovery.inspect()).nextAction,/use recover_docker_start/);
  assert.deepEqual(await fs.readdir(root),[]);assert.equal(state.starts,0);
  const receipt=await recovery.recover(decision);assert.equal(receipt.status,'starting-or-failed');
  assert.equal(state.starts,1);assert.equal(state.quarantines,1);
  const entries=await fs.readdir(path.join(root,'artifacts/integration/docker-recovery'));assert.equal(entries.length,1);
  assert.deepEqual((await fs.readdir(path.join(root,'artifacts/integration/docker-recovery',entries[0]!))).sort(),['intent.json','preserved.json','result.json']);
});
test('Docker recovery refuses active owners, unexpected contents and non-owner requests',async t=>{
  const {root,state,recovery}=await fixture(t);
  await assert.rejects(recovery.recover({...decision,author:{name:'Agent',role:'model'}}));
  state.inventory.owners=[{ProcessName:'Docker Desktop',Id:42}];await assert.rejects(recovery.recover(decision),/close/);
  state.inventory.owners=[];state.inventory.directories[0]!.safe=false;await assert.rejects(recovery.recover(decision),/Inspect/);
  assert.equal(state.starts,0);assert.equal(state.quarantines,0);assert.deepEqual(await fs.readdir(root),[]);
});
test('healthy Docker is never restarted and a clean stopped installation needs no quarantine',async t=>{
  const {state,recovery}=await fixture(t);state.healthy=true;
  assert.equal((await recovery.recover(decision)).changed,false);assert.equal(state.starts,0);
  state.healthy=false;state.inventory.knownSocketError=false;state.inventory.directories=[];
  assert.match((await recovery.inspect()).nextAction,/use recover_docker_start/);
  await recovery.recover(decision);assert.equal(state.quarantines,0);assert.equal(state.starts,1);
});
test('known orphan sockets are detected before a new startup even if the crash log rotated',async t=>{
  const {state,recovery}=await fixture(t);state.inventory.knownSocketError=false;
  assert.equal((await recovery.inspect()).status,'orphan-sockets');await recovery.recover(decision);assert.equal(state.quarantines,1);
});
test('Docker start failure preserves recovery evidence and does not retry',async t=>{
  const {root,state,recovery}=await fixture(t);state.startFails=true;
  await assert.rejects(recovery.recover(decision),/Fixture start failed/);
  const [id]=await fs.readdir(path.join(root,'artifacts/integration/docker-recovery'));
  const evidence=JSON.parse(await fs.readFile(path.join(root,'artifacts/integration/docker-recovery',id!,'failure.json'),'utf8'));
  assert.equal(evidence.preserved.quarantined.length,2);assert.equal(evidence.preserved.deleted,false);assert.equal(state.starts,1);
});
test('partial two-directory preservation is retained and never starts Docker',async t=>{
  const {root,state,recovery}=await fixture(t);state.partial=true;
  await assert.rejects(recovery.recover(decision),/Second directory/);
  const [id]=await fs.readdir(path.join(root,'artifacts/integration/docker-recovery'));
  const base=path.join(root,'artifacts/integration/docker-recovery',id!);
  const failure=JSON.parse(await fs.readFile(path.join(base,'failure.json'),'utf8'));
  const preserved=JSON.parse(await fs.readFile(path.join(base,'preserved.json'),'utf8'));
  assert.deepEqual(failure.preserved,preserved.preserved);assert.equal(failure.preserved.quarantined.length,1);assert.equal(state.starts,0);
});
