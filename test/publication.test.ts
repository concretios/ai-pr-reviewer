import { describe, expect, it, vi } from 'vitest';
import { publish, mergeSummary, readSummary, type RemoteComment } from '../src/github/publish.js';
import { GitHubError, type GitHubAPI } from '../src/github/client.js';
import { emptyAnalysis } from '../src/runtime/runner.js';
import { actionExitCode, detailPages, renderReport, summaryBody } from '../src/reporting/render.js';
import { manifest, settings, finding, source } from './helpers.js';
import type { FinalizedRun } from '../src/contracts.js';
function setup(mode = '') {
  const comments: RemoteComment[] = []; const reviews: RemoteComment[] = []; const inlineComments: RemoteComment[] = []; let writes = 0; let serial = 0;
  const api = {
    get: vi.fn(),
    list: vi.fn(async <T>(path: string) => {
      if (mode === 'inline-uncertain' && path.includes('/pulls/')) return [] as T[];
      if (mode === 'uncertain' && writes) return [] as T[];
      return (path.includes('/reviews') ? reviews : path.includes('/pulls/') ? inlineComments : comments) as T[];
    }),
    write: vi.fn(async <T>(_method: string, path: string, value: unknown) => {
      const body = value as { body: string; commit_id?: string; comments?: Array<Partial<RemoteComment>>; path?: string; subject_type?: string }; writes++;
      if (mode === 'inline-failure' && path.includes('/reviews')) throw new GitHubError('inline rejected', false, 422);
      if (mode === 'final-failure' && _method === 'PATCH') throw new GitHubError('summary forbidden', false, 403);
      if (mode === 'second-page-failure' && writes === 2) throw new GitHubError('detail forbidden', false, 403);
      const collection = path.includes('/reviews') ? reviews : path.includes('/pulls/') ? inlineComments : comments;
      const existingId = _method === 'PATCH' ? Number(path.split('/').at(-1)) : undefined;
      const result: RemoteComment = { id: existingId ?? ++serial, body: body.body, user: { id: 1 }, commit_id: body.commit_id, path: body.path, subject_type: body.subject_type };
      const old = collection.findIndex(c => c.id === existingId);
      if (old >= 0) collection[old] = result; else collection.push(result);
      for (const c of body.comments ?? []) inlineComments.push({ ...c, id: ++serial, body: c.body!, user: { id: 1 }, commit_id: body.commit_id, original_commit_id: body.commit_id, pull_request_review_id: result.id });
      if (mode === 'inline-uncertain' && path.includes('/pulls/')) throw new GitHubError('inline response lost', true);
      if (mode === 'lost' || mode === 'uncertain') throw new GitHubError('response lost', true);
      return result as T;
    }),
  } as unknown as GitHubAPI;
  const analysis = { ...emptyAnalysis(), status: 'complete' as const, analysisStatus: 'complete' as const, findings: [finding] };
  const options = { api, manifest, analysis, settings, order: { createdAt: '2026-09-15T00:00:00Z', runId: '10', attempt: 1 }, authorId: 1, fresh: vi.fn(async () => true) };
  const final = (publication: Awaited<ReturnType<typeof publish>>): FinalizedRun => ({ analysis, manifest, publication, notices: [], omissions: [] });
  return { options, final, comments, reviews, inlineComments, writes: () => writes };
}
describe('persistent delivery contract', () => {
  it('publishes the same usage/cost figures in the PR summary and artifact report', async () => {
    const s = setup();
    s.options.analysis.attempts = [{ taskId: 'test', preflight: 1000, promptTokenCount: 1000, totalTokenCount: 2000 }];
    s.options.analysis.usage = { attempts: 1, charged: 2000, reserved: 0, unknown: 0 };
    const publication = await publish(s.options);
    expect(s.comments.at(-1)!.body).toContain('$0.0028 USD');
    expect(renderReport(s.final(publication))).toContain('$0.0028 USD');
  });
  it('accepted POST plus lost response reconciles without duplicate writes', async () => {
    const s = setup('lost'); const p = await publish(s.options);
    expect(p.status).toBe('published'); expect(s.comments).toHaveLength(1); expect(s.reviews).toHaveLength(1); expect(actionExitCode(s.final(p))).toBe(0);
  });
  it('inconclusive required reconciliation fails delivery, preserves analysis and report', async () => {
    const s = setup('uncertain'); const p = await publish(s.options); const run = s.final(p);
    expect(p.status).toBe('uncertain'); expect(actionExitCode(run)).toBe(1); expect(run.analysis.status).toBe('complete'); expect(renderReport(run)).toContain('Concrete regression');
    expect(s.writes()).toBe(1);
  });
  it('inline failure is nonfatal and all concern text persists', async () => {
    const s = setup('inline-failure'); const p = await publish(s.options);
    expect(p.status).toBe('partial'); expect(actionExitCode(s.final(p))).toBe(0); expect(s.comments[0]!.body).toContain(finding.consequence);
    expect(s.comments.at(-1)!.body).toContain('Inline delivery is incomplete');
  });
  it('uncertain inline delivery is nonfatal when every mandatory write is confirmed', async () => {
    const s = setup('inline-uncertain'); const p = await publish(s.options);
    expect(p.status).toBe('partial'); expect(actionExitCode(s.final(p))).toBe(0);
    expect(p.operations.filter(o => o.required).every(o => o.state === 'confirmed')).toBe(true);
    expect(p.operations.find(o => !o.required)!.state).toBe('unconfirmed');
  });
  it('retains below-threshold and unanchored concerns in persistent pages', async () => {
    const s = setup(); s.options.settings = { ...settings, comment_severity_threshold: 'critical' };
    s.options.analysis.findings.push({ ...finding, title: 'Unanchored low concern', severity: 'low', anchor: null });
    const p = await publish(s.options); expect(p.status).toBe('published'); expect(s.reviews).toHaveLength(0); expect(s.comments[0]!.body).toContain('Unanchored low concern');
  });
  it('one required page failure is fatal even if summary succeeds', async () => {
    const s = setup('second-page-failure'); s.options.analysis.findings = Array.from({ length: 15 }, (_, i) => ({ ...finding, title: `Concern ${i}`, consequence: 'x'.repeat(4000) }));
    const p = await publish(s.options); expect(p.status).toBe('partial'); expect(actionExitCode(s.final(p))).toBe(1);
    expect(p.operations.find(o => o.state === 'failed')!.findingIds.length).toBeGreaterThan(0);
  });
  it.each([3, 4, 5])('head change at freshness gate %i stops subsequent writes and counts unissued pages', async cutoff => {
    const s = setup(); let gates = 0; s.options.fresh = vi.fn(async () => ++gates < cutoff);
    const p = await publish(s.options); expect(p.superseded).toBe(true);
    expect(s.writes()).toBeLessThan(3); expect(actionExitCode(s.final(p))).toBe(1);
    expect(p.operations.filter(o => o.state === 'confirmed').length).toBeLessThanOrEqual(s.writes());
  });
  it('supersession before publication starts causes no writes and no delivery failure', async () => {
    const s = setup(); s.options.fresh = vi.fn(async () => false);
    const p = await publish(s.options); expect(p.status).toBe('not_requested'); expect(s.writes()).toBe(0); expect(actionExitCode(s.final(p))).toBe(0);
  });
  it('forged marker from another author is never updated', async () => {
    const s = setup(); s.comments.push({ id: 999, user: { id: 999 }, body: '<!-- ai-pr-reviewer:v2:dr-concretio:summary -->\nforged' });
    await publish(s.options); expect(s.options.api.write).not.toHaveBeenCalledWith('PATCH', '/repos/owner/repo/issues/comments/999', expect.anything());
  });
  it('a repeated confirmed attempt skips identical remote updates', async () => {
    const s = setup(); await publish(s.options); const calls = s.writes(); await publish(s.options); expect(s.writes()).toBe(calls);
  });
  it('does not duplicate identical inline concerns when a different trigger reviews the same head', async () => {
    const s = setup(); await publish(s.options);
    s.options.order = { ...s.options.order, runId: '11', createdAt: '2026-09-16T00:00:00Z' };
    const p = await publish(s.options); expect(p.status).toBe('published'); expect(s.reviews).toHaveLength(1);
  });
  it('out-of-order partial/older runs cannot erase a newer completed result', () => {
    const newer = { order: { createdAt: '2026-09-15T00:00:00Z', runId: '20', attempt: 1 }, status: 'complete' as const, text: 'New complete result' };
    const older = { order: { createdAt: '2026-09-14T00:00:00Z', runId: '10', attempt: 2 }, status: 'partial' as const, text: 'Old partial' };
    expect(mergeSummary({ latest: newer, completed: newer }, older)).toEqual({ latest: newer, completed: newer, current: older });
    const unknown = { ...older, order: { ...older.order, createdAt: '' } };
    expect(mergeSummary({ latest: newer, completed: newer }, unknown).completed).toEqual(newer);
  });
  it('paginates by UTF-8 bytes without losing multibyte concern text', () => {
    const f = { ...finding, consequence: '🌍'.repeat(12000) };
    const pages = detailPages([f]); expect(pages).toHaveLength(2);
    expect(pages.every(p => Buffer.byteLength(p.text) <= 47000)).toBe(true); expect(pages.map(p => p.text).join('')).toContain(f.consequence);
  });
});

it('reordered batches and new findings only post missing individual threads', async () => {
  const s = setup();
  s.options.analysis.findings.push({ ...finding, title: 'Second finding' });
  await publish(s.options);
  s.options.analysis.findings.reverse();
  s.options.analysis.findings.push({ ...finding, title: 'Third finding' });
  await publish(s.options);
  expect(s.comments).toHaveLength(1); expect(s.inlineComments).toHaveLength(3);
  expect(s.reviews).toHaveLength(2);
  expect(s.comments[0]!.body).toContain('🩺 Dr. Concret.io');
});
it('recognizes old inline IDs only through a trusted same-commit review', async () => {
  const { findingId } = await import('../src/review/validate.js');
  const s = setup();
  s.reviews.push({ id: 100, user: { id: 1 }, commit_id: manifest.headSha,
    body: `<!-- ai-pr-reviewer:v2:dr-concretio:inline-${manifest.headSha}-old -->\nold` });
  s.inlineComments.push({ id: 101, user: { id: 1 }, pull_request_review_id: 100, commit_id: manifest.headSha,
    path: finding.anchor!.path, side: 'RIGHT', line: 1, body: `Old comment\nConcern ID: ${findingId(finding)}\n` });
  await publish(s.options); expect(s.reviews).toHaveLength(1); expect(s.comments).toHaveLength(1);
});
it('posts a validated single-file concern at file level and reconciles reruns', async () => {
  const s = setup(); s.options.analysis.findings = [{ ...finding, anchor: null }];
  const o = { ...s.options, inventory: source() };
  expect((await publish(o)).status).toBe('published');
  expect(s.inlineComments[0]!.subject_type).toBe('file');
  await publish(o); expect(s.inlineComments).toHaveLength(1);
});
it('retains unordered current state, deduplicates history and keeps partial wording honest', () => {
  const old = { order: { createdAt: '', runId: '10', attempt: 1 }, status: 'unavailable' as const, text: 'Old failure' };
  const current = { order: { createdAt: '', runId: '20', attempt: 1 }, status: 'partial' as const, text: 'Current partial' };
  const body = summaryBody({ latest: old, current });
  expect(body.indexOf('Current partial', body.indexOf('##'))).toBeLessThan(body.indexOf('Old failure', body.indexOf('##')));
  expect(readSummary({ id: 1, body, user: { id: 1 } })!.current).toEqual(current);
  const complete = { ...current, status: 'complete' as const };
  const rendered = summaryBody({ latest: complete, completed: complete });
  expect(rendered.match(/Current partial/g)).toHaveLength(1);
});
it('retains exact UTF-8 text in required overflow comments and keeps main under limit', async () => {
  const s = setup(); s.options.settings = { ...settings, post_inline_comments: false };
  s.options.analysis.findings = [{ ...finding, consequence: '🌍'.repeat(12000) }];
  const p = await publish(s.options);
  expect(p.status).toBe('published');
  expect(s.comments.every(c => Buffer.byteLength(c.body) < 50000)).toBe(true);
  expect(s.comments.filter(c => c.body.includes(':detail-')).map(c => c.body.split('Reviewed commit:')[1]).join('')).toContain('🌍'.repeat(1000));
  expect(s.comments.filter(c => c.body.startsWith('<!-- ai-pr-reviewer:v2:dr-concretio:summary -->'))).toHaveLength(1);
});
it('failed finalization does not promote a new completed record in the prepared summary', async () => {
  const s = setup('final-failure'); const p = await publish(s.options);
  expect(p.status).toBe('partial'); expect(actionExitCode(s.final(p))).toBe(1);
  expect(readSummary(s.comments[0])!.completed).toBeUndefined();
  expect(s.comments[0]!.body).toContain(finding.consequence);
});
it('backfills legacy timestamps when actions metadata becomes readable', async () => {
  const s = setup();
  const old = { order: { createdAt: '', runId: '1', attempt: 1 }, status: 'unavailable' as const, text: 'Old unavailable' };
  s.comments.push({ id: 999, user: { id: 1 }, body: '<!-- ai-pr-reviewer:v2:dr-concretio:summary -->\n' + summaryBody({ latest: old }) });
  vi.mocked(s.options.api.get).mockResolvedValue({ created_at: '2026-09-14T00:00:00Z' });
  await publish(s.options);
  const state = readSummary(s.comments[0])!;
  expect(state.latest.order.runId).toBe('10'); expect(state.current).toBeUndefined();
  expect(s.comments).toHaveLength(1);
});
it('keeps a newer formerly-unordered record after timestamp backfill', () => {
  const record = (runId: string, day: string) => ({ order: { runId, createdAt: `2026-09-${day}T00:00:00Z`, attempt: 1 }, status: 'partial' as const, text: runId });
  const state = mergeSummary({ latest: record('10', '10'), current: record('30', '15') }, record('20', '12'));
  expect(state.latest.order.runId).toBe('30'); expect(state.current!.order.runId).toBe('20');
});
it('allows a deletion-only change as a file comment when the head manifest proves the file still exists', async () => {
  const s = setup(); const inv = source(); inv.atoms[0]!.side = 'LEFT';
  s.options.analysis.findings = [{ ...finding, anchor: null }];
  const manifestWithFile = { ...manifest, evidenceBlobs: { [`${manifest.headSha}:file0.ts`]: { revision: manifest.headSha, path: 'file0.ts', blobId: 'head-blob' } } };
  await publish({ ...s.options, manifest: manifestWithFile, inventory: inv });
  expect(s.inlineComments[0]!.subject_type).toBe('file');
});
