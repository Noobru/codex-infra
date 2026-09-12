import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectRegistry} from '../src/registry.js';
import {SecurityReportService, type SecurityReportRequest} from '../src/security-report-service.js';
import type {
  SecurityPublicationAuthorization, SecurityPublisherConfig, SecurityStatusProposal, SecurityStatusPublisher,
} from '../src/security-report-publisher.js';

const evaluatedAt = '2026-09-12T00:00:00Z';
const sha = 'a'.repeat(40);
const publisherConfig: SecurityPublisherConfig = {
  id:'fixture-publisher', kind:'github-check', target:'fixture/example', enabled:true,
  stages:['report','ci','deploy-production'],
};

class FakePublisher implements SecurityStatusPublisher {
  readonly id = publisherConfig.id;
  readonly kind = publisherConfig.kind;
  publishCalls = 0;
  intentObservedBeforePublish = false;
  constructor(private readonly root:string) {}

  propose({projectId,config,gate}:Parameters<SecurityStatusPublisher['propose']>[0]):SecurityStatusProposal {
    return {
      version:1, publisherId:this.id, kind:this.kind, target:config.target, projectId,
      sha:gate.subject.sha, stage:gate.subject.stage, decision:gate.decision,
      blocking:gate.blocking, reportHash:gate.reportHash,
      summary:'security-policy-v1 ' + gate.decision,
    };
  }

  async publish(proposal:SecurityStatusProposal,options:Parameters<SecurityStatusPublisher['publish']>[1]) {
    this.publishCalls++;
    const intent = JSON.parse(await fs.readFile(path.join(this.root,options.intentArtifactPath),'utf8'));
    this.intentObservedBeforePublish = intent.idempotencyKey === options.idempotencyKey
      && intent.proposal.reportHash === proposal.reportHash;
    return {
      externalId:'fake-publication-1',
      publishedAt:new Date().toISOString(),
      url:'https://example.invalid/fake-publication-1',
    };
  }
}

async function setup(t:test.TestContext,withPublisher=false) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'infra-report-scope-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const projectRoot=path.join(root,'project');
  await fs.mkdir(projectRoot);
  const report=JSON.stringify({Results:[{Target:'package-lock.json',Vulnerabilities:[]}]});
  await fs.writeFile(path.join(projectRoot,'report.json'),report);
  await fs.writeFile(path.join(root,'outside.json'),report);
  const registryPath=path.join(root,'profiles','registry.json');
  await fs.mkdir(path.dirname(registryPath),{recursive:true});
  await fs.writeFile(registryPath,JSON.stringify({version:1,projects:[{
    id:'example',name:'Example',root:projectRoot,status:'active',stack:[],modes:['read-only'],
    sourceRoots:[],sources:[],checks:[],...(withPublisher?{securityPublisher:publisherConfig}:{}),
  }]}));
  const fake=withPublisher?new FakePublisher(root):undefined;
  const service=new SecurityReportService(root,new ProjectRegistry(registryPath),{
    publishers:fake?[fake]:[],
  });
  const input:SecurityReportRequest={
    reportPath:'report.json',format:'trivy-json',
    subject:{asset:'fixture',environment:'local',sha,stage:'report'},
    source:{name:'fixture',version:'1',fetchedAt:'2026-09-11T00:00:00Z',expiresAt:'2026-09-13T00:00:00Z'},
    evaluatedAt,
  };
  return {root,service,input,fake,report};
}

function authority(overrides:Partial<SecurityPublicationAuthorization>={}) {
  const now=Date.now();
  return {
    granted:true as const, action:'publish-security-status' as const, projectId:'example',
    publisherId:'fixture-publisher',target:'fixture/example',sha,stage:'report' as const,
    authorizedBy:'Fixture Owner',evidence:'explicit request for this exact local fixture publication',
    authorizedAt:new Date(now-60_000).toISOString(),
    expiresAt:new Date(now+60_000).toISOString(),
    ...overrides,
  };
}

test('service confines reads, preserves hash and writes durable gate and dry-run receipts',async t=>{
  const {root,service,input,report}=await setup(t);
  const result=await service.evaluate('example',input);
  assert.equal(result.decision,'PASS');
  assert.equal(result.localGate.exitCode,0);
  assert.equal(result.commandExitCode,0);
  assert.equal(result.reportHash,createHash('sha256').update(report).digest('hex'));
  const durable=JSON.parse(await fs.readFile(path.join(root,result.artifactPath),'utf8'));
  assert.equal(durable.receiptId,result.receiptId);
  assert.equal(durable.reportHash,result.reportHash);
  assert.equal(result.integrationRequired,false);
  assert.equal(durable.integrationRequired,false);
  assert.equal(result.publication.status,'not-configured');
  assert.equal(result.publication.proposal,null);
  await fs.access(path.join(root,result.publication.artifactPath));

  const before=(await fs.readdir(path.join(root,'artifacts','security-gates'))).length;
  await assert.rejects(service.evaluate('example',{...input,reportPath:'../outside.json'}),/outside the selected project root/);
  assert.equal((await fs.readdir(path.join(root,'artifacts','security-gates'))).length,before);
  await assert.rejects(service.evaluate('absent',input),/Unknown project/);
});

test('configured publisher produces a durable dry-run proposal without calling publish',async t=>{
  const {root,service,input,fake}=await setup(t,true);
  const result=await service.evaluate('example',{...input,publication:{mode:'dry-run'}});
  assert.equal(result.publication.status,'dry-run');
  assert.equal(result.publication.proposal?.publisherId,'fixture-publisher');
  assert.equal(result.publication.proposal?.reportHash,result.reportHash);
  assert.equal(fake?.publishCalls,0);
  const durable=JSON.parse(await fs.readFile(path.join(root,result.publication.artifactPath),'utf8'));
  assert.equal(durable.status,'dry-run');
  assert.equal(durable.externalReceipt,null);
});

test('publish requires fresh exact request authority and never calls the adapter on a mismatch',async t=>{
  const {service,input,fake}=await setup(t,true);
  const missing=await service.evaluate('example',{...input,publication:{mode:'publish'}});
  assert.equal(missing.publication.status,'authorization-required');
  assert.equal(missing.commandExitCode,3);
  const wrongSha=await service.evaluate('example',{...input,publication:{
    mode:'publish',authorization:authority({sha:'b'.repeat(40)}),
  }});
  assert.equal(wrongSha.publication.status,'authorization-required');
  const expired=await service.evaluate('example',{...input,publication:{
    mode:'publish',authorization:authority({expiresAt:new Date(Date.now()-1).toISOString()}),
  }});
  assert.equal(expired.publication.status,'authorization-required');
  assert.equal(fake?.publishCalls,0);
});

test('exact fresh authority persists intent before one injected publisher call and then persists result',async t=>{
  const {root,service,input,fake}=await setup(t,true);
  const result=await service.evaluate('example',{...input,publication:{
    mode:'publish',publisherId:'fixture-publisher',authorization:authority(),
  }});
  assert.equal(result.publication.status,'published');
  assert.equal(result.commandExitCode,0);
  assert.equal(fake?.publishCalls,1);
  assert.equal(fake?.intentObservedBeforePublish,true);
  assert.ok(result.publication.intentArtifactPath);
  await fs.access(path.join(root,result.publication.intentArtifactPath!));
  const durable=JSON.parse(await fs.readFile(path.join(root,result.publication.artifactPath),'utf8'));
  assert.equal(durable.status,'published');
  assert.equal(durable.externalReceipt.externalId,'fake-publication-1');
});
