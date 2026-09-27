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
export const CandidateSchema = z.strictObject({
  classification: z.enum(['introduced_failure', 'existing_issue', 'improvement', 'preference', 'insufficient_evidence'])
    .describe('Classify the causal claim. Only introduced_failure is publishable. Cosmetic changes, preferences and descriptions of fixes are not introduced failures.'),
  ...FindingSchema.shape,
  changedBehavior: explanation.describe('Specific BEFORE versus AFTER behavior. Describe what the PR changes, not an imagined implementation.'),
  trigger: explanation.describe('Concrete supported input or situation that makes the NEW code fail. Merely rendering a changed component is not a failing trigger.'),
  consequence: explanation.describe('Incorrect behavior caused by the NEW code under the trigger, and why it violates a supported requirement. A smaller font, more badges, or an overlay preventing races is not itself a failure. Do not describe what would fail WITHOUT the fix.'),
});
export const CompactResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ protocolVersion: z.literal('compact-v2'), requestId: id,
    kind: z.literal('context_request'), requests: z.array(LookupSchema).min(1).max(4) }),
  z.strictObject({ protocolVersion: z.literal('compact-v2'), requestId: id, kind: z.literal('result'),
    reviewedIds: z.array(id), unresolved: z.array(z.strictObject({ id, reason: explanation })),
    findings: z.array(CandidateSchema).max(100) }),
]);
// Nested maxItems constraints make Gemini reject this schema with HTTP 400.
// They remain mandatory in TaskResponseSchema; omit only the generation hints.
// Gemini does not enforce JSON Schema const, so encode discriminator literals as enums.
export const wireSchema = z.toJSONSchema(CompactResponseSchema, {
  target: 'draft-7',
  override: ({ jsonSchema }) => {
    delete jsonSchema.maxItems;
    if (jsonSchema.const !== undefined) {
      jsonSchema.enum = [jsonSchema.const];
      delete jsonSchema.const;
    }
  },
});
delete wireSchema.$schema;
