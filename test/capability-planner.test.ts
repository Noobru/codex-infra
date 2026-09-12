import test from 'node:test';
import assert from 'node:assert/strict';
import {ProfileSchema} from '../src/registry.js';
import {TaskContractBuilder,type TaskDetailsInput} from '../src/task-contract.js';
import {CapabilityPlanner} from '../src/capability-planner.js';

const profile=ProfileSchema.parse({id:'fixture',name:'Fixture',root:'.',status:'active',stack:['node'],modes:['read-only'],sourceRoots:[],sources:[],checks:[{id:'unit',executable:'node',args:['--test'],readOnly:true}]});
const contract=(details:TaskDetailsInput={})=>new TaskContractBuilder().build({projectId:'fixture',objective:'Verify the tiny fixture',mode:'read-only',kind:'checks',checkIds:['unit'],details});
test('planner maps checks, capability dependencies and records a reversible default',()=>{
 const plan=new CapabilityPlanner().plan(profile,contract({capabilities:[{id:'local-check',kind:'deterministic',purpose:'Use the existing unit check',checkId:'unit',dependsOn:['check:unit']}],openDecisions:[{id:'format',question:'Output format',status:'defaulted',material:false,resolution:'JSON',source:'Reversible local default'}]}));
 assert.ok(plan.gates.every(gate=>gate.ready));assert.equal(plan.capabilities[0]!.availability,'available');assert.equal(plan.decisions[0]!.resolution,'JSON');
 assert.equal(plan.hash,new CapabilityPlanner().plan(profile,contract({capabilities:[{id:'local-check',kind:'deterministic',purpose:'Use the existing unit check',checkId:'unit',dependsOn:['check:unit']}],openDecisions:[{id:'format',question:'Output format',status:'defaulted',material:false,resolution:'JSON',source:'Reversible local default'}]})).hash);
});
test('missing capability or material decision blocks only its dependent stage',()=>{
 const planner=new CapabilityPlanner();
 const plan=planner.plan(profile,contract({capabilities:[{id:'external',kind:'integration',purpose:'External evidence later',stage:'publication',evidenceRefs:['declared availability is not proof']}],openDecisions:[{id:'owner-choice',question:'Required validation decision',stage:'validation'}]}));
 assert.doesNotThrow(()=>planner.assertReady(plan,'execution'));
 assert.throws(()=>planner.assertReady(plan,'validation'),/decision:owner-choice/);
 assert.throws(()=>planner.assertReady(plan,'publication'),/external:unknown/);
 const optional=planner.plan(profile,contract({capabilities:[{id:'optional',kind:'integration',purpose:'Optional observation',required:false}]}));
 assert.doesNotThrow(()=>planner.assertReady(optional,'execution'));
});
test('out-of-scope requirements and invalid plans never silently become available',()=>{
 const planner=new CapabilityPlanner();
 assert.throws(()=>planner.assertReady(planner.plan(profile,contract({capabilities:[{id:'publish',kind:'out-of-scope',purpose:'Publishing is not authorized'}]})),'execution'),/publish:missing/);
 assert.throws(()=>contract({openDecisions:[{id:'material',question:'Material choice',status:'defaulted',resolution:'Assumed',source:'model'}]}),/material decision/);
 assert.throws(()=>planner.plan(profile,contract({capabilities:[{id:'cyclic',kind:'deterministic',purpose:'Invalid dependency',checkId:'unit',dependsOn:['cyclic']}]})),/cycle/);
});
