import {z} from 'zod';
import {EvidenceSanitizer} from './evidence.js';

const text=z.string().trim().min(1).max(2000);
const id=z.string().trim().min(1).max(128);
export const BlockerSchema=z.object({
  kind:z.enum(['recoverable','missing-information','external-dependency','owner-decision','platform','global']),
  reason:text, evidence:z.array(text).min(1).max(20),nextAction:text,
  recoveryActionId:id.nullable(),
}).strict();
export type TaskBlocker=z.infer<typeof BlockerSchema>;
export const ResolutionPolicySchema=z.object({
  maxAttempts:z.number().int().min(1).max(4),source:text,
  actions:z.array(z.object({id,instruction:text,triggers:z.array(z.enum(['worker-blocked','check-failed','outcome-failed'])).min(1).max(3)})).min(1).max(8),
}).refine(value=>new Set(value.actions.map(action=>action.id)).size===value.actions.length,'Recovery action IDs must be unique')
  .refine(value=>['check-failed','outcome-failed'].every(trigger=>value.actions.filter(a=>a.triggers.some(t=>t===trigger)).length<=1),'Each validation trigger must have one unambiguous recovery action');
export type ResolutionPolicy=z.infer<typeof ResolutionPolicySchema>;
export const IntentSchema=z.object({
  kind:z.enum(['request','continuation','correction','question','example','pause']),
  source:text,approvedPlanRefs:z.array(text).max(40),
  interpretation:text,
});
export class DelegationContract {
  static sanitizeBlocker(value:unknown):TaskBlocker|undefined {
    const parsed=BlockerSchema.safeParse(value);if(!parsed.success)return;
    const b=parsed.data;return {...b,reason:EvidenceSanitizer.text(b.reason,2000),nextAction:EvidenceSanitizer.text(b.nextAction,2000),evidence:b.evidence.map(e=>EvidenceSanitizer.text(e,2000))};
  }
  static isLocal(blocker:TaskBlocker):boolean{return !['platform','global'].includes(blocker.kind);}
}
