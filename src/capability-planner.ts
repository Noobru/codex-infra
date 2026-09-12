import {createHash} from 'node:crypto';
import type {Profile} from './registry.js';
import type {TaskContract} from './task-contract.js';
import type {ContextPack} from './context-pack.js';

type Stage='execution'|'validation'|'publication';
export interface CapabilityPlanItem {
  id:string; kind:'deterministic'|'model'|'integration'|'owner'|'out-of-scope';
  purpose:string; stage:Stage; required:boolean; availability:'available'|'missing'|'unknown';
  basis:string; checkId?:string; dependsOn:string[]; evidenceRefs:string[];
}
export interface CapabilityPlan {
  version:1; hash:string; taskContractHash:string; projectId:string;
  capabilities:CapabilityPlanItem[];
  gates:{stage:Stage; ready:boolean; reasons:string[]}[];
  decisions:TaskContract['details']['openDecisions'];
  contextDiagnostics:{unresolvedDecisionRefs:string[];unresolvedConflictCount:number};
  limitations:string[];
}

/** Plans only capabilities the existing execution core actually controls; never installs or dispatches. */
export class CapabilityPlanner {
  plan(profile:Profile,contract:TaskContract,contextPack?:ContextPack):CapabilityPlan {
    if(profile.id!==contract.projectId)throw new Error('Capability plan project differs from task contract');
    const checkAvailability=(id:string)=>{
      const check=profile.checks.find(item=>item.id===id);
      return !!check&&(contract.mode==='workspace-write'||check.readOnly);
    };
    const capabilities:CapabilityPlanItem[]=contract.checkIds.map(id=>({id:'check:'+id,kind:'deterministic',purpose:'Named acceptance check '+id,stage:'validation',required:true,availability:checkAvailability(id)?'available':'missing',basis:'registered-check-contract; execution result is still unverified',checkId:id,dependsOn:[],evidenceRefs:['profile:'+profile.id+'/checks/'+id]}));
    if(contract.kind==='codex')capabilities.push({id:'codex-worker',kind:'model',purpose:'One bounded model turn under the routing contract',stage:'execution',required:true,availability:'available',basis:'worker adapter configured; auth, quota, catalog and effective sandbox must pass runtime preflight',dependsOn:[],evidenceRefs:['runtime:codex-app-server']});
    for(const requirement of contract.details.capabilities??[]) {
      const ownerDecision=contract.details.openDecisions?.find(decision=>decision.id===requirement.id&&decision.status==='resolved');
      const availability=requirement.kind==='deterministic'?(requirement.checkId&&checkAvailability(requirement.checkId)?'available':'missing')
        :requirement.kind==='model'?(contract.kind==='codex'?'available':'missing')
        :requirement.kind==='owner'?(ownerDecision?'available':'unknown')
        :requirement.kind==='out-of-scope'?'missing':'unknown';
      capabilities.push({...requirement,availability,basis:requirement.kind==='integration'?'External integration not verified; evidence references alone do not prove availability':requirement.kind==='owner'?'Recorded decision; this does not grant new external authority':requirement.kind==='out-of-scope'?'Outside this task boundary':'Existing execution contract; runtime verification is still required'});
    }
    const byId=new Map(capabilities.map(item=>[item.id,item]));
    if(byId.size!==capabilities.length)throw new Error('Capability IDs must be distinct');
    const visiting=new Set<string>(),visited=new Set<string>();
    const visit=(item:CapabilityPlanItem):void=>{
      if(visiting.has(item.id))throw new Error('Capability dependency cycle');
      if(visited.has(item.id))return;
      visiting.add(item.id);
      for(const id of item.dependsOn){const dependency=byId.get(id);if(!dependency)throw new Error('Unknown capability dependency: '+id);visit(dependency);if(dependency.availability!=='available'){item.availability='unknown';item.basis='Dependency is not ready: '+id;}}
      visiting.delete(item.id);visited.add(item.id);
    };
    capabilities.forEach(visit);
    const decisions=contract.details.openDecisions??[];
    const gates=(['execution','validation','publication'] as const).map(stage=>{
      const reasons=capabilities.filter(item=>item.stage===stage&&item.required&&item.availability!=='available').map(item=>item.id+':'+item.availability);
      reasons.push(...decisions.filter(item=>item.stage===stage&&item.material&&item.status==='open').map(item=>'decision:'+item.id));
      if(stage==='execution'&&!profile.modes.includes(contract.mode))reasons.push('profile-mode-not-allowed');
      if(stage==='execution'&&profile.status==='paused'&&contract.mode!=='read-only')reasons.push('project-paused');
      return {stage,ready:reasons.length===0,reasons};
    });
    const contextDiagnostics={unresolvedDecisionRefs:contextPack?.governance?.decisionRefs.unresolved??[],unresolvedConflictCount:contextPack?.governance?.conflicts.length??0};
    const body={version:1 as const,taskContractHash:contract.hash,projectId:profile.id,capabilities,gates,decisions,contextDiagnostics,
      limitations:['Available means the capability is configured for this task, not that its execution succeeded.','Runtime admission, checks and cleanup remain mandatory.','Publication is never dispatched or authorized by this plan.','Unavailable optional capabilities and later-stage decisions do not block independent reading.']};
    return {...body,hash:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
  }

  assertReady(plan:CapabilityPlan,stage:Stage):void {
    const gate=plan.gates.find(item=>item.stage===stage)!;
    if(!gate.ready)throw new Error('Capability gate '+stage+' is blocked: '+gate.reasons.join(', '));
  }
}
