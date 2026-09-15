import { z } from 'zod';
import { boolean, type Inputs } from '../config.js';
import { ConfigurationError, Superseded } from '../util.js';
import type { GitHubAPI } from './client.js';

const repositorySchema = z.object({ id: z.number(), full_name: z.string(), default_branch: z.string() });
const refSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/), ref: z.string(), repo: repositorySchema.nullable() });
export const prSchema = z.object({ number: z.number().int().positive(), state: z.enum(['open', 'closed']), draft: z.boolean().optional(),
  head: refSchema, base: refSchema, user: z.object({ login: z.string() }) });
export type PullRequest = z.infer<typeof prSchema>;
const eventSchema = z.object({ action: z.string().optional(), number: z.number().optional(),
  pull_request: prSchema.optional(),
  issue: z.object({ number: z.number(), pull_request: z.unknown().optional() }).optional(),
  comment: z.object({ body: z.string(), user: z.object({ login: z.string() }) }).optional(),
  repository: repositorySchema.optional(),
});
export type Invocation = { eventName: string; event: unknown; repository: string; actor: string; triggeringActor: string; ref: string; inputs: Inputs };
export type Admission = { pr?: PullRequest; mode: 'auto' | 'extended'; publish: boolean; skipped?: string; manual: boolean; commandBot?: string };
export async function maintainers(api: GitHubAPI, repository: string, actors: string[]): Promise<void> {
  for (const actor of new Set(actors)) {
    if (!actor || actor.endsWith('[bot]')) throw new ConfigurationError('Manual review requires a current human maintainer');
    const data = await api.get<{ permission: string }>(`/repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`);
    if (!['write', 'maintain', 'admin'].includes(data.permission)) throw new ConfigurationError(`Current write/admin permission required for ${actor}`);
  }
}
export async function authorize(api: GitHubAPI, invocation: Invocation): Promise<Admission> {
  const { inputs, repository } = invocation;
  const event = eventSchema.parse(invocation.event);
  const mode = inputs.review_mode?.trim() || 'auto';
  if (mode !== 'auto' && mode !== 'extended') throw new ConfigurationError('review_mode must be auto or extended');
  const publish = boolean(inputs.publish?.trim() || 'true', 'publish');
  const excluded = (reason: string): Admission => ({ mode, publish: false, skipped: reason, manual: false });
  let prNumber: number | undefined; let manual = false; let requestedMode: 'auto' | 'extended' = mode; let commandBot: string | undefined;
  if (invocation.eventName === 'pull_request') {
    if (!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(event.action ?? '')) return excluded('Unsupported pull_request event');
    if (!event.pull_request) throw new ConfigurationError('Missing pull_request payload');
    if (invocation.actor === 'dependabot[bot]' || event.pull_request.user.login === 'dependabot[bot]') return excluded('Dependabot reviews are excluded');
    if (event.pull_request.head.repo?.full_name !== repository) return excluded('Fork PR reviews are excluded');
    if (mode === 'extended') throw new ConfigurationError('Extended mode requires a maintainer dispatch or exact extend command');
    prNumber = event.pull_request.number;
  } else if (invocation.eventName === 'workflow_dispatch' || invocation.eventName === 'issue_comment') {
    manual = true;
    const repo = repositorySchema.parse(await api.get(`/repos/${repository}`));
    if (invocation.ref !== `refs/heads/${repo.default_branch}`) throw new ConfigurationError('Manual review must run from the default branch');
    const actors = [invocation.actor, invocation.triggeringActor];
    if (invocation.eventName === 'issue_comment') {
      if (event.action !== 'created' || !event.issue?.pull_request || !event.comment) return excluded('Only new comments on actual PRs are supported');
      const command = event.comment.body.trim();
      const match = /^@([A-Za-z0-9_-]{1,80}) (review|extend)$/.exec(command);
      if (!match || inputs.bot_name?.trim() && match[1] !== inputs.bot_name.trim()) return excluded('Comment is not an exact reviewer command');
      // Resolve an unspecified bot identity against captured base configuration before model calls.
      commandBot = match[1];
      actors.push(event.comment.user.login);
      requestedMode = match[2] === 'extend' ? 'extended' : 'auto';
      prNumber = event.issue.number;
    } else {
      if (!/^\d+$/.test(inputs.pr_number?.trim() ?? '')) throw new ConfigurationError('workflow_dispatch requires an explicit positive pr_number');
      prNumber = Number(inputs.pr_number);
    }
    await maintainers(api, repository, actors);
  } else return excluded(`Excluded event: ${invocation.eventName}`);
  if (!Number.isSafeInteger(prNumber) || !prNumber || prNumber < 1) throw new ConfigurationError('Invalid PR number');
  if (inputs.pr_number?.trim() && Number(inputs.pr_number) !== prNumber) throw new ConfigurationError('pr_number conflicts with the authorized event');
  const pr = prSchema.parse(await api.get(`/repos/${repository}/pulls/${prNumber}`));
  if (pr.number !== prNumber || pr.base.repo?.full_name !== repository) throw new ConfigurationError('PR repository identity mismatch');
  if (pr.head.repo?.id !== pr.base.repo?.id || pr.user.login === 'dependabot[bot]') return excluded('Fork and Dependabot PRs are excluded from live review');
  if (pr.state !== 'open') return excluded('Closed PRs require the separate pinned diagnostic replay');
  if (!manual && pr.head.sha !== event.pull_request!.head.sha) throw new Superseded('Event head no longer matches current PR head');
  return { mode: requestedMode, publish, pr, manual, commandBot };
}
