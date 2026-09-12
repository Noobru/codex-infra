import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SecurityPolicyGate, type SecurityGateInput } from '../src/security-gate.js';
import { LocalSecurityGateAdapter } from '../src/security-report-publisher.js';

const sha = 'a'.repeat(40);
const evaluatedAt = '2026-09-12T12:00:00.000Z';
const gate = new SecurityPolicyGate();

async function fixture(t: test.TestContext, severity: string, id = 'CVE-2026-0001') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'security-gate-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const reportPath = path.join(root, 'trivy.json');
  await fs.writeFile(reportPath, JSON.stringify({SchemaVersion:2, ArtifactName:'fixture', Results:[{
    Target:'requirements.txt', Class:'lang-pkgs', Type:'pip', Vulnerabilities:[{
      VulnerabilityID:id, PkgName:'example', InstalledVersion:'1.0.0', FixedVersion:'1.0.1', Severity:severity,
      Title:'Realistic Trivy vulnerability record',
    }],
  }]}));
  return reportPath;
}

function input(reportPath:string, stage: SecurityGateInput['subject']['stage'] = 'deploy-production'): SecurityGateInput {
  return {
    reportPath, format:'trivy-json', subject:{asset:'example-api',environment:'production',sha,stage},
    source:{name:'trivy',version:'0.74.0',fetchedAt:'2026-09-12T11:00:00.000Z',expiresAt:'2026-09-13T11:00:00.000Z'},
    assertions:[], enrichments:[], exceptions:[], evaluatedAt,
  };
}

const assertion = (findingId:string, kind:'applicability'|'reachability'|'exposure', value:boolean, source:'scanner'|'runtime'|'model' = 'scanner') =>
  ({findingId,kind,value,source,evidence:`${kind} evidence`}) as const;

test('parses a realistic Trivy report and blocks a proven applicable critical in production', async t => {
  const reportPath = await fixture(t, 'CRITICAL');
  const receipt = await gate.evaluateReport({...input(reportPath), assertions:[assertion('CVE-2026-0001','applicability',true)]});
  assert.equal(receipt.decision, 'BLOCK');
  assert.equal(receipt.blocking, true);
  assert.equal(receipt.policyVersion, 'security-policy-v1');
  assert.match(receipt.reportHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(receipt.findings[0], {
    id:'CVE-2026-0001', packageName:'example', installedVersion:'1.0.0', fixedVersion:'1.0.1',
    severity:'CRITICAL', target:'requirements.txt', evidence:'Realistic Trivy vulnerability record',
  });
});

test('missing Trivy Results is unknown rather than a false pass', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'security-gate-empty-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const reportPath = path.join(root, 'trivy.json');
  await fs.writeFile(reportPath, JSON.stringify({SchemaVersion:2, ArtifactName:'incomplete'}));
  const receipt = await gate.evaluateReport(input(reportPath));
  assert.equal(receipt.decision, 'UNKNOWN');
  assert.equal(receipt.blocking, true);
  assert.ok(receipt.unknowns.includes('trivy_results_missing_or_empty'));
});

test('UNKNOWN has the canonical proportional exit for each stage', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'security-gate-stage-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const reportPath = path.join(root, 'incomplete.json');
  await fs.writeFile(reportPath, JSON.stringify({SchemaVersion:2,ArtifactName:'incomplete'}));
  const adapter = new LocalSecurityGateAdapter();
  for (const [stage,exitCode] of [['report',0],['ci',0],['deploy-production',2]] as const) {
    const receipt = await gate.evaluateReport(input(reportPath,stage));
    assert.equal(receipt.decision,'UNKNOWN');
    assert.equal(adapter.map(receipt).exitCode,exitCode);
  }
});

test('a malformed Trivy Result without a target cannot certify an assessment', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'security-gate-result-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const reportPath = path.join(root, 'trivy.json');
  await fs.writeFile(reportPath, JSON.stringify({Results:[{}]}));
  await assert.rejects(gate.evaluateReport(input(reportPath)), /Target/);
});

test('invalid JSON and oversized reports fail before policy evaluation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'security-gate-bounds-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const invalid = path.join(root, 'invalid.json');
  await fs.writeFile(invalid, '{invalid');
  await assert.rejects(gate.evaluateReport(input(invalid)), /security_report_invalid_json/);
  const oversized = path.join(root, 'oversized.json');
  const handle = await fs.open(oversized, 'w');
  await handle.truncate(SecurityPolicyGate.maxReportBytes + 1);
  await handle.close();
  await assert.rejects(gate.evaluateReport(input(oversized)), /security_report_too_large/);
});

test('a proven irrelevant finding passes while a model-only applicability claim remains unknown', async t => {
  const reportPath = await fixture(t, 'CRITICAL');
  const irrelevant = await gate.evaluateReport({...input(reportPath), assertions:[assertion('CVE-2026-0001','applicability',false)]});
  assert.equal(irrelevant.decision, 'PASS');
  const modelOnly = await gate.evaluateReport({...input(reportPath), assertions:[assertion('CVE-2026-0001','applicability',true,'model')]});
  assert.equal(modelOnly.decision, 'UNKNOWN');
  assert.equal(modelOnly.blocking, true);
});

test('conflicting trusted assertions remain unknown', async t => {
  const reportPath = await fixture(t, 'CRITICAL');
  const receipt = await gate.evaluateReport({...input(reportPath), assertions:[
    assertion('CVE-2026-0001','applicability',true,'scanner'),
    assertion('CVE-2026-0001','applicability',false,'runtime'),
  ]});
  assert.equal(receipt.decision, 'UNKNOWN');
  assert.ok(receipt.unknowns.includes('CVE-2026-0001:insufficient_trusted_context'));
});

test('an unrelated not-applicable reason cannot turn an excepted material risk into a block', async t => {
  const reportPath = await fixture(t, 'CRITICAL', 'CVE-2026-0001');
  const raw = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  raw.Results[0].Vulnerabilities.push({VulnerabilityID:'CVE-2026-0002',PkgName:'other',InstalledVersion:'2.0.0',Severity:'CRITICAL'});
  await fs.writeFile(reportPath, JSON.stringify(raw));
  const receipt = await gate.evaluateReport({...input(reportPath), assertions:[
    assertion('CVE-2026-0001','applicability',true), assertion('CVE-2026-0002','applicability',false),
  ], exceptions:[{
    findingId:'CVE-2026-0001',asset:'example-api',environment:'production',sha,authorizedBy:'Fixture Owner',
    reason:'bounded deployment exception',compensatingControl:'network isolation',expiresAt:'2026-09-13T12:00:00.000Z',
  }]});
  assert.equal(receipt.decision, 'WARN');
  assert.equal(receipt.blocking, false);
});

test('high blocks only with trusted applicability, exposure and reachability evidence', async t => {
  const reportPath = await fixture(t, 'HIGH');
  const receipt = await gate.evaluateReport({...input(reportPath), assertions:[
    assertion('CVE-2026-0001','applicability',true), assertion('CVE-2026-0001','exposure',true,'runtime'),
    assertion('CVE-2026-0001','reachability',true,'runtime'),
  ]});
  assert.equal(receipt.decision, 'BLOCK');
});

test('report and CI expose uncertainty or risk without becoming a production authorization gate', async t => {
  const reportPath = await fixture(t, 'CRITICAL');
  const unknown = await gate.evaluateReport({...input(reportPath,'report'), assertions:[]});
  assert.equal(unknown.decision, 'UNKNOWN');
  assert.equal(unknown.blocking, false);
  const warning = await gate.evaluateReport({...input(reportPath,'ci'), assertions:[assertion('CVE-2026-0001','applicability',true)]});
  assert.equal(warning.decision, 'WARN');
  assert.equal(warning.blocking, false);
});

test('a stale source cannot pass and an expired scoped exception requires a current exception', async t => {
  const reportPath = await fixture(t, 'CRITICAL');
  const stale = input(reportPath);
  stale.source.expiresAt = '2026-09-12T11:59:59.000Z';
  const staleReceipt = await gate.evaluateReport({...stale, assertions:[assertion('CVE-2026-0001','applicability',false)]});
  assert.equal(staleReceipt.decision, 'UNKNOWN');
  const expired = await gate.evaluateReport({...input(reportPath), assertions:[assertion('CVE-2026-0001','applicability',true)], exceptions:[{
    findingId:'CVE-2026-0001',asset:'example-api',environment:'production',sha,authorizedBy:'Fixture Owner',
    reason:'temporary acceptance',compensatingControl:'asset isolated',expiresAt:'2026-09-12T11:59:59.000Z',
  }]});
  assert.equal(expired.decision, 'EXCEPTION_REQUIRED');
  assert.equal(expired.blocking, true);
});

test('a current exception is exact to finding, asset, environment and SHA', async t => {
  const reportPath = await fixture(t, 'CRITICAL');
  const receipt = await gate.evaluateReport({...input(reportPath), assertions:[assertion('CVE-2026-0001','applicability',true)], exceptions:[{
    findingId:'CVE-2026-0001',asset:'example-api',environment:'production',sha,authorizedBy:'Fixture Owner',
    reason:'bounded deployment exception',compensatingControl:'network isolation',expiresAt:'2026-09-13T12:00:00.000Z',
  }]});
  assert.equal(receipt.decision, 'WARN');
  assert.equal(receipt.blocking, false);
  assert.deepEqual(receipt.exceptionsApplied, ['CVE-2026-0001']);
});
