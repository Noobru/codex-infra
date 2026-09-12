import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {ProfileSchema, ProjectRegistry} from "../src/registry.js";
import {ProcessCleanupError, type CommandResult} from "../src/process.js";

test("registry preserves identity, detects ambiguous aliases and context provenance",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"infra-registry-"));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,"note.md"),"abcdef");
 const registryPath=path.join(root,"registry.json");
 const profile={id:"one",name:"One",aliases:["shared"],root,status:"active",stack:["test"],modes:["read-only"],sourceRoots:[],sources:[{path:"note.md",label:"note",kind:"reference",maxChars:3}],checks:[{id:"version",executable:process.execPath,args:["--version"],readOnly:true}]};
 await fs.writeFile(registryPath,JSON.stringify({version:1,projects:[profile,{...profile,id:"two",name:"Two"}]}));
 const registry=new ProjectRegistry(registryPath);
 await assert.rejects(registry.resolve("shared"),/Ambiguous/);
 const p=await registry.resolve("ONE");
 const context=await registry.context(p);
 assert.equal(context.projectId,"one");
 assert.equal(context.sources[0]?.excerpt,"abc");
 assert.equal(context.sources[0]?.truncated,true);
 assert.equal(context.sources[0]?.sha256.length,64);
 assert.equal((await registry.check(p,"version","read-only")).exitCode,0);
 await assert.rejects(registry.check(p,"version","workspace-write"),/Mode/);
});
test("paused profiles never authorize writes and sources cannot escape declared roots",async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"infra-scope-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const project=path.join(root,"project");await fs.mkdir(project);await fs.writeFile(path.join(root,"outside.md"),"private");
 const reg=path.join(root,"registry.json");
 await fs.writeFile(reg,JSON.stringify({version:1,projects:[{id:"paused",name:"Paused",aliases:[],root:project,status:"paused",stack:[],modes:["read-only","workspace-write"],sourceRoots:[],sources:[{path:"../outside.md",label:"outside",kind:"reference"}],checks:[]}]}));
 const registry=new ProjectRegistry(reg);const p=await registry.resolve("paused");
 assert.throws(()=>registry.assertMode(p,"workspace-write"),/paused/);
 await assert.rejects(registry.context(p),/outside allowed roots/);
});

test('context capture surfaces unconfirmed Git cleanup with its typed ownership evidence', async () => {
 const result:CommandResult={executable:'git',args:[],cwd:process.cwd(),exitCode:null,stdout:'',stderr:'',durationMs:1,error:'timeout',cleanupFailed:true,ownedPid:2147483000};
 const registry=new ProjectRegistry('unused-fixture-registry',{run:async()=>result});
 const profile=ProfileSchema.parse({id:'fixture',name:'Fixture',root:process.cwd(),status:'active',stack:[],modes:['read-only'],sourceRoots:[],sources:[],checks:[]});
 await assert.rejects(registry.context(profile),error=>{
  assert.ok(error instanceof ProcessCleanupError);
  assert.equal(error.result,result);
  assert.equal(error.code,'PROCESS_CLEANUP_FAILED');
  return true;
 });
});


test('check environment paths resolve before dispatch and missing directories never invoke a process', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'infra-check-path-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'runtime'));
 let calls=0;
 const registry=new ProjectRegistry('unused',{run:async(executable,args,cwd,_timeout,options)=>{
  calls++; assert.deepEqual(options?.pathPrepend,[await fs.realpath(path.join(root,'runtime'))]);
  return {executable,args,cwd,exitCode:0,stdout:'',stderr:'',durationMs:0};
 }});
 const profile=ProfileSchema.parse({id:'fixture',name:'Fixture',root,status:'active',stack:[],modes:['read-only'],sourceRoots:[],sources:[],checks:[{id:'check',executable:'fixture',args:[],readOnly:true,environmentPaths:['runtime']}]});
 assert.equal((await registry.check(profile,'check','read-only')).exitCode,0);
 profile.checks[0]!.environmentPaths=['missing'];
 await assert.rejects(registry.check(profile,'check','read-only'),/environment directory is unavailable/);
 assert.equal(calls,1);
});
