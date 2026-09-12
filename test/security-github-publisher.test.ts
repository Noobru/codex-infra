import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {ProjectRegistry} from '../src/registry.js';
import {SecurityReportService,type SecurityReportRequest} from '../src/security-report-service.js';
import {GitHubCommitStatusPublisher} from '../src/security-github-publisher.js';

const sha='a'.repeat(40);

async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'github-status-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'project');await fs.mkdir(project);
  await fs.writeFile(path.join(project,'report.json'),JSON.stringify({Results:[{Target:'fixture',Vulnerabilities:[]}]}));
  const registryPath=path.join(root,'profiles.json');
  await fs.writeFile(registryPath,JSON.stringify({version:1,projects:[{id:'fixture',name:'Fixture',root:project,status:'active',stack:[],
    modes:['read-only'],sourceRoots:[],sources:[],checks:[],securityPublisher:{id:'github-status',kind:'github-check',target:'octocat/example',enabled:true,stages:['report']}}]}));
  let requests=0;let body:unknown=null;let authorization='';let requestPath='';let requestMethod='';
  const server=http.createServer(async(req,res)=>{requests++;authorization=String(req.headers.authorization??'');
    requestPath=req.url??'';requestMethod=req.method??'';
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({id:42,url:'http://127.0.0.1/status/42',created_at:new Date().toISOString()}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture server missing address');
  const publisher=new GitHubCommitStatusPublisher({token:'test-token',baseUrl:'http://127.0.0.1:'+address.port});
  const service=new SecurityReportService(root,new ProjectRegistry(registryPath),{publishers:[publisher]});
  const input:SecurityReportRequest={reportPath:'report.json',format:'trivy-json',subject:{asset:'fixture',environment:'local',sha,stage:'report'},
    source:{name:'fixture',version:'1',fetchedAt:'2026-09-11T00:00:00Z',expiresAt:'2026-09-13T00:00:00Z'},evaluatedAt:'2026-09-12T00:00:00Z'};
  return {root,service,input,get:()=>({requests,body,authorization,requestPath,requestMethod})};
}

function authority(){const now=Date.now();return {granted:true as const,action:'publish-security-status' as const,projectId:'fixture',publisherId:'github-status',
  target:'octocat/example',sha,stage:'report' as const,authorizedBy:'Fixture Owner',evidence:'explicit fixture publication',
  authorizedAt:new Date(now-60_000).toISOString(),expiresAt:new Date(now+60_000).toISOString()};}

test('service keeps GitHub publisher dry-run and unauthorized requests off the network',async t=>{
  const data=await fixture(t);
  const dry=await data.service.evaluate('fixture',{...data.input,publication:{mode:'dry-run'}});
  assert.equal(dry.publication.status,'dry-run');assert.equal(data.get().requests,0);
  const denied=await data.service.evaluate('fixture',{...data.input,publication:{mode:'publish'}});
  assert.equal(denied.publication.status,'authorization-required');assert.equal(data.get().requests,0);
  const wrongTarget={...authority(),target:'octocat/other'};
  const mismatched=await data.service.evaluate('fixture',{...data.input,publication:{mode:'publish',publisherId:'github-status',authorization:wrongTarget}});
  assert.equal(mismatched.publication.status,'authorization-required');assert.equal(data.get().requests,0);
});

test('exact authority publishes one bounded GitHub commit status without persisting token',async t=>{
  const data=await fixture(t);
  const result=await data.service.evaluate('fixture',{...data.input,publication:{mode:'publish',publisherId:'github-status',authorization:authority()}});
  assert.equal(result.publication.status,'published');assert.equal(data.get().requests,1);
  assert.equal(data.get().authorization,'Bearer test-token');
  assert.equal(data.get().requestMethod,'POST');assert.equal(data.get().requestPath,'/repos/octocat/example/statuses/'+sha);
  assert.deepEqual(data.get().body,{state:'success',description:'security-policy-v1 PASS; local exit 0',context:'codex-infra/security-policy'});
  const persisted=await fs.readFile(path.join(data.root,result.publication.artifactPath),'utf8');
  assert.equal(persisted.includes('test-token'),false);assert.equal(result.publication.externalReceipt?.externalId,'42');
});

test('publisher rejects missing credentials, invalid targets and non-loopback HTTP',async()=>{
  assert.throws(()=>new GitHubCommitStatusPublisher({baseUrl:'http://example.com'}),/url_not_allowed/);
  const publisher=new GitHubCommitStatusPublisher();
  await assert.rejects(publisher.publish({version:1,publisherId:'github-status',kind:'github-check',target:'octocat/example',projectId:'fixture',sha,
    stage:'report',decision:'PASS',blocking:false,reportHash:'b'.repeat(64),summary:'PASS'},
  {idempotencyKey:'fixture',intentArtifactPath:'artifacts/fixture.intent.json'}),/token_missing/);
});
