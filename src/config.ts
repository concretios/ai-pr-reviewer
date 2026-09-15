import { z } from 'zod';
import { parseDocument } from 'yaml';
import { ConfigurationError } from './util.js';

const settingsSchema = z.strictObject({
  model: z.string().regex(/^(?:models\/)?[a-zA-Z0-9._-]+$/).default('gemini-2.5-flash'),
  post_inline_comments: z.boolean().default(true),
  comment_severity_threshold: z.enum(['critical', 'high', 'medium', 'low']).default('low'),
  bot_name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).default('dr-concretio'),
  rules_paths: z.array(z.string().min(1)).default(['review-rules.md', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md']),
  exclude_paths: z.array(z.string().min(1)).default([]),
});
export type Settings = z.infer<typeof settingsSchema>;
export type Inputs = Record<string, string | undefined>;
export type Limits = { input: number; output: number; attempts: number; tokens: number; durationMs: number; reserveMs: number; concurrency: number };
export function limits(mode: 'auto' | 'extended'): Limits {
  return { input: 32000, output: 32768, attempts: mode === 'auto' ? 12 : 24,
    tokens: mode === 'auto' ? 500000 : 1000000, durationMs: mode === 'auto' ? 600000 : 1200000,
    reserveMs: 60000, concurrency: 2 };
}
export function boolean(value: string, name: string): boolean {
  if (value !== 'true' && value !== 'false') throw new ConfigurationError(`${name} must be true or false`);
  return value === 'true';
}
export function checkLegacy(inputs: Inputs): void {
  for (const name of ['max_files', 'max_diff_size', 'context_depth']) {
    if (inputs[name]?.trim()) throw new ConfigurationError(`${name} was removed in v2. Remove it and use bounded adaptive batching; use review_mode=extended for a larger per-invocation budget. See docs/migration-v2.md.`);
  }
  if (inputs.submit_review_verdict?.trim() && boolean(inputs.submit_review_verdict, 'submit_review_verdict')) {
    throw new ConfigurationError('submit_review_verdict=true is unsupported. v2 publishes advisory COMMENT reviews only.');
  }
}
export function resolveSettings(baseYaml: string | undefined, inputs: Inputs): Settings {
  checkLegacy(inputs);
  try {
    if (Buffer.byteLength(baseYaml ?? '', 'utf8') > 1024 * 1024) throw new Error('Configuration exceeds 1 MiB');
    const doc = parseDocument(baseYaml ?? '', { uniqueKeys: true });
    if (doc.errors.length) throw doc.errors[0];
    const base: unknown = doc.toJS({ maxAliasCount: 0 }) ?? {};
    if (typeof base !== 'object' || Array.isArray(base) || base === null) throw new Error('Expected a configuration mapping');
    const explicit: Record<string, unknown> = {};
    for (const key of ['model', 'bot_name', 'comment_severity_threshold']) if (inputs[key]?.trim()) explicit[key] = inputs[key]!.trim();
    if (inputs.post_inline_comments?.trim()) explicit.post_inline_comments = boolean(inputs.post_inline_comments, 'post_inline_comments');
    if (inputs.rules_paths?.trim()) explicit.rules_paths = inputs.rules_paths.split(',').map(x => x.trim()).filter(Boolean);
    // Parse base independently so invalid/authorization fields cannot be hidden by overrides.
    return settingsSchema.parse({ ...settingsSchema.parse(base), ...explicit });
  } catch (error) { throw new ConfigurationError(`Invalid base configuration: ${error instanceof Error ? error.message : String(error)}`); }
}
