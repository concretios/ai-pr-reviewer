import { z } from 'zod';

const id = z.string().min(1).max(200);
const explanation = z.string().min(1).max(4000);
export const FindingSchema = z.strictObject({
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string().min(1).max(300), changedBehavior: explanation,
  trigger: explanation, consequence: explanation,
  introducedByAtomIds: z.array(id).min(1).max(100), evidenceIds: z.array(id).min(1).max(100),
  anchor: z.strictObject({ path: z.string().min(1).max(4096), side: z.enum(['LEFT', 'RIGHT']), line: z.number().int().positive() }).nullable(),
});
export const LookupSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('range'), path: z.string().min(1).max(4096), side: z.enum(['LEFT', 'RIGHT']), start: z.number().int().positive(), end: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('search'), literal: z.string().min(1).max(200), side: z.enum(['LEFT', 'RIGHT']) }),
]);
export const TaskResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('context_request'), taskId: id, requests: z.array(LookupSchema).min(1).max(4) }),
  z.strictObject({ kind: z.literal('result'), taskId: id,
    items: z.array(z.strictObject({ id, status: z.enum(['reviewed', 'unresolved']), reason: explanation })),
    findings: z.array(FindingSchema).max(100),
  }),
]);
export type Finding = z.infer<typeof FindingSchema>;
export type LookupRequest = z.infer<typeof LookupSchema>;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
// Gemini supports anyOf rather than a root discriminated oneOf.
export const wireSchema = z.toJSONSchema(TaskResponseSchema, { target: 'draft-7' });
delete wireSchema.$schema;
