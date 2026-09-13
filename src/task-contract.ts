import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JobMode } from './state.js';
import {PerformanceScopeSchema} from './performance-scope.js';

const statements = z.array(z.string().trim().min(1).max(2000)).max(40);
const identifier = z.string().trim().min(1).max(128);
export const TaskStageSchema = z.enum(['execution','validation','publication']);
export const CapabilityRequirementSchema = z.object({
  id: identifier,
  kind: z.enum(['deterministic','model','integration','owner','out-of-scope']),
  purpose: z.string().trim().min(1).max(1000),
  stage: TaskStageSchema.default('execution'),
  required: z.boolean().default(true),
  checkId: identifier.optional(),
  dependsOn: z.array(identifier).max(40).default([]),
  evidenceRefs: statements.default([]),
});
export const OpenDecisionSchema = z.object({
  id: identifier, question: z.string().trim().min(1).max(2000),
  stage: TaskStageSchema.default('execution'),
  material: z.boolean().default(true),
  status: z.enum(['open','resolved','defaulted']).default('open'),
  resolution: z.string().trim().min(1).max(2000).optional(),
  source: z.string().trim().min(1).max(2000).optional(),
}).superRefine((decision,ctx)=>{
  if(decision.status!=='open'&&(!decision.resolution||!decision.source))ctx.addIssue({code:'custom',message:'A resolved decision or reversible default requires its resolution and source.'});
  if(decision.status==='defaulted'&&decision.material)ctx.addIssue({code:'custom',message:'A material decision cannot use an automatic default.'});
});
export const TaskDetailsSchema = z.object({
  networkAccess: z.boolean().default(true),
  gitHubAuth: z.boolean().optional(),
  comparisonBaseSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  performanceScope: PerformanceScopeSchema.optional(),
  acceptanceCriteria: statements.default([]),
  constraints: statements.default([]),
  nonGoals: statements.default([]),
  assumptions: statements.default([]),
  decisionRefs: statements.default([]),
  requiredSourceLabels: z.array(z.string().trim().min(1).max(240)).max(40).default([]),
  contextBudgetChars: z.number().int().min(4000).max(120000).default(24000),
  capabilities: z.array(CapabilityRequirementSchema).max(40).default([]),
  openDecisions: z.array(OpenDecisionSchema).max(40).default([]),
});
export type TaskDetailsInput = z.input<typeof TaskDetailsSchema>;
export interface TaskContract {
  version: 1; hash: string; projectId: string; objective: string; mode: JobMode;
  kind: 'checks' | 'codex'; checkIds: string[]; requirementIds: string[];
  details: z.output<typeof TaskDetailsSchema>;
  acceptance: { technical: 'named-checks'; human: 'not-recorded' };
}

/** A recorded task boundary, not a new permission grant or a second scheduler. */
export class TaskContractBuilder {
  build(input: {projectId:string; objective:string; mode:JobMode; kind:'checks'|'codex'; checkIds:string[]; requirementIds?:string[]; details?:TaskDetailsInput}): TaskContract {
    const objective = z.string().trim().min(1).max(20000).parse(input.objective);
    const details = TaskDetailsSchema.parse(input.details ?? {});
    const body = {
      version: 1 as const, projectId: input.projectId, objective, mode: input.mode,
      kind: input.kind, checkIds: input.checkIds, requirementIds: [...new Set(input.requirementIds ?? [])].sort(), details,
      acceptance: {technical:'named-checks' as const, human:'not-recorded' as const},
    };
    return {...body, hash:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
  }
}
