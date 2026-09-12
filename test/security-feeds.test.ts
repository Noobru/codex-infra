import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {z} from 'zod';
import {
  CisaKevSecurityFeed,OsvSecurityFeed,SecurityFeedCorrelationService,SecurityFeedHttpClient,
} from '../src/security-feeds.js';

async function serverFixture(t:test.TestContext,options:{kevCount?:number}={}){
  let requests=0;const bodies:unknown[]=[];
  const server=http.createServer(async(req,res)=>{requests++;
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const raw=Buffer.concat(chunks).toString('utf8');if(raw)bodies.push(JSON.parse(raw));
    res.setHeader('content-type','application/json');res.setHeader('etag','fixture-etag');
    if(req.url==='/v1/query')return res.end(JSON.stringify({vulns:[{id:'GHSA-demo-0001',aliases:['CVE-2026-0001'],
      modified:'2026-09-12T00:00:00Z',summary:'Fixture advisory'}]}));
    if(req.url==='/kev')return res.end(JSON.stringify({title:'CISA KEV fixture',catalogVersion:'2026.09.12',dateReleased:'2026-09-12',
      count:options.kevCount??1,vulnerabilities:[{cveID:'CVE-2026-0001',vendorProject:'Fixture',product:'Demo',
        vulnerabilityName:'Fixture Vulnerability',dateAdded:'2026-09-12',shortDescription:'Fixture only',
        requiredAction:'Update fixture',dueDate:'2026-09-13',knownRansomwareCampaignUse:'Unknown',notes:''}]}));
    res.statusCode=404;res.end('{}');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();if(!address||typeof address==='string')throw new Error('server address unavailable');
  return {base:'http://127.0.0.1:'+address.port,get:()=>({requests,bodies})};
}

test('correlates exact OSV package/version and CVE alias with fresh CISA KEV provenance',async t=>{
  const fixture=await serverFixture(t);const httpClient=new SecurityFeedHttpClient();
  const service=new SecurityFeedCorrelationService(new OsvSecurityFeed(httpClient,fixture.base),new CisaKevSecurityFeed(httpClient,fixture.base+'/kev'));
  const input=[{findingId:'CVE-2026-0001',ecosystem:'npm',packageName:'demo',installedVersion:'1.0.0'}];
  const receipt=await service.correlate(input);
  assert.deepEqual(fixture.get().bodies,[{package:{ecosystem:'npm',name:'demo'},version:'1.0.0'}]);
  assert.equal(receipt.findings[0]?.status,'matched');assert.equal(receipt.findings[0]?.knownExploited,true);
  assert.equal(receipt.assertions[0]?.value,true);assert.equal(receipt.enrichments[0]?.knownExploited,true);
  assert.match(receipt.provenance.osv[0]?.bodySha256??'',/^[0-9a-f]{64}$/);
  assert.equal(receipt.provenance.kev?.etag,'fixture-etag');assert.ok(Date.parse(receipt.expiresAt)>Date.now());

  const cached=await service.correlate(input);
  assert.equal(fixture.get().requests,2);assert.equal(cached.provenance.osv[0]?.cacheHit,true);assert.equal(cached.provenance.kev?.cacheHit,true);
});

test('does not infer applicability or fetch KEV when finding ID does not match OSV ID or aliases',async t=>{
  const fixture=await serverFixture(t);const httpClient=new SecurityFeedHttpClient();
  const service=new SecurityFeedCorrelationService(new OsvSecurityFeed(httpClient,fixture.base),new CisaKevSecurityFeed(httpClient,fixture.base+'/kev'));
  const receipt=await service.correlate([{findingId:'CVE-2026-9999',ecosystem:'npm',packageName:'demo',installedVersion:'1.0.0'}]);
  assert.equal(receipt.findings[0]?.status,'not-matched');assert.deepEqual(receipt.assertions,[]);assert.deepEqual(receipt.enrichments,[]);
  assert.deepEqual(receipt.unknowns,['CVE-2026-9999:osv_not_matched']);assert.equal(fixture.get().requests,1);
});

test('rejects malformed KEV completeness and unsafe feed URLs',async t=>{
  const fixture=await serverFixture(t,{kevCount:2});const client=new SecurityFeedHttpClient();
  await assert.rejects(new CisaKevSecurityFeed(client,fixture.base+'/kev').read(),/KEV count/);
  await assert.rejects(client.json({source:'cisa-kev',method:'GET',url:fixture.base+'/kev',ttlMs:1000,timeoutMs:1000,maxBytes:2,
    schema:z.unknown()}),/response_too_large/);
  await assert.rejects(client.json({source:'cisa-kev',method:'GET',url:'http://example.com/kev',ttlMs:1000,timeoutMs:1000,maxBytes:1000,
    schema:z.unknown()}),/url_not_allowed/);
});
