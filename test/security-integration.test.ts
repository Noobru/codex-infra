import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {ProjectRegistry} from '../src/registry.js';
import {CisaKevSecurityFeed,OsvSecurityFeed,SecurityFeedCorrelationService,SecurityFeedHttpClient} from '../src/security-feeds.js';
import {GITHUB_TOKEN_ENVIRONMENT_VARIABLE,SecurityIntegrationFacade} from '../src/security-integration.js';

const sha='d'.repeat(40);

async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'security-integration-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'project');await fs.mkdir(project);
  await fs.writeFile(path.join(project,'report.json'),JSON.stringify({Results:[{Target:'package-lock.json',Vulnerabilities:[{
    VulnerabilityID:'CVE-2026-0404',PkgName:'demo',InstalledVersion:'1.0.0',Severity:'HIGH',Title:'Fixture only',
  }]}]}));
  await fs.writeFile(path.join(project,'low-report.json'),JSON.stringify({Results:[{Target:'package-lock.json',Vulnerabilities:[{
    VulnerabilityID:'CVE-2026-0404',PkgName:'demo',InstalledVersion:'1.0.0',Severity:'LOW',Title:'Fixture only',
  }]}]}));
  const registryPath=path.join(root,'profiles.json');
  await fs.writeFile(registryPath,JSON.stringify({version:1,projects:[{id:'fixture',name:'Fixture',root:project,status:'active',stack:[],
    modes:['read-only'],sourceRoots:[],sources:[],checks:[],securityPublisher:{id:'github-status',kind:'github-check',
      target:'octocat/example',enabled:true,stages:['report']}}]}));
  let feedRequests=0;let githubRequests=0;let githubAuthorization='';
  const server=http.createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/query'){
      feedRequests++;
      return res.end(JSON.stringify({vulns:[{id:'GHSA-fixture-0404',aliases:['CVE-2026-0404'],modified:new Date().toISOString()}]}));
    }
    if(req.url==='/kev'){
      feedRequests++;
      return res.end(JSON.stringify({title:'KEV fixture',catalogVersion:'fixture-1',dateReleased:new Date().toISOString(),count:0,vulnerabilities:[]}));
    }
    if(req.url==='/fail/v1/query'){
      feedRequests++;res.statusCode=503;return res.end('{}');
    }
    if(req.url==='/empty/v1/query'){
      feedRequests++;return res.end(JSON.stringify({vulns:[]}));
    }
    if(req.url==='/repos/octocat/example/statuses/'+sha){
      githubRequests++;githubAuthorization=String(req.headers.authorization??'');res.statusCode=201;
      return res.end(JSON.stringify({id:71,url:'http://127.0.0.1/status/71',created_at:new Date().toISOString()}));
    }
    res.statusCode=404;return res.end('{}');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture server unavailable');
  const baseUrl='http://127.0.0.1:'+address.port;
  const registry=new ProjectRegistry(registryPath);
  const feeds=(osvBase=baseUrl)=>{const client=new SecurityFeedHttpClient();return new SecurityFeedCorrelationService(
    new OsvSecurityFeed(client,osvBase),new CisaKevSecurityFeed(client,baseUrl+'/kev'))};
  const now=Date.now();
  const authority={granted:true as const,action:'publish-security-status' as const,projectId:'fixture',publisherId:'github-status',
    target:'octocat/example',sha,stage:'report' as const,authorizedBy:'Fixture Owner',evidence:'fixture exact authority',
    authorizedAt:new Date(now-60_000).toISOString(),expiresAt:new Date(now+60_000).toISOString()};
  const input={reportPath:'report.json',format:'trivy-json' as const,subject:{asset:'fixture',environment:'local',sha,stage:'report' as const},
    source:{name:'fixture',version:'1',fetchedAt:new Date(now-60_000).toISOString(),expiresAt:new Date(now+3_600_000).toISOString()},
    evaluatedAt:new Date(now).toISOString(),assertions:[
      {findingId:'CVE-2026-0404',kind:'exposure' as const,value:true,source:'runtime' as const,evidence:'fixture exposure'},
      {findingId:'CVE-2026-0404',kind:'reachability' as const,value:true,source:'runtime' as const,evidence:'fixture reachability'},
    ],enrichments:[],exceptions:[],publication:{mode:'publish' as const,publisherId:'github-status',authorization:authority},
    feeds:{mode:'enrich' as const,findings:[{findingId:'CVE-2026-0404',ecosystem:'npm',packageName:'demo',installedVersion:'1.0.0'}]}};
  return {root,registry,feeds,baseUrl,input,get:()=>({feedRequests,githubRequests,githubAuthorization})};
}

test('facade enriches the gate and publishes only through exact service authority',async t=>{
  const data=await fixture(t);
  const facade=new SecurityIntegrationFacade(data.root,data.registry,{feeds:data.feeds(),githubBaseUrl:data.baseUrl,
    environment:{[GITHUB_TOKEN_ENVIRONMENT_VARIABLE]:'fixture-token'}});
  const result=await facade.evaluate('fixture',data.input);
  assert.equal(result.feed.status,'READY');assert.equal(result.feed.publicationSuppressed,false);
  assert.equal(result.report.decision,'WARN');assert.equal(result.effective.decision,'WARN');
  assert.equal(result.report.publication.status,'published');assert.equal(result.effective.commandExitCode,0);
  assert.deepEqual(data.get(),{feedRequests:2,githubRequests:1,githubAuthorization:'Bearer fixture-token'});
  const artifact=await fs.readFile(path.join(data.root,result.report.publication.artifactPath),'utf8');
  assert.equal(artifact.includes('fixture-token'),false);
});

test('facade preserves UNKNOWN and suppresses requested publication on absent or failed feed evidence',async t=>{
  const data=await fixture(t);
  const absent={...data.input,reportPath:'low-report.json'};
  const facade=new SecurityIntegrationFacade(data.root,data.registry,{feeds:data.feeds(data.baseUrl+'/empty'),githubBaseUrl:data.baseUrl,
    environment:{[GITHUB_TOKEN_ENVIRONMENT_VARIABLE]:'fixture-token'}});
  const absentResult=await facade.evaluate('fixture',absent);
  assert.equal(absentResult.feed.status,'UNKNOWN');assert.equal(absentResult.feed.publicationSuppressed,true);
  assert.equal(absentResult.report.decision,'PASS');
  assert.equal(absentResult.report.integrationRequired,true);
  assert.equal(absentResult.effective.decision,'UNKNOWN');assert.equal(absentResult.effective.commandExitCode,3);
  assert.equal(absentResult.report.publication.status,'dry-run');assert.equal(data.get().githubRequests,0);
  const persisted=JSON.parse(await fs.readFile(path.join(data.root,absentResult.integrationArtifactPath),'utf8')) as {
    gateReceiptId:string;reportHash:string;reportArtifactPath:string;
    effective:{decision:string;commandExitCode:number};feed:{status:string;publicationSuppressed:boolean;
      correlation:{provenance:{osv:{bodySha256:string;url:string}[]}}};
  };
  assert.equal(persisted.gateReceiptId,absentResult.report.receiptId);
  assert.equal(persisted.reportHash,absentResult.report.reportHash);
  assert.equal(persisted.reportArtifactPath,absentResult.report.artifactPath);
  assert.deepEqual(persisted.effective,{decision:'UNKNOWN',blocking:false,
    localGate:{policyVersion:'security-local-exit-v1',stage:'report',decision:'UNKNOWN',blocking:false,exitCode:0},commandExitCode:3});
  assert.equal(persisted.feed.status,'UNKNOWN');assert.equal(persisted.feed.publicationSuppressed,true);
  assert.match(persisted.feed.correlation.provenance.osv[0]!.bodySha256,/^[0-9a-f]{64}$/);
  assert.equal(persisted.feed.correlation.provenance.osv[0]!.url,data.baseUrl+'/empty/v1/query');
  const baseReceipt=JSON.parse(await fs.readFile(path.join(data.root,absentResult.report.artifactPath),'utf8')) as {integrationRequired:boolean};
  assert.equal(baseReceipt.integrationRequired,true);

  const failedFacade=new SecurityIntegrationFacade(data.root,data.registry,{feeds:data.feeds(data.baseUrl+'/fail'),githubBaseUrl:data.baseUrl,
    environment:{[GITHUB_TOKEN_ENVIRONMENT_VARIABLE]:'fixture-token'}});
  const failedResult=await failedFacade.evaluate('fixture',data.input);
  assert.equal(failedResult.feed.status,'UNKNOWN');assert.deepEqual(failedResult.feed.unknowns,['security_feeds_unavailable']);
  assert.match(failedResult.feed.error??'',/security_feed_http_503/);assert.equal(failedResult.report.publication.status,'dry-run');
  assert.equal(data.get().githubRequests,0);
});
