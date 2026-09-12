import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
// Bootstrap only the canonical compiler; task validation below reuses TaskEngine.
await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.json'],{cwd:root,stdio:'inherit',windowsHide:true});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Canonical build failed: '+code)));
});
const {TaskEngine}=await import('../dist/src/engine.js');
const {atomicWriteJson}=await import('../dist/src/legacy/command-os-utils.js');
const engine=new TaskEngine(root);
try {
  const job=await engine.prepare({project:'codex-infra',objective:'Verify the distributable infrastructure locally',idempotencyKey:'local-verification-'+new Date().toISOString(),mode:'workspace-write',kind:'checks',checkIds:['build','tests','ui-typecheck','ui-build'],taskDetails:{acceptanceCriteria:['All canonical core tests and UI checks pass'],nonGoals:['No model generation or remote publication']}});
  const result=await engine.run(job.id,1800000);
  const checks=JSON.parse(await fs.readFile(path.join(engine.artifactDir(job.id),'attempt-'+result.attempts,'checks.json'),'utf8'));
  const receipt={version:1,capturedAt:new Date().toISOString(),jobId:job.id,status:result.status,modelGeneration:false,checks:checks.map(({checkId,exitCode,error,durationMs})=>({checkId,exitCode,error,durationMs}))};
  await atomicWriteJson(path.join(root,'artifacts/integration/distribution-local-ci.json'),receipt);
  console.log(JSON.stringify(receipt,null,2));
  if(result.status!=='completed')process.exitCode=2;
} finally {engine.close();}
