import path from 'node:path';
import {createHash} from 'node:crypto';
import type {TaskEngine} from './engine.js';
import type {Job} from './state.js';
import {readJson,atomicWriteJson} from './legacy/command-os-utils.js';
import {DelegationContract,type TaskBlocker,type ResolutionPolicy} from './delegation-contract.js';
import {ExecutionEvidence} from './execution-evidence.js';

export interface BlockerReceipt {version:1;attempt:number;taskContractHash:string;trigger:'worker-blocked'|'check-failed'|'outcome-failed';blocker:TaskBlocker}
export interface DispatchOptions {signal?:AbortSignal;onClaimed?:(job:Job)=>void}

/** Bounded outer loop; all execution and admission remain in TaskEngine/StateStore. */
export class ObjectiveCoordinator {
  constructor(private readonly engine:Pick<TaskEngine,'state'|'artifactDir'|'profiles'|'retry'>){}
  async blocker(job:Job):Promise<BlockerReceipt|null> {
    if(job.attempts<1)return null;
    const raw=await readJson(path.join(this.engine.artifactDir(job.id),`attempt-${job.attempts}`,'blocker.json'),null);
    const blocker=DelegationContract.sanitizeBlocker(raw?.blocker);
    return raw?.version===1&&raw.attempt===job.attempts&&blocker?{...raw,blocker}:null;
  }
  async canContinueAfter(job:Job):Promise<boolean> {
    if(!['failed','waiting_user'].includes(job.status)||job.ownerPid!==null)return false;
    const receipt=await this.blocker(job);
    return Boolean(receipt&&DelegationContract.isLocal(receipt.blocker));
  }
  async run(id:string,timeoutMs:number,dispatch:DispatchOptions,attempt:(remaining:number)=>Promise<Job>):Promise<Job> {
    const directory=this.engine.artifactDir(id);
    const manifest=await readJson(path.join(directory,'manifest.json'),null);
    const policy=manifest?.taskContract?.details?.resolution as ResolutionPolicy|undefined;
    const deadline=performance.now()+timeoutMs;
    let job=this.engine.state.get(id),first=true;
    if(!policy)return attempt(timeoutMs);
    while(true) {
      if(dispatch.signal?.aborted)return this.engine.state.get(id);
      if(job.status==='ready') {
        const remaining=Math.floor(deadline-performance.now());
        if(remaining<1000)return job;
        job=await attempt(remaining);first=false;
      }else if(first&&!['failed','waiting_user'].includes(job.status))return attempt(timeoutMs);
      const receipt=await this.blocker(job);
      const action=receipt&&policy.actions.find(a=>a.id===receipt.blocker.recoveryActionId&&a.triggers.includes(receipt.trigger));
      let reason:string|undefined;
      if(!receipt||receipt.taskContractHash!==manifest.taskContract.hash||receipt.blocker.kind!=='recoverable'||!action)reason='No authorized recovery action for this result';
      else if(receipt.blocker.cause==='approval')reason='Approval blockers cannot be retried by another executor or recovery action';
      else if(action.causes&&!action.causes.includes(receipt.blocker.cause??'unknown'))reason='Recovery action does not cover the observed blocker cause';
      else if(job.ownerPid!==null||!['failed','waiting_user'].includes(job.status))reason='Job is not safely stopped';
      else if(job.attempts>=policy.maxAttempts)reason='Recovery attempt budget exhausted';
      else if(deadline-performance.now()<1000)reason='Recovery deadline exhausted';
      else if(dispatch.signal?.aborted||await ExecutionEvidence.cancellationRequested(directory,job.attempts))reason='Cancellation requested';
      const fingerprint=receipt?createHash('sha256').update(JSON.stringify(receipt.blocker).replace(/attempt-\d+/g,'attempt-N')).digest('hex'):null;
      if(!reason&&job.attempts>1) {
        const prior=await readJson(path.join(directory,`attempt-${job.attempts-1}`,'recovery.json'),null);
        if(prior?.fingerprint===fingerprint)reason='Repeated blocker without new evidence';
      }
      await atomicWriteJson(path.join(directory,'resolution.json'),{version:1,jobId:id,attempt:job.attempts,taskContractHash:manifest.taskContract.hash,
        status:job.status==='completed'?'completed':reason?'stopped':'recovering',reason:job.status==='completed'?null:reason??null,blocker:receipt?.blocker??null,
        nextAction:job.status==='completed'?'Inspect verified outcome':receipt?.blocker.nextAction??'Inspect attempt evidence',observedAt:new Date().toISOString(),maxAttempts:policy.maxAttempts});
      if(reason||!receipt||!action)return job;
      const previous=job;
      const resumed=await this.engine.profiles.withLock(async()=>{
        const current=this.engine.state.get(id);
        if(current.attempts!==previous.attempts||current.status!==previous.status||dispatch.signal?.aborted)return false;
        if(await ExecutionEvidence.cancellationRequested(directory,current.attempts))return false;
        await atomicWriteJson(path.join(directory,`attempt-${current.attempts}`,'recovery.json'),{
          version:1,fromAttempt:current.attempts,toAttempt:current.attempts+1,taskContractHash:manifest.taskContract.hash,
          fingerprint,actionId:action.id,instruction:action.instruction,authorizationSource:policy.source,
          evidence:receipt.blocker.evidence,proposedNextAction:receipt.blocker.nextAction,recordedAt:new Date().toISOString(),
        });
        this.engine.retry(id);return true;
      });
      if(!resumed)return this.engine.state.get(id);
      job=this.engine.state.get(id);
    }
  }
}
