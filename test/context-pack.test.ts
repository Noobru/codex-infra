import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ContextPackBuilder} from '../src/context-pack.js';
import {TaskContractBuilder} from '../src/task-contract.js';
import {ProfileSchema,ProjectRegistry,type ContextSource,type ProjectContext} from '../src/registry.js';

const source=(label:string,extra:Partial<ContextSource>={}):ContextSource=>({path:'/project/'+label,label,kind:'reference',sha256:label,modifiedAt:'2026-09-10T00:00:00Z',totalChars:4,excerpt:'data',truncated:false,...extra});
const context=(sources:ContextSource[]):ProjectContext=>({projectId:'test',root:'/project',profileHash:'profile',capturedAt:'2026-09-12T00:00:00Z',git:{head:null,status:'',error:null},sources});
const contract=(details={})=>new TaskContractBuilder().build({projectId:'test',objective:'Fix Redis cache invalidation',mode:'read-only',kind:'checks',checkIds:['test'],details});

test('pack preserves instructions, selects relevant current sources and explains exclusions',()=>{
 const input=context([source('AGENTS',{kind:'instruction',truncated:true}),source('Redis',{topics:['cache']}),source('Payments'),source('Redis historical',{knowledgeStatus:'historical'}),source('Redis expired',{validUntil:'2026-09-11T00:00:00Z'})]);
 const result=new ContextPackBuilder().build(input,contract());
 assert.deepEqual(result.sources.map(s=>s.label),['AGENTS','Redis']);
 assert.equal(result.sources[0]!.requiresFullRead,true);
 assert.deepEqual(new Set(result.excludedSources.map(s=>s.reason)),new Set(['no-lexical-match','knowledge-is-historical','source-expired']));
 assert.equal(result.hash,new ContextPackBuilder().build(input,contract()).hash);
});
test('explicit sources stay in pack without lexical match and missing sources fail clearly',()=>{
 assert.equal(new ContextPackBuilder().build(context([source('Payments')]),contract({requiredSourceLabels:['Payments']})).sources.length,1);
 assert.throws(()=>new ContextPackBuilder().build(context([]),contract({requiredSourceLabels:['Payments']})),/missing or ambiguous/);
});
test('project mismatch and mandatory budget exhaustion never silently drop instructions',()=>{
 const builder=new ContextPackBuilder();
 assert.throws(()=>builder.build({...context([]),projectId:'other'},contract()),/project differs/);
 assert.throws(()=>builder.build(context([source('AGENTS',{kind:'instruction',excerpt:'x'.repeat(4001)})]),contract({contextBudgetChars:4000})),/Mandatory context exceeds/);
 assert.throws(()=>builder.build(context([source('AGENTS',{kind:'instruction',knowledgeStatus:'candidate'})]),contract()),/inactive or expired/);
});
test('task contract normalizes detail defaults and changes when acceptance or boundaries change',()=>{
 assert.equal(contract().hash,contract({acceptanceCriteria:[]}).hash);
 assert.notEqual(contract().hash,contract({acceptanceCriteria:['No stale cache entries']}).hash);
 assert.notEqual(contract().hash,contract({nonGoals:['Do not migrate database']}).hash);
 assert.equal(contract().acceptance.human,'not-recorded');
});

test('task decision references retain active sources without lexical matching or authority promotion',()=>{
 const input=context([
   source('Current decision',{knowledgeClass:'decision',decisionRefs:['ADR-7'],truncated:true}),
   source('Old decision',{knowledgeClass:'historical',decisionRefs:['ADR-7'],precedence:900}),
   source('Candidate decision',{knowledgeClass:'candidate',knowledgeStatus:'active',decisionRefs:['ADR-8']}),
   source('Expired decision',{knowledgeClass:'decision',decisionRefs:['ADR-9'],validUntil:'2026-09-11T00:00:00Z'}),
 ]);
 const result=new ContextPackBuilder().build(input,contract({decisionRefs:['ADR-7','ADR-8','ADR-9','ADR-missing']}));
 assert.deepEqual(result.sources.map(item=>item.label),['Current decision']);
 assert.equal(result.sources[0]!.selectionReason,'active-decision-reference');
 assert.equal(result.sources[0]!.kind,'reference');
 assert.equal(result.sources[0]!.requiresFullRead,true);
 assert.deepEqual(result.governance?.decisionRefs,{requested:['ADR-7','ADR-8','ADR-9','ADR-missing'],resolved:['ADR-7'],unresolved:['ADR-8','ADR-9','ADR-missing']});
 assert.deepEqual(new Set(result.excludedSources.map(item=>item.reason)),new Set(['knowledge-class-historical','knowledge-class-candidate','source-expired']));
 assert.ok(result.governance?.diagnostics.some(item=>item.includes('ADR-missing')));
 assert.throws(()=>new ContextPackBuilder().build(context([source('Decision',{decisionRefs:['ADR-7'],excerpt:'x'.repeat(4001)})]),contract({decisionRefs:['ADR-7'],contextBudgetChars:4000})),/Mandatory context exceeds/);
});

test('precedence orders context explicitly while declared conflicts stay unresolved and readable',()=>{
 const input=context([
   source('Redis lower',{precedence:1,conflictsWith:['Redis higher','Unregistered']}),
   source('Redis higher',{precedence:10,knowledgeClass:'canonical'}),
   source('Unrelated',{precedence:100}),
 ]);
 const result=new ContextPackBuilder().build(input,contract());
 assert.deepEqual(result.sources.map(item=>item.label),['Redis higher','Redis lower']);
 assert.equal(result.sources[0]!.kind,'reference');
 assert.deepEqual(result.governance?.precedence.map(item=>[item.label,item.value,item.included]),[['Unrelated',100,false],['Redis higher',10,true],['Redis lower',1,true]]);
 assert.equal(result.governance?.conflicts[0]?.ordering,'target-first');
 assert.equal(result.governance?.conflicts[0]?.sourceIncluded,true);
 assert.equal(result.governance?.conflicts[0]?.targetIncluded,true);
 assert.equal(result.governance?.conflicts[0]?.resolution,'unresolved');
 assert.equal(result.governance?.conflicts[1]?.targetStatus,'missing');
 assert.equal(result.governance?.conflicts[1]?.ordering,'unknown');
 assert.ok(result.governance?.diagnostics.some(item=>item.includes('unresolved')));
 assert.equal(result.hash,new ContextPackBuilder().build(input,contract()).hash);
});

test('conflicts preserve exclusion and ambiguity without selecting historical knowledge',()=>{
 const result=new ContextPackBuilder().build(context([
   source('Redis active',{conflictsWith:['Redis old','Duplicated']}),
   source('Redis old',{knowledgeClass:'historical'}),
   source('Duplicated'),source('Duplicated',{path:'/project/second'}),
 ]),contract());
 assert.equal(result.governance?.conflicts[0]?.targetStatus,'found');
 assert.equal(result.governance?.conflicts[0]?.targetIncluded,false);
 assert.equal(result.governance?.conflicts[1]?.targetStatus,'ambiguous');
 assert.equal(result.governance?.conflicts[1]?.targetPath,null);
 assert.throws(()=>new ContextPackBuilder().build(context([source('AGENTS',{kind:'instruction',knowledgeClass:'candidate'})]),contract()),/inactive or expired/);
});

test('optional governance metadata preserves legacy profile shape and hash, and is captured from sources',async()=>{
 const legacy={id:'test',name:'Test',aliases:[],root:process.cwd(),status:'active',stack:[],modes:['read-only'],workspaces:['in-place'],sourceRoots:[],sources:[{path:'test/context-pack.test.ts',label:'Fixture',kind:'reference',maxChars:3}],checks:[]};
 const parsed=ProfileSchema.parse(legacy);
 assert.deepEqual(parsed,legacy);
 const registry=new ProjectRegistry('unused-fixture',{run:async(executable,args,cwd)=>({executable,args,cwd,exitCode:0,stdout:'',stderr:'',durationMs:0})});
 assert.equal(registry.hash(parsed),createHash('sha256').update(JSON.stringify(legacy)).digest('hex'));
 const metadata={knowledgeClass:'decision' as const,decisionRefs:['ADR-1'],precedence:0,conflictsWith:['Other source']};
 const updated=ProfileSchema.parse({...legacy,sources:[{...legacy.sources[0],...metadata}]});
 const captured=await registry.context(updated);
 assert.equal(captured.sources[0]?.knowledgeClass,'decision');
 assert.deepEqual(captured.sources[0]?.decisionRefs,['ADR-1']);
 assert.deepEqual(captured.sources[0]?.conflictsWith,['Other source']);
 assert.equal(captured.sources[0]?.precedence,0);
 assert.equal(captured.sources[0]?.truncated,true);
 assert.notEqual(registry.hash(updated),registry.hash(parsed));
});
