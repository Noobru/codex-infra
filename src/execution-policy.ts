import path from 'node:path';
import { z } from 'zod';
import { atomicWriteJson, readJson } from './legacy/command-os-utils.js';
import type { ProfileManager } from './profile-manager.js';
import type { StateStore } from './state.js';

export const ExecutionPolicySchema = z.object({version:z.literal(1).default(1),maxWorkers:z.number().int().min(1).max(4).default(1),maxModelWorkers:z.number().int().min(1).max(4).default(1)})
  .refine(value=>value.maxModelWorkers<=value.maxWorkers,'Model slots cannot exceed total worker slots');
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

/** Shared admission budget, including jobs dispatched by other CLI/MCP/supervisor processes. */
export class ExecutionPolicyManager {
  constructor(private readonly root:string,private readonly profiles:ProfileManager,private readonly state:StateStore) {}
  static async read(root:string):Promise<ExecutionPolicy> {return ExecutionPolicySchema.parse(await readJson(path.join(root,'profiles/execution-policy.json'),{}));}
  async read():Promise<ExecutionPolicy> {return ExecutionPolicyManager.read(this.root);}
  async configure(input:unknown):Promise<ExecutionPolicy> {
    const policy=ExecutionPolicySchema.parse(input);
    return this.profiles.withLock(async()=>{
      if(this.state.list().some(job=>['running','validating'].includes(job.status))) throw new Error('Configure execution limits while workers are idle');
      await atomicWriteJson(path.join(this.root,'profiles/execution-policy.json'),policy);
      return policy;
    });
  }
}
