import {z} from 'zod';
import {InteractionIdSchema} from './interactions.js';

export const WorkUnitIdSchema=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const WorkUnitRefSchema=z.object({interactionId:InteractionIdSchema,unitId:WorkUnitIdSchema,contractHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type WorkUnitRef=z.infer<typeof WorkUnitRefSchema>;
