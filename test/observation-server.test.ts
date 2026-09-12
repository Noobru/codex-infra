import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {get} from 'node:http';
import {StateStore} from '../src/state.js';
import {ObservationServer} from '../src/observation-server.js';

test('HTTP observation serves real data, conditional reads and no write actions',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'infra-observe-http-'));
 const db=new StateStore(path.join(root,'state/jobs.sqlite'));
 const job=db.create({projectId:'example',objective:'Inspect runtime',mode:'read-only',idempotencyKey:'http',profileHash:'profile'});
 db.claim(job.id,process.pid);db.transition(job.id,'validating');db.transition(job.id,'completed');
 db.close();
 await fs.mkdir(path.join(root,'ui/dist'),{recursive:true});await fs.writeFile(path.join(root,'ui/dist/index.html'),'<main>Observed</main>');
 const server=new ObservationServer(root);const {url}=await server.start(0);
 t.after(async()=>{await server.close();await fs.rm(root,{recursive:true,force:true});});
 const response=await fetch(url+'/api/overview');assert.equal(response.status,200);
 const view=await response.json() as any;assert.equal(view.runs[0].id,job.id);assert.equal(view.counts.accepted,null);
 assert.equal((await fetch(url+'/api/overview',{headers:{'If-None-Match':response.headers.get('etag')!}})).status,304);
 assert.equal((await fetch(url+'/api/overview?project_id=another')).status,200);
 assert.equal(((await (await fetch(url+'/api/overview?project_id=another')).json()) as any).runs.length,0);
 assert.equal((await fetch(url+'/api/runs/'+job.id)).status,200);
 assert.equal((await fetch(url+'/api/runs/missing')).status,404);
 assert.equal((await fetch(url+'/api/overview?limit=NaN')).status,400);
 assert.equal((await fetch(url+'/api/overview',{method:'POST'})).status,405);
 const foreignHostStatus=await new Promise<number|undefined>((resolve,reject)=>{
   get(url+'/api/overview',{headers:{host:'untrusted.example'}},response=>{response.resume();resolve(response.statusCode);}).once('error',reject);
 });
 assert.equal(foreignHostStatus,403);
 assert.equal((await fetch(url+'/state/jobs.sqlite')).status,404);
 assert.match(await (await fetch(url)).text(),/Observed/);
 const after=new StateStore(path.join(root,'state/jobs.sqlite'),{readOnly:true});
 assert.equal(after.list().length,1);assert.equal(after.get(job.id).status,'completed');after.close();
});
