import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppServerClient } from './app-server.js';
import { StateStore } from './state.js';
import { KnowledgeDecisionSchema, KnowledgeFiles } from './knowledge-store.js';
import { EvidenceSanitizer } from './evidence.js';

export const DelegationFinishSchema = KnowledgeDecisionSchema.extend({
  expectedAttempt:z.number().int().positive(),threadId:z.uuid(),integrated:z.literal(true),
}).strict();
const receiptSchema=DelegationFinishSchema.extend({version:z.literal(1),jobId:z.uuid(),recordedAt:z.iso.datetime(),
  status:z.enum(['archived','pending']),artifactPath:z.string(),error:z.string().nullable()});
export interface WorkerArchiveAdapter {archive(threadId:string):Promise<void>}

/** Official app-server protocol. No access to the Desktop's private database. */
export class AppServerWorkerArchive implements WorkerArchiveAdapter {
  constructor(readonly root:string,private readonly clientFactory:()=>Pick<AppServerClient,'connect'|'request'|'close'>=()=>new AppServerClient({cwd:root})){}
  async archive(threadId:string){
    const client=this.clientFactory();
    try {
      await client.connect();
      const read=await client.request<{thread:{id:string;status?:{type:string}}}>('thread/read',{threadId,includeTurns:false});
      if(read.thread?.id!==threadId||!['idle','notLoaded'].includes(read.thread.status?.type??''))throw new Error('Worker thread is active or its status is unavailable.');
      try {
        const response=await client.request<unknown>('thread/archive',{threadId});
        if(response===null||typeof response!=='object'||Array.isArray(response))throw new Error('Archive response is invalid.');
      } catch(error) {
        // Desktop may already have archived this worker before a receipt was saved.
        let cursor:string|null=null;
        for(let page=0;page<5;page++){
          const archived:{data:{id:string}[];nextCursor:string|null}=await client.request('thread/list',{archived:true,cursor,limit:100,
            sourceKinds:['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown'],useStateDbOnly:true});
          if(archived.data.some(thread=>thread.id===threadId))return;
          cursor=archived.nextCursor;if(!cursor)break;
        }
        throw error;
      }
    }finally{await client.close();}
  }
}

/** Called by the coordinator after integrating the stopped worker's result/evidence. */
export class DelegationLifecycle {
  private readonly files:KnowledgeFiles;
  constructor(readonly root:string,private readonly adapter:WorkerArchiveAdapter=new AppServerWorkerArchive(root)){this.files=new KnowledgeFiles(root);}
  async finish(jobId:string,raw:unknown){
    z.uuid().parse(jobId);const input=DelegationFinishSchema.parse(raw);
    const state=new StateStore(path.join(this.root,'state/jobs.sqlite'),{readOnly:true});
    try {
      const job=state.get(jobId);
      if(job.attempts!==input.expectedAttempt||job.threadId!==input.threadId||job.ownerPid!==null||!['completed','failed','cancelled'].includes(job.status))
        throw new Error('Finish requires the exact stopped worker attempt and its integrated result.');
      await this.files.read(`artifacts/jobs/${jobId}/manifest.json`,z.object({kind:z.literal('codex')}));
      const directory=`artifacts/jobs/${jobId}/delegation`,artifactPath=`${directory}/attempt-${job.attempts}-archived.json`;
      if((await this.files.names(directory)).includes(path.basename(artifactPath))){
        const prior=await this.files.read(artifactPath,receiptSchema);
        if(prior.threadId!==input.threadId)throw new Error('Archive receipt belongs to another thread.');
        return prior;
      }
      let error:string|null=null;
      try{await this.adapter.archive(input.threadId);}catch(cause){error='Codex did not confirm archiving: '+EvidenceSanitizer.text(cause instanceof Error?cause.message:String(cause),1000);}
      const receipt=receiptSchema.parse({...input,version:1,jobId,recordedAt:new Date().toISOString(),status:error?'pending':'archived',error,
        artifactPath:error?`${directory}/attempt-${job.attempts}-pending-${randomUUID()}.json`:artifactPath});
      await this.files.writeJsonNew(receipt.artifactPath,receipt);return receipt;
    }finally{state.close();}
  }
}
