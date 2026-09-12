import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GIdeiaBootstrap,type GIdeiaBootstrapInput} from '../src/g-ideia-bootstrap.js';
import {KnowledgeFiles} from '../src/knowledge-store.js';
import {TaskEngine} from '../src/engine.js';

class BootstrapFixture {
  readonly infra:string;readonly vault:string;readonly project:string;readonly bootstrap:GIdeiaBootstrap;
  readonly input:GIdeiaBootstrapInput;
  constructor(readonly root:string){
    this.infra=path.join(root,'infra');this.vault=path.join(root,'coding');this.project=path.join(root,'project');
    this.bootstrap=new GIdeiaBootstrap(this.infra,fileURLToPath(new URL('../../templates/g-ideia',import.meta.url)));
    this.input={vaultPath:this.vault,project:{id:'fixture-g-ideia',name:'Projeto de Teste',code:'123',root:this.project}};
  }
  static async create(t:TestContext,contract='Owner rules must stay byte-exact.\r\nNo deployment.\r\n'){
    const parent=fileURLToPath(new URL('../../artifacts/test-fixtures/',import.meta.url));
    await fs.mkdir(parent,{recursive:true});
    const fixture=new BootstrapFixture(await fs.mkdtemp(path.join(parent,'g-ideia-')));
    t.after(()=>fs.rm(fixture.root,{recursive:true,force:true}));
    await fs.mkdir(fixture.infra);await fs.mkdir(fixture.project);
    await fs.mkdir(path.join(fixture.vault,'600 - Projetos'),{recursive:true});
    await fs.writeFile(path.join(fixture.vault,'AGENTS.md'),contract);
    return fixture;
  }
  async snapshot(){
    const result:Record<string,string>={};
    const visit=async(directory:string):Promise<void>=>{
      for(const entry of await fs.readdir(directory,{withFileTypes:true})){
        const target=path.join(directory,entry.name),key=path.relative(this.root,target);
        if(entry.isDirectory()){result[key]='directory';await visit(target);}
        else result[key]=KnowledgeFiles.hash(await fs.readFile(target));
      }
    };
    await visit(this.root);return result;
  }
}

test('inspection and default plan expose changes and hashes without writing or creating execution state',async t=>{
  const fixture=await BootstrapFixture.create(t),before=await fixture.snapshot();
  const inspection=await fixture.bootstrap.inspect({vaultPath:fixture.vault});
  const plan=await fixture.bootstrap.plan(fixture.input);
  assert.deepEqual(await fixture.snapshot(),before);
  assert.equal(inspection.contractState,'missing-g-ideia');assert.equal(plan.ready,true);
  assert.equal(plan.contract.action,'append');assert.equal(plan.contract.contractSha256,inspection.contractSha256);
  assert.match(plan.contract.templateSha256,/^[a-f0-9]{64}$/);assert.ok(plan.contract.backupPath?.endsWith('.bak'));
  assert.equal(plan.project?.notes.length,5);assert.ok(plan.project?.notes.every(note=>note.action==='create'));
  assert.deepEqual(plan.project?.profile.modes,['read-only']);assert.deepEqual(plan.project?.profile.checkIds,[]);
  assert.equal(JSON.stringify(plan).includes('Owner rules must stay byte-exact.'),false);
  assert.ok(plan.nextSteps.some(step=>step.includes('Contrato coding, PRD, PREVC')));
});

test('apply preserves contract bytes and backup, creates bound drafts and remains idempotent without a job',async t=>{
  const fixture=await BootstrapFixture.create(t),contractPath=path.join(fixture.vault,'AGENTS.md');
  const original=await fs.readFile(contractPath),result=await fixture.bootstrap.scaffoldProject(fixture.input as GIdeiaBootstrapInput&{project:NonNullable<GIdeiaBootstrapInput['project']>});
  const updated=await fs.readFile(contractPath);
  assert.deepEqual(updated.subarray(0,original.length),original);
  assert.deepEqual(await fs.readFile(result.backupPath!),original);
  assert.equal(result.backupSha256,KnowledgeFiles.hash(original));
  assert.equal(result.executedJobs,0);assert.equal(result.notionState,'not-synchronized');
  assert.equal(updated.toString().split('<!-- codex-infra:g-ideia:v1:start -->').length-1,1);
  for(const note of result.notes){
    const content=await fs.readFile(note.path,'utf8');assert.ok(content.includes('Projeto de Teste'));assert.equal(content.includes('{{'),false);
  }
  const engine=new TaskEngine(fixture.infra);
  try{
    assert.equal(engine.state.list().length,0);
    const profile=await engine.registry.resolve('fixture-g-ideia');
    assert.deepEqual(profile.modes,['read-only']);assert.deepEqual(profile.checks,[]);
    assert.deepEqual(profile.sourceRoots,[await fs.realpath(fixture.vault)]);
    assert.deepEqual(profile.sources.map(source=>source.label),['Contrato coding','Control Plane local','PRD','PREVC','SPEC','Evidências']);
    const context=await engine.projectContext(profile.id);
    assert.ok(context.sources.find(source=>source.label==='PRD')?.excerpt.includes('Projeto de Teste'));
    assert.ok(context.sources.find(source=>source.label==='PREVC')?.excerpt.includes('Planning'));
  }finally{engine.state.close();}
  const before=await fixture.snapshot(),repeat=await fixture.bootstrap.apply(fixture.input);
  assert.equal(repeat.contractAction,'preserve');assert.equal(repeat.profileAction,'unchanged');
  assert.ok(repeat.notes.every(note=>note.action==='unchanged'));assert.deepEqual(await fixture.snapshot(),before);
});

test('reuseExisting binds real canonical documents and preserves existing profile checks, modes and unrelated fields',async t=>{
  const fixture=await BootstrapFixture.create(t,'Existing owner G-IDEIA contract.\nOther owner rules.\n');
  const plan=await fixture.bootstrap.plan(fixture.input),contents=new Map<string,string>();
  for(const note of plan.project!.notes){contents.set(note.path,'Canonical '+note.kind+' edited by the owner.\n');await fs.writeFile(note.path,contents.get(note.path)!);}
  await fs.mkdir(path.join(fixture.infra,'profiles'));
  const engine=new TaskEngine(fixture.infra);
  const checks=[{id:'never-run',executable:'never-execute-this',args:[],readOnly:true,relativeCwd:'.',timeoutMs:1000}];
  try{
    await engine.profiles.register({id:'fixture-g-ideia',name:'Existing Profile',aliases:['original-alias'],root:fixture.project,status:'paused',stack:['owned'],
      modes:['read-only','workspace-write'],sourceRoots:[],sources:[],checks});
  }finally{engine.state.close();}
  const blocked=await fixture.bootstrap.plan(fixture.input);
  assert.equal(blocked.ready,false);assert.ok(blocked.issues.some(issue=>issue.includes('reuseExisting')));
  const before=await fixture.snapshot();await assert.rejects(fixture.bootstrap.apply(fixture.input),/blocked/);assert.deepEqual(await fixture.snapshot(),before);
  const result=await fixture.bootstrap.apply({...fixture.input,project:{...fixture.input.project!,reuseExisting:true}});
  assert.equal(result.contractAction,'preserve');assert.equal(result.backupPath,null);assert.equal(result.profileAction,'merge');
  assert.ok(result.notes.every(note=>note.action==='reuse'));
  for(const [file,content] of contents)assert.equal(await fs.readFile(file,'utf8'),content);
  assert.equal(await fs.readFile(path.join(fixture.vault,'AGENTS.md'),'utf8'),'Existing owner G-IDEIA contract.\nOther owner rules.\n');
  const reader=new TaskEngine(fixture.infra);
  try{
    const profile=await reader.registry.resolve('original-alias');
    assert.equal(profile.status,'paused');assert.equal(profile.name,'Existing Profile');assert.deepEqual(profile.stack,['owned']);
    assert.deepEqual(profile.modes,['read-only','workspace-write']);assert.equal(profile.checks[0]?.executable,'never-execute-this');
    assert.equal(profile.sources.length,6);assert.equal(reader.state.list().length,0);
  }finally{reader.state.close();}
});

test('source label conflicts, stale contract hashes and incomplete managed blocks stop before changes',async t=>{
  const fixture=await BootstrapFixture.create(t);
  const plan=await fixture.bootstrap.plan(fixture.input);
  await fs.mkdir(path.join(fixture.infra,'profiles'));
  const other=path.join(fixture.project,'other.md');await fs.writeFile(other,'A different PRD.');
  const engine=new TaskEngine(fixture.infra);
  try{
    await engine.profiles.register({id:'fixture-g-ideia',name:'Fixture',root:fixture.project,status:'active',stack:[],modes:['read-only'],sourceRoots:[],
      sources:[{path:'other.md',label:'PRD',kind:'reference',maxChars:1000}],checks:[]});
  }finally{engine.state.close();}
  const before=await fixture.snapshot();
  const conflict=await fixture.bootstrap.plan(fixture.input);assert.equal(conflict.ready,false);assert.ok(conflict.issues.some(issue=>issue.includes('label already points')));
  await assert.rejects(fixture.bootstrap.apply(fixture.input),/label already points/);assert.deepEqual(await fixture.snapshot(),before);
  await assert.rejects(fixture.bootstrap.applyContract({vaultPath:fixture.vault,expectedContractSha256:'0'.repeat(64)}),/SHA differs/);
  assert.deepEqual(await fixture.snapshot(),before);
  await fs.appendFile(path.join(fixture.vault,'AGENTS.md'),'\n<!-- codex-infra:g-ideia:v1:start -->\nInterrupted append.');
  const invalidBefore=await fixture.snapshot(),invalid=await fixture.bootstrap.plan({vaultPath:fixture.vault});
  assert.equal(invalid.contract.contractState,'invalid-block');assert.equal(invalid.ready,false);
  await assert.rejects(fixture.bootstrap.applyContract({vaultPath:fixture.vault}),/incomplete/);assert.deepEqual(await fixture.snapshot(),invalidBefore);
  assert.equal(plan.project?.notes.length,5);
});

test('contract-only installation needs an existing compatible vault and preserves its local structure',async t=>{
  const fixture=await BootstrapFixture.create(t);
  const result=await fixture.bootstrap.applyContract({vaultPath:fixture.vault});
  assert.equal(result.profileId,null);assert.deepEqual(result.notes,[]);
  assert.deepEqual(await fs.readdir(fixture.infra),[]);
  assert.deepEqual(await fs.readdir(path.join(fixture.vault,'600 - Projetos')),[]);
  await assert.rejects(fixture.bootstrap.plan({vaultPath:fixture.project}),/ENOENT/);
  await assert.rejects(fixture.bootstrap.plan({...fixture.input,project:{...fixture.input.project!,filenames:{prd:'../outside.md'}}}));
});
