import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('real MCP subprocess negotiates tools and resolves a project through the shared registry',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'infra-mcp-'));
  await fs.mkdir(path.join(root,'profiles'));
  await fs.writeFile(path.join(root,'profiles/registry.json'),JSON.stringify({version:1,projects:[{id:'fixture',name:'Fixture',aliases:['sample'],root,status:'paused',stack:[],modes:['read-only'],sourceRoots:[],sources:[],checks:[]}]}));
  const client=new Client({name:'integration-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp.js',import.meta.url))],env:{...Object.fromEntries(Object.entries(process.env).filter((x):x is [string,string]=>x[1]!==undefined)),CODEX_INFRA_ROOT:root},stderr:'pipe'});
  t.after(async()=>{await client.close();await fs.rm(root,{recursive:true,force:true});});
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(tool=>tool.name==='project_context'));
  const response=await client.callTool({name:'project_context',arguments:{project:'sample'}});
  const blocks=response.content as {type:string;text:string}[];
  assert.equal(JSON.parse(blocks[0]!.text).projectId,'fixture');
  const unknown=await client.callTool({name:'project_context',arguments:{project:'missing'}});
  assert.equal(unknown.isError,true);
  const profile={id:'registered',name:'Registered',aliases:['new-project'],root,status:'paused',stack:['Node'],modes:['read-only'],sourceRoots:[],sources:[],checks:[]};
  const registered=await client.callTool({name:'register_project',arguments:{profile}});
  assert.notEqual(registered.isError,true);
  const added=await client.callTool({name:'project_context',arguments:{project:'new-project'}});
  assert.equal(JSON.parse((added.content as {text:string}[])[0]!.text).projectId,'registered');
  const source=JSON.parse(await fs.readFile(path.join(root,'profiles/registry.json'),'utf8'));
  assert.equal(source.projects.length,2);
  const tools=(await client.listTools()).tools;
  const vmTools=['preview_vm_access','prepare_vm_access','inspect_vm_access','start_vm_access','validate_vm_access','close_vm_access','vm_access_session_command'];
  for(const name of vmTools) {
    assert.ok(tools.some(tool=>tool.name===name));
    const invalid=await client.callTool({name,arguments:{input:{}}});
    assert.equal(invalid.isError,true,`${name} must reject missing resource identity before effects`);
  }
  assert.equal(tools.find(tool=>tool.name==='preview_vm_access')?.annotations?.readOnlyHint,true);
  assert.notEqual(tools.find(tool=>tool.name==='validate_vm_access')?.annotations?.readOnlyHint,true);
  assert.ok(tools.some(tool=>tool.name==='delegate_task'));
  assert.ok(tools.some(tool=>tool.name==='delivery_status'));
  await fs.writeFile(path.join(root,'research.txt'),'Verified fixture conclusion');
  const prepared=await client.callTool({name:'prepare_task',arguments:{project:'fixture',objective:'Verify research artifact',idempotencyKey:'outcome-wire',mode:'read-only',kind:'checks',checkIds:[],taskDetails:{outcomeCriteria:[{id:'research',description:'Fixture conclusion',kind:'artifact',path:'research.txt',contains:'Verified fixture conclusion'}]}}});
  assert.notEqual(prepared.isError,true);
  const preparedJob=JSON.parse((prepared.content as {text:string}[])[0]!.text);
  const ran=await client.callTool({name:'run_task',arguments:{jobId:preparedJob.id,timeoutMs:10000}});assert.notEqual(ran.isError,true);
  const delivery=await client.callTool({name:'delivery_status',arguments:{jobId:preparedJob.id}});
  const packet=JSON.parse((delivery.content as {text:string}[])[0]!.text);
  assert.equal(packet.outcomeStatus,'passed');assert.equal(packet.humanAcceptance,'not-recorded');
  const missingQualification=await client.callTool({name:'delegate_task',arguments:{input:{
    project:'fixture',objective:'Read source',idempotencyKey:'missing-qualification',mode:'read-only',checkIds:['fixture'],
  }}});
  assert.equal(missingQualification.isError,true);
  const route=await client.callTool({name:'route_task',arguments:{routing:{taskClass:'retrieval',complexity:'low',uncertainty:'low',risk:'low',
    contextCoupling:'low',bounded:true,independentlyVerifiable:true,delegationBenefit:'expected',rationale:'Extract one known fact from a bounded source.'}}});
  assert.deepEqual(JSON.parse((route.content as {text:string}[])[0]!.text).candidate,{model:'gpt-5.6-luna',reasoningEffort:'low'});
  assert.notEqual(tools.find(tool=>tool.name==='security_report')?.annotations?.readOnlyHint,true);
  await fs.writeFile(path.join(root,'trivy-fixture.json'),JSON.stringify({Results:[{Target:'fixture',Vulnerabilities:[]}]}));
  const now=Date.now();
  const gate=await client.callTool({name:'security_report',arguments:{project:'fixture',input:{reportPath:'trivy-fixture.json',format:'trivy-json',
    subject:{asset:'synthetic-fixture',environment:'local',sha:'0'.repeat(40),stage:'report'},
    source:{name:'synthetic-fixture',version:'1',fetchedAt:new Date(now-60000).toISOString(),expiresAt:new Date(now+60000).toISOString()}}}});
  assert.notEqual(gate.isError,true);
  const receipt=JSON.parse((gate.content as {text:string}[])[0]!.text);
  assert.equal(receipt.commandExitCode,0);assert.equal(receipt.publication.status,'not-configured');
  assert.equal(JSON.parse(await fs.readFile(path.join(root,receipt.artifactPath),'utf8')).receiptId,receipt.receiptId);
});
