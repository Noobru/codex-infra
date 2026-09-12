import {z} from 'zod';

/** Author-declared grouping for comparable work; never inferred from a thread title. */
export const PerformanceScopeSchema=z.object({
  taskClass:z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  language:z.string().trim().min(1).max(100).optional(),
  problemCategory:z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional(),
}).strict();
