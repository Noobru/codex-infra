import fs from 'node:fs/promises';
import path from 'node:path';
import {EvidenceSanitizer} from './evidence.js';
import {atomicWriteJson,resolveRealSubPath,readJson} from './legacy/command-os-utils.js';
import {createHash} from 'node:crypto';
import type {StateStore} from './state.js';

/** Bounded attempt evidence shared by dispatch policy and explicit corrective retries. */
export class ExecutionEvidence {
  static async cancellationRequested(jobDirectory:string,attempt:number):Promise<boolean> {
    const marker=await readJson(path.join(jobDirectory,'cancel.json'),null) as {attempt?:number}|null;
    return marker!==null&&(marker.attempt===undefined||marker.attempt===attempt);
  }
  private readonly effects:{action:string;decision:'allow'|'deny';reason:string;capturedAt:string;result?:string}[]=[];
  constructor(private readonly attemptRoot:string){}
  async dependencies(state:StateStore,jobId:string) {
    const handoffs=[];
    for(const id of state.dependencies(jobId)) {
      const job=state.get(id);
      if(job.status!=='completed')throw new Error('Dependency handoff is not completed: '+id);
      const directory=path.resolve(this.attemptRoot,'../..',id,'attempt-'+job.attempts);
      const checksPath=await resolveRealSubPath(path.join(directory,'checks.json'),path.resolve(this.attemptRoot,'../..'));
      if(!checksPath || (await fs.stat(checksPath)).size>8*1024*1024)throw new Error('Dependency checks evidence missing or oversized: '+id);
      const text=await fs.readFile(checksPath,'utf8'), checks=JSON.parse(text);
      if(!Array.isArray(checks)||checks.some(c=>c.exitCode!==0||c.cleanupFailed))throw new Error('Dependency lacks passing acceptance evidence: '+id);
      let outcome=null;
      if(checks.length===0) {
        const outcomePath=await resolveRealSubPath(path.join(directory,'outcome.json'),path.resolve(this.attemptRoot,'../..'));
        if(!outcomePath||(await fs.stat(outcomePath)).size>1024*1024)throw new Error('Dependency outcome evidence missing: '+id);
        outcome=JSON.parse(await fs.readFile(outcomePath,'utf8'));
        const manifest=JSON.parse(await fs.readFile(path.join(directory,'..','manifest.json'),'utf8'));
        if(outcome.status!=='passed'||outcome.taskContractHash!==manifest.taskContract?.hash)throw new Error('Dependency outcome is unverified: '+id);
      }
      handoffs.push({jobId:id,projectId:job.projectId,attempt:job.attempts,objective:EvidenceSanitizer.text(job.objective,2000),
        summary:EvidenceSanitizer.text(job.result??'',4000),checks:checks.map(c=>({checkId:c.checkId,exitCode:c.exitCode})),
        checksSha256:createHash('sha256').update(text).digest('hex'),evidencePath:checksPath,...(outcome?{outcome}: {})});
    }
    return {version:1,jobId,handoffs,scope:'Dependency results are evidence for the current objective; they do not expand its authority.'};
  }
  async effect(action:string,decision:'allow'|'deny',reason:string,result?:string){
    this.effects.push({action,decision,reason:EvidenceSanitizer.text(reason,1000),capturedAt:new Date().toISOString(),...(result?{result:EvidenceSanitizer.text(result,400)}:{})});
    await atomicWriteJson(path.join(this.attemptRoot,'policy.json'),{version:1,policyVersion:'controlled-effects-v1',scope:'owned infrastructure effects only',effects:this.effects,limitations:['This receipt does not authorize external publication or cover arbitrary host operations.']});
  }
  async previousAttempt(attempt:number){
    if(attempt<=1)return null;
    const previousRoot=path.join(this.attemptRoot,'..','attempt-'+(attempt-1));
    const file=await resolveRealSubPath(path.join(previousRoot,'checks.json'),path.dirname(this.attemptRoot));
    if(!file)return {attempt:attempt-1,checks:[],evidenceRefs:['attempt-'+(attempt-1)+'/failure.json'],limitation:'No prior check receipt is available; inspect the previous failure before repeating effects.'};
    if((await fs.stat(file)).size>8*1024*1024)throw new Error('Previous check receipt exceeds retry context budget');
    const raw=JSON.parse(await fs.readFile(file,'utf8')) as unknown;
    if(!Array.isArray(raw))throw new Error('Previous check receipt is invalid');
    return {attempt:attempt-1,checks:raw.slice(0,100).map(item=>({checkId:EvidenceSanitizer.text(String(item.checkId??''),120),exitCode:typeof item.exitCode==='number'?item.exitCode:null,stdout:EvidenceSanitizer.text(String(item.stdout??''),4000),stderr:EvidenceSanitizer.text(String(item.stderr??''),4000),cleanupFailed:item.cleanupFailed===true})),evidenceRefs:['attempt-'+(attempt-1)+'/checks.json'],limitation:'Prior failure is evidence for an explicit corrective attempt, not permission to repeat unknown external effects.'};
  }
}
