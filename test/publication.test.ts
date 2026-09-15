import { describe, expect, it, vi } from 'vitest';
import { publish, mergeSummary, type RemoteComment } from '../src/github/publish.js';
import { GitHubError, type GitHubAPI } from '../src/github/client.js';
import { emptyAnalysis } from '../src/runtime/runner.js';
import { actionExitCode, detailPages, renderReport } from '../src/reporting/render.js';
import { manifest, settings, finding } from './helpers.js';
import type { FinalizedRun } from '../src/contracts.js';
function setup(mode = '') {
  const comments: RemoteComment[] = []; const reviews: RemoteComment[] = []; let writes = 0;
  const api = {
    get: vi.fn(),
    list: vi.fn(async <T>(path: string) => {
      if (mode === 'inline-uncertain' && path.includes('/reviews')) return [] as T[];
      if (mode === 'uncertain' && writes) return [] as T[];
      return (path.includes('/reviews') ? reviews : comments) as T[];
    }),
    write: vi.fn(async <T>(_method: string, path: string, value: unknown) => {
      const body = value as { body: string; commit_id?: string }; writes++;
      if (mode === 'inline-failure' && path.includes('/reviews')) throw new GitHubError('inline rejected', false, 422);
      if (mode === 'second-page-failure' && writes === 2) throw new GitHubError('detail forbidden', false, 403);
      const result: RemoteComment = { id: writes, body: body.body, user: { id: 1 }, commit_id: body.commit_id };
      (path.includes('/reviews') ? reviews : comments).push(result);
      if (mode === 'inline-uncertain' && path.includes('/reviews')) throw new GitHubError('inline response lost', true);
      if (mode === 'lost' || mode === 'uncertain') throw new GitHubError('response lost', true);
      return result as T;
    }),
  } as unknown as GitHubAPI;
  const analysis = { ...emptyAnalysis(), status: 'complete' as const, analysisStatus: 'complete' as const, findings: [finding] };
  const options = { api, manifest, analysis, settings, order: { createdAt: '2026-09-15T00:00:00Z', runId: '10', attempt: 1 }, authorId: 1, fresh: vi.fn(async () => true) };
  const final = (publication: Awaited<ReturnType<typeof publish>>): FinalizedRun => ({ analysis, manifest, publication, notices: [], omissions: [] });
  return { options, final, comments, reviews, writes: () => writes };
}
describe('persistent delivery contract', () => {
  it('accepted POST plus lost response reconciles without duplicate writes', async () => {
    const s = setup('lost'); const p = await publish(s.options);
    expect(p.status).toBe('published'); expect(s.comments).toHaveLength(2); expect(s.reviews).toHaveLength(1); expect(actionExitCode(s.final(p))).toBe(0);
  });
  it('inconclusive required reconciliation fails delivery, preserves analysis and report', async () => {
    const s = setup('uncertain'); const p = await publish(s.options); const run = s.final(p);
    expect(p.status).toBe('uncertain'); expect(actionExitCode(run)).toBe(1); expect(run.analysis.status).toBe('complete'); expect(renderReport(run)).toContain('Concrete regression');
    expect(s.writes()).toBe(3);
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
  it.each([3, 4, 5, 6])('head change at freshness gate %i stops subsequent writes and counts unissued pages', async cutoff => {
    const s = setup(); let gates = 0; s.options.fresh = vi.fn(async () => ++gates < cutoff);
    const p = await publish(s.options); expect(p.superseded).toBe(true);
    expect(s.writes()).toBeLessThan(3); expect(actionExitCode(s.final(p))).toBe(1);
    expect(p.operations.filter(o => o.state === 'confirmed').length).toBe(s.writes());
  });
  it('supersession before publication starts causes no writes and no delivery failure', async () => {
    const s = setup(); s.options.fresh = vi.fn(async () => false);
    const p = await publish(s.options); expect(p.status).toBe('not_requested'); expect(s.writes()).toBe(0); expect(actionExitCode(s.final(p))).toBe(0);
  });
  it('forged marker from another author is never updated', async () => {
    const s = setup(); s.comments.push({ id: 999, user: { id: 999 }, body: '<!-- ai-pr-reviewer:v2:dr-concretio:summary -->\nforged' });
    await publish(s.options); expect(s.options.api.write).not.toHaveBeenCalledWith('PATCH', expect.anything(), expect.anything());
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
