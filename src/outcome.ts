import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {resolveRealSubPath} from './legacy/command-os-utils.js';

const fields={id:z.string().trim().min(1).max(128),description:z.string().trim().min(1).max(2000)};
const relativePath=z.string().min(1).max(1000).refine(value=>!path.isAbsolute(value)&&!path.win32.isAbsolute(value)&&!value.split(/[\\/]/).includes('..'),'Artifact path must be relative to the task workspace');
export const OutcomeCriterionSchema=z.discriminatedUnion('kind',[
  z.object({...fields,kind:z.literal('check'),checkId:z.string().min(1).max(128)}),
  z.object({...fields,kind:z.literal('artifact'),path:relativePath,contains:z.string().min(1).max(16000).optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional()})
    .refine(value=>Boolean(value.contains||value.sha256),'Artifact needs a content expectation or SHA-256'),
]);
export type OutcomeCriterion=z.infer<typeof OutcomeCriterionSchema>;
export interface OutcomeResult {version:1;taskContractHash:string;observedAt:string;status:'passed'|'failed'|'not-recorded';criteria:{id:string;status:'passed'|'failed';reason:string;evidence?:{path?:string;sha256?:string;checkId?:string}}[]}

/** Observes the contracted result; worker declarations cannot substitute these checks. */
export class OutcomeVerifier {
  async verify(input:{root:string;criteria:OutcomeCriterion[];checks:{checkId:string;exitCode:number|null;cleanupFailed?:boolean}[];taskContractHash:string}):Promise<OutcomeResult> {
    const criteria=z.array(OutcomeCriterionSchema).max(40).parse(input.criteria);
    if(new Set(criteria.map(c=>c.id)).size!==criteria.length)throw new Error('Outcome criterion IDs must be unique');
    const results:OutcomeResult['criteria']=[];
    for(const criterion of criteria) {
      if(criterion.kind==='check') {
        const matches=input.checks.filter(check=>check.checkId===criterion.checkId);
        const passed=matches.length===1&&matches[0]!.exitCode===0&&!matches[0]!.cleanupFailed;
        results.push({id:criterion.id,status:passed?'passed':'failed',reason:passed?'Named check passed':'Named check missing, duplicated or failed',evidence:{checkId:criterion.checkId}});
        continue;
      }
      try {
        const file=await resolveRealSubPath(path.join(input.root,criterion.path),input.root);
        if(!file)throw new Error('Artifact missing or outside workspace');
        const stat=await fs.stat(file);
        if(!stat.isFile()||stat.size>1024*1024)throw new Error('Artifact is not a bounded regular file');
        const handle=await fs.open(file,'r');
        let bytes:Buffer;
        try {const buffer=Buffer.alloc(1024*1024+1);const read=await handle.read(buffer,0,buffer.length,0);if(read.bytesRead>1024*1024)throw new Error('Artifact exceeds read budget');bytes=buffer.subarray(0,read.bytesRead);}finally{await handle.close();}
        const sha256=createHash('sha256').update(bytes).digest('hex');
        const passed=(!criterion.sha256||sha256===criterion.sha256)&&(!criterion.contains||bytes.toString('utf8').includes(criterion.contains));
        results.push({id:criterion.id,status:passed?'passed':'failed',reason:passed?'Artifact matched its contracted expectation':'Artifact content did not match',evidence:{path:criterion.path,sha256}});
      }catch {results.push({id:criterion.id,status:'failed',reason:'Artifact unavailable, outside workspace or over read budget'});}
    }
    return {version:1,taskContractHash:input.taskContractHash,observedAt:new Date().toISOString(),status:!results.length?'not-recorded':results.every(c=>c.status==='passed')?'passed':'failed',criteria:results};
  }
}
