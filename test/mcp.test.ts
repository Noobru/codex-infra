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
