import { describe, expect, it, vi } from 'vitest';
import { resolveSettings, checkLegacy } from '../src/config.js';
import { authorize, type Invocation } from '../src/github/authorize.js';
import { Gemini } from '../src/providers/gemini.js';
import { requestFor } from '../src/providers/provider.js';
import { reviewTask } from '../src/planning/planner.js';
import { validateFindings } from '../src/review/validate.js';
import { TaskResponseSchema, wireSchema } from '../src/review/schema.js';
import { source, settings, rules, api, finding } from './helpers.js';
const repo = { id: 1, full_name: 'owner/repo', default_branch: 'main' };
const pr = { number: 29, state: 'open', user: { login: 'dev' }, base: { repo, sha: 'a'.repeat(40), ref: 'main' }, head: { repo, sha: 'b'.repeat(40), ref: 'feature' } };
const invocation = (): Invocation => ({ eventName: 'pull_request', event: { action: 'opened', pull_request: structuredClone(pr), repository: repo }, repository: repo.full_name,
  actor: 'dev', triggeringActor: 'dev', ref: 'refs/pull/29/merge', inputs: {} });
const github = () => api(path => path.includes('/permission') ? { permission: 'write' } : path.includes('/pulls/') ? pr : repo);
describe('configuration precedence and migration', () => {
  it('base config governs unspecified action inputs', () => {
    expect(resolveSettings('model: gemini-2.5-pro\npost_inline_comments: false', {})).toMatchObject({ model: 'gemini-2.5-pro', post_inline_comments: false });
    expect(resolveSettings('model: gemini-2.5-pro', { model: 'gemini-2.5-flash' }).model).toBe('gemini-2.5-flash');
  });
  it.each(['max_files', 'max_diff_size', 'context_depth'])('rejects legacy %s with migration guidance', name => {
    expect(() => checkLegacy({ [name]: '20' })).toThrow('removed in v2');
  });
  it('never allows repository settings to grant authorization', () => {
    expect(() => resolveSettings('publish: true', {})).toThrow('Invalid base configuration');
    expect(() => resolveSettings('review_mode: extended', {})).toThrow();
    expect(() => checkLegacy({ submit_review_verdict: 'true' })).toThrow('COMMENT');
    expect(() => checkLegacy({ submit_review_verdict: 'false' })).not.toThrow();
  });
});
describe('authorization before model use', () => {
  it('admits matching automatic events', async () => { expect((await authorize(github(), invocation())).pr!.number).toBe(29); });
  it('excludes forks and Dependabot', async () => {
    const i = invocation(); i.actor = 'dependabot[bot]'; expect((await authorize(github(), i)).skipped).toBeTruthy();
    i.actor = 'dev'; i.event = { action: 'opened', pull_request: { ...pr, head: { ...pr.head, repo: { ...repo, full_name: 'fork/repo' } } } };
    expect((await authorize(github(), i)).skipped).toContain('Fork');
  });
  it('requires event-head equality before model calls', async () => { const gh = api(() => ({ ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } })); await expect(authorize(gh, invocation())).rejects.toThrow('head'); });
  it('checks maintainer permission and rerun actor on manual runs', async () => {
    const i = invocation(); i.eventName = 'workflow_dispatch'; i.ref = 'refs/heads/main'; i.inputs = { pr_number: '29', publish: 'false', review_mode: 'extended' };
    const gh = github(); expect(await authorize(gh, i)).toMatchObject({ publish: false, mode: 'extended', manual: true });
    i.triggeringActor = 'revoked'; const revoked = api(path => path.includes('/revoked/') ? { permission: 'read' } : path.includes('/permission') ? { permission: 'write' } : path.includes('/pulls/') ? pr : repo);
    await expect(authorize(revoked, i)).rejects.toThrow('permission');
    i.ref = 'refs/heads/feature'; await expect(authorize(gh, i)).rejects.toThrow('default branch');
  });
  it('allows only exact commands on actual PRs and extend starts fresh', async () => {
    const i = invocation(); i.eventName = 'issue_comment'; i.ref = 'refs/heads/main';
    i.event = { action: 'created', issue: { number: 29, pull_request: {} }, comment: { body: '@dr-concretio extend', user: { login: 'maintainer' } } };
    expect((await authorize(github(), i)).mode).toBe('extended');
    i.event = { action: 'created', issue: { number: 29, pull_request: {} }, comment: { body: '@dr-concretio review please', user: { login: 'maintainer' } } };
    expect((await authorize(github(), i)).skipped).toBeTruthy();
    i.event = { action: 'created', issue: { number: 29 }, comment: { body: '@dr-concretio review', user: { login: 'maintainer' } } };
    expect((await authorize(github(), i)).skipped).toBeTruthy();
  });
});
describe('wire contract and evidence', () => {
  it('keeps array caps in local validation without expanding the Gemini response grammar', () => {
    expect(JSON.stringify(wireSchema)).not.toContain('"maxItems"');
    const response = { kind: 'result', taskId: 'probe', items: [], findings: [finding] };
    expect(TaskResponseSchema.safeParse(response).success).toBe(true);
    expect(TaskResponseSchema.safeParse({ ...response, findings: Array(101).fill(finding) }).success).toBe(false);
    expect(TaskResponseSchema.safeParse({ ...response, findings: [{ ...finding, evidenceIds: Array(101).fill('e0') }] }).success).toBe(false);
    const lookup = { kind: 'search', literal: 'symbol', side: 'RIGHT' };
    expect(TaskResponseSchema.safeParse({ kind: 'context_request', taskId: 'probe', requests: Array(5).fill(lookup) }).success).toBe(false);
  });
  it('retains useful HTTP diagnostics while redacting credentials and control characters', async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ error: {
      status: 'INVALID_ARGUMENT', message: 'Invalid response schema\nkey=test-key\u001b[31m',
    } }), { status: 400 }));
    const g = new Gemini('test-key', transport);
    const req = requestFor(reviewTask(source().atoms), source(), rules, settings.model, 32768);
    await expect(g.generateOnce(req, new AbortController().signal)).rejects.toMatchObject({
      message: 'Gemini generateContent HTTP 400: INVALID_ARGUMENT: Invalid response schema key=[REDACTED] [31m', retryable: false,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['not JSON', JSON.stringify({ error: { message: 'x'.repeat(17000) } })])('handles malformed or oversized error bodies', async body => {
    const g = new Gemini('test-key', async () => new Response(body, { status: 503, headers: { 'retry-after': '2' } }));
    const req = requestFor(reviewTask(source().atoms), source(), rules, settings.model, 32768);
    await expect(g.generateOnce(req, new AbortController().signal)).rejects.toMatchObject({
      message: 'Gemini generateContent HTTP 503', retryable: true, retryAfterMs: 2000,
    });
  });
  it('counts canonical requests and posts a single generation without hidden retries', async () => {
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      return new Response(JSON.stringify(body.generateContentRequest ? { totalTokens: 200 } : { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thought', thought: true }, { text: '{}' }] } }], usageMetadata: { totalTokenCount: 300, thoughtsTokenCount: 50 } }), { status: 200 });
    });
    const g = new Gemini('test-key', transport); const inv = source(); const req = requestFor(reviewTask(inv.atoms), inv, rules, settings.model, 32768);
    expect(await g.count(req, new AbortController().signal)).toBe(200); const response = await g.generateOnce(req, new AbortController().signal);
    expect(response.text).toBe('{}'); expect(response.usage!.totalTokenCount).toBe(300);
    const counted = JSON.parse(transport.mock.calls[0]![1]!.body as string).generateContentRequest;
    const generated = JSON.parse(transport.mock.calls[1]![1]!.body as string);
    expect({ model: req.model, ...generated }).toEqual(counted); expect(transport).toHaveBeenCalledTimes(2);
  });
  it('accepts unchanged and base-side support but rejects fabricated or invalid anchors', () => {
    const inv = source(); inv.evidence.set('base', { ...inv.evidence.get('e0')!, id: 'base', path: 'caller.ts', side: 'LEFT', revision: 'a'.repeat(40) });
    const task = reviewTask(inv.atoms); task.evidenceIds.push('base');
    expect(validateFindings([{ ...finding, evidenceIds: ['e0', 'base'] }], task, inv).accepted).toHaveLength(1);
    expect(validateFindings([{ ...finding, anchor: { ...finding.anchor!, line: 99 } }], task, inv).accepted).toHaveLength(0);
  });
});
