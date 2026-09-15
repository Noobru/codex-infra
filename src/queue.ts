import type { TaskEngine } from './engine.js';
import type { Job } from './state.js';
import { errorMessage } from './legacy/command-os-utils.js';

export interface DrainOptions {
  maxJobs:number;
  totalTimeoutMs:number;
  signal?:AbortSignal;
  concurrency?:number;
  /** Explicit workflow scope; never dispatch another project's queued work. */
  jobIds?:string[];
  continueIndependent?:boolean;
}
export interface DrainResult {jobs:Job[];stopReason:string}

/** Shared bounded scheduler. Admission and resource ownership remain transactional in StateStore. */
export class QueueCoordinator {
  constructor(private readonly engine:Pick<TaskEngine,'state'|'run'|'cancel'> & Partial<Pick<TaskEngine,'execution'|'canContinueAfter'>>) {}
  async drain(options:DrainOptions):Promise<DrainResult> {
    const {maxJobs,totalTimeoutMs,signal}=options;
    if(!Number.isSafeInteger(maxJobs)||maxJobs<1)throw new Error('maxJobs must be a positive integer');
    if(!Number.isSafeInteger(totalTimeoutMs)||totalTimeoutMs<1||totalTimeoutMs>2_147_483_647)throw new Error('totalTimeoutMs must be a positive timer duration');
    const policy=this.engine.execution ? await this.engine.execution.read() : {maxWorkers:options.concurrency??1,maxModelWorkers:options.concurrency??1};
    const concurrency=options.concurrency??policy.maxWorkers;
    if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>policy.maxWorkers||concurrency>4)throw new Error('Concurrency exceeds the shared execution policy');
    if(options.jobIds && (options.jobIds.length===0||new Set(options.jobIds).size!==options.jobIds.length))throw new Error('Select distinct scoped job IDs');
    for(const id of options.jobIds??[])this.engine.state.get(id);
    if(options.continueIndependent&&!options.jobIds?.length)throw new Error('Independent continuation requires explicit scoped job IDs');
    const deadline=performance.now()+totalTimeoutMs;
    const jobs:Job[]=[];
    type Outcome={id:string;job?:Job;error?:unknown};
    type Entry={promise:Promise<Outcome>;cancel?:Promise<void>;controller:AbortController;owner?:{pid:number;attempt:number}};
    const active=new Map<string,Entry>();
    let launched=0,stopReason:string|undefined,cancelError:unknown;
    let localBlockers=false;
    const cancelOwned=(id:string,entry:Entry)=>{
      if(!entry.owner){entry.controller.abort();return;}
      if(!entry.cancel)entry.cancel=this.engine.cancel(id,entry.owner).then(()=>{entry.controller.abort();},error=>{cancelError=error;entry.controller.abort();});
    };
    const stop=(reason:string)=>{
      stopReason??=reason;
      for(const [id,entry] of active)cancelOwned(id,entry);
    };
    const onAbort=()=>stop('aborted');
    signal?.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>stop('deadline'),totalTimeoutMs);
    try {
      while(true) {
        if(signal?.aborted)stop('aborted');
        const remaining=Math.floor(deadline-performance.now());
        if(remaining<1000)stop('deadline');
        while(!stopReason && active.size<concurrency && launched<maxJobs) {
          const job=this.engine.state.nextReady({jobIds:options.jobIds,excludeIds:[...active.keys()],maxModelWorkers:policy.maxModelWorkers});
          if(!job)break;
          const entry:Entry={promise:Promise.resolve({id:job.id}),controller:new AbortController(),
            ...(!this.engine.execution?{owner:{pid:process.pid,attempt:job.attempts+1}}:{})};
          active.set(job.id,entry);launched++;
          entry.promise=this.engine.run(job.id,Math.min(remaining,1_800_000),{signal:entry.controller.signal,onClaimed:claimed=>{
            entry.owner={pid:claimed.ownerPid!,attempt:claimed.attempts};if(stopReason)cancelOwned(job.id,entry);
          }}).then(job=>({id:job.id,job}),error=>({id:job.id,error}));
        }
        if(active.size===0)return {jobs,stopReason:cancelError?'dispatch_error: '+errorMessage(cancelError):stopReason??(localBlockers?'local_blockers':launched>=maxJobs?'max_jobs':'no_ready_jobs')};
        const outcome=await Promise.race([...active.values()].map(entry=>entry.promise));
        await active.get(outcome.id)?.cancel;
        active.delete(outcome.id);
        if(outcome.job)jobs.push(outcome.job);
        else if(stopReason)jobs.push(this.engine.state.get(outcome.id));
        if(outcome.error)stop('dispatch_error: '+errorMessage(outcome.error));
        else if(outcome.job?.status!=='completed') {
          if(options.continueIndependent&&outcome.job&&await this.engine.canContinueAfter?.(outcome.job))localBlockers=true;
          else stop(outcome.job?.status??'dispatch_error: engine returned no result');
        }
      }
    } finally {
      clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
      await Promise.all([...active.values()].map(entry=>entry.cancel));
    }
  }
}
