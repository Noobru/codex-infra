import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {OperationsObservation} from '../src/operations-observation.js';
import {LocalSecurityGateAdapter,SecurityReceiptStore} from '../src/security-report-publisher.js';
import {StateStore} from '../src/state.js';
import type {SecurityGateReceipt} from '../src/security-gate.js';

async function fileSnapshot(root:string){
  const result:Record<string,{size:number;mtimeMs:number;sha256:string}>={};
  const visit=async(directory:string):Promise<void>=>{
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())await visit(file);
      else if(entry.isFile()){
        if(entry.name==='jobs.sqlite-wal'||entry.name==='jobs.sqlite-shm')continue;
        const [stat,bytes]=await Promise.all([fs.stat(file),fs.readFile(file)]);
        result[path.relative(root,file).replaceAll('\\','/')]={size:stat.size,mtimeMs:stat.mtimeMs,
          sha256:createHash('sha256').update(bytes).digest('hex')};
      }
    }
  };
  await visit(root);return result;
}

test('read-only observation fails closed when a required security integration sibling is absent',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'operations-observation-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const state=new StateStore(path.join(root,'state/jobs.sqlite'));
  const job=state.create({idempotencyKey:'active',projectId:'fixture',objective:'fixture',mode:'read-only',profileHash:'v1',
    resourceKey:'root:/fixture',executionKind:'checks'});
  state.claim(job.id,4242);state.close();

  const gate:SecurityGateReceipt={schemaVersion:1,policyVersion:'security-policy-v1',decision:'PASS',blocking:false,
    subject:{asset:'fixture',environment:'local',sha:'a'.repeat(40),stage:'report'},
    source:{name:'fixture',version:'1',fetchedAt:'2026-09-12T00:00:00Z',expiresAt:'2026-09-13T00:00:00Z'},
    reportHash:'b'.repeat(64),findings:[],reasons:[],unknowns:[],exceptionsApplied:[],evaluatedAt:'2026-09-12T01:00:00Z'};
  const receipts=new SecurityReceiptStore(root);
  const stored=await receipts.recordGate('fixture',gate,new LocalSecurityGateAdapter().map(gate),true);
  await receipts.recordPublicationResult({version:1,gateReceiptId:stored.receiptId,mode:'dry-run',status:'not-configured',
    publisherId:null,proposal:null,intentArtifactPath:null,externalReceipt:null,error:'No publisher configured'});

  const before=await fileSnapshot(root);
  const result=await new OperationsObservation(root).read('fixture');
  const after=await fileSnapshot(root);

  assert.deepEqual(after,before);
  assert.deepEqual(result.policy,{version:1,maxWorkers:1,maxModelWorkers:1});
  assert.deepEqual(result.activeWorkers,[{id:job.id,projectId:'fixture',status:'running',attempts:1,ownerPid:4242,
    resourceKey:'root:/fixture',executionKind:'checks'}]);
  assert.deepEqual(result.workflows,[]);assert.deepEqual(result.learning,[]);
  assert.equal(result.security?.length,1);
  assert.deepEqual(result.security?.[0],{receiptId:stored.receiptId,projectId:'fixture',stage:'report',decision:'UNKNOWN',
    effectiveExit:null,feedStatus:'UNKNOWN',publicationStatus:'not-configured',
    evidence:[stored.artifactPath,`artifacts/security-publications/${stored.receiptId}.result.json`]});
  assert.ok(result.warnings.includes(`security:${stored.receiptId}:integration_missing`));
});
