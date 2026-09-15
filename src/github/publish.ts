import type { Analysis, Manifest, Operation, Publication, RunOrder } from '../contracts.js';
import type { Settings } from '../config.js';
import { GitHubError, type GitHubAPI } from './client.js';
import { analysisText, deliveryStatus, detailPages, renderFinding, summaryBody, type SummaryState, type SummaryRecord } from '../reporting/render.js';
import { findingId } from '../review/validate.js';
import { hash, message } from '../util.js';
import { z } from 'zod';

export type RemoteComment = { id: number; body: string; user: { id: number }; html_url?: string; commit_id?: string };
const recordSchema = z.object({ order: z.object({ createdAt: z.string(), runId: z.string().regex(/^\d+$/), attempt: z.number().int() }),
  status: z.enum(['complete', 'partial', 'unavailable', 'skipped', 'superseded']), text: z.string().max(10000) });
const stateSchema = z.object({ latest: recordSchema, completed: recordSchema.optional() });
export function compareOrder(a: RunOrder, b: RunOrder): number | undefined {
  if (a.runId === b.runId) return a.attempt - b.attempt;
  if (!a.createdAt || !b.createdAt) return undefined;
  const time = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (!Number.isFinite(time)) return undefined;
  return time || (BigInt(a.runId) > BigInt(b.runId) ? 1 : -1);
}
export function mergeSummary(previous: SummaryState | undefined, current: SummaryRecord, completedEligible = true): SummaryState {
  if (!previous) return { latest: current, completed: current.status === 'complete' && completedEligible ? current : undefined };
  const newer = compareOrder(current.order, previous.latest.order);
  const latest = newer !== undefined && newer >= 0 ? current : previous.latest;
  const completedOrder = previous.completed ? compareOrder(current.order, previous.completed.order) : 1;
  const completed = completedEligible && current.status === 'complete' && completedOrder !== undefined && completedOrder >= 0 ? current : previous.completed;
  return { latest, completed, current: latest === current ? undefined : current };
}
export function readSummary(comment: RemoteComment | undefined): SummaryState | undefined {
  const data = comment?.body.match(/<!-- state:([A-Za-z0-9+/=]+) -->/);
  if (!data) return undefined;
  try { return stateSchema.parse(JSON.parse(Buffer.from(data[1]!, 'base64').toString('utf8'))); } catch { return undefined; }
}
export type PublishOptions = {
  api: GitHubAPI; manifest: Manifest; analysis: Analysis; settings: Settings; order: RunOrder;
  authorId: number; fresh: () => Promise<boolean>; notices?: string[];
};
export async function publish(options: PublishOptions): Promise<Publication> {
  const { api, manifest, analysis, settings, order, authorId } = options;
  const publication: Publication = { started: false, status: 'not_requested', operations: [], superseded: false };
  const root = `/repos/${manifest.repository}`;
  const commentsPath = `${root}/issues/${manifest.prNumber}/comments`;
  const reviewsPath = `${root}/pulls/${manifest.prNumber}/reviews`;
  const marker = (id: string) => `<!-- ai-pr-reviewer:v2:${settings.bot_name}:${id} -->`;
  const attemptId = `${order.runId}-${order.attempt}-${manifest.headSha}`;
  const pages = detailPages(analysis.findings);
  const details = pages.map((page, index) => {
    const id = `detail-${attemptId}-${index + 1}`;
    return { operation: { id, required: true, contentHash: '', state: 'pending', findingIds: page.findingIds } as Operation,
      body: `${marker(id)}\n## Advisory concerns, page ${index + 1}/${pages.length}\n\nCaptured head: ${manifest.headSha}\n\n${page.text}` };
  });
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  const eligible = settings.post_inline_comments ? analysis.findings.filter(f => f.anchor && rank[f.severity] <= rank[settings.comment_severity_threshold]) : [];
  const inline = [];
  for (let offset = 0; offset < eligible.length; offset += 50) {
    const findings = eligible.slice(offset, offset + 50);
    const id = `inline-${manifest.headSha}-${hash(findings.map(findingId)).slice(0, 24)}`;
    inline.push({ operation: { id, required: false, contentHash: '', state: 'pending', findingIds: findings.map(findingId) } as Operation,
      body: `${marker(id)}\nAdvisory model-reported concerns for ${manifest.headSha}. Payload: ${hash(findings)}. All concerns are retained in detail comments.`,
      comments: findings.map(f => ({ path: f.anchor!.path, side: f.anchor!.side, line: f.anchor!.line, body: renderFinding(f) })) });
  }
  const summaryOperation: Operation = { id: 'summary', required: true, contentHash: hash(analysisText(analysis, manifest.headSha, manifest.model)), state: 'pending', findingIds: analysis.findings.map(findingId) };
  publication.operations = [...details.map(d => d.operation), ...inline.map(i => i.operation), summaryOperation];
  for (const detail of details) detail.operation.contentHash = hash(detail.body);
  for (const item of inline) item.operation.contentHash = hash(item.body);
  const fresh = async (): Promise<boolean> => {
    if (await options.fresh()) return true;
    publication.superseded = true; return false;
  };
  let existing: RemoteComment[] = [];
  const trusted = (items: RemoteComment[], id: string) => items.filter(c => c.user.id === authorId && c.body.startsWith(marker(id) + '\n'));
  async function deliver(operation: Operation, body: string, review?: { comments: unknown[] }): Promise<void> {
    operation.contentHash = hash(body);
    const collection = review ? reviewsPath : commentsPath;
    // Always list before creation, including reruns and ambiguous prior invocations.
    const items = review ? await api.list<RemoteComment>(collection) : existing;
    const candidates = trusted(items, operation.id);
    const identical = candidates.find(c => hash(c.body) === operation.contentHash && (!review || c.commit_id === manifest.headSha));
    if (identical) { operation.state = 'confirmed'; operation.remoteId = identical.id; return; }
    const previous = !review ? candidates[0] : undefined;
    try {
      const result = await api.write<RemoteComment>(previous ? 'PATCH' : 'POST', previous ? `${root}/issues/comments/${previous.id}` : collection,
        review ? { body, event: 'COMMENT', commit_id: manifest.headSha, comments: review.comments } : { body });
      if (result.user.id !== authorId || hash(result.body) !== operation.contentHash || (review && result.commit_id !== manifest.headSha)) throw new GitHubError('Accepted response identity/content mismatch', true);
      operation.state = 'confirmed'; operation.remoteId = result.id;
      if (!review) existing = [...existing.filter(c => c.id !== result.id), result];
    } catch (error) {
      operation.error = message(error);
      if (error instanceof GitHubError && !error.uncertain) { operation.state = 'failed'; return; }
      // One bounded reconciliation. Never blindly recreate after a possibly accepted write.
      try {
        const reconciled = await api.list<RemoteComment>(collection);
        const found = trusted(reconciled, operation.id).find(c => hash(c.body) === operation.contentHash && (!review || c.commit_id === manifest.headSha));
        if (found) { operation.state = 'confirmed'; operation.remoteId = found.id; operation.error = undefined; if (!review) existing = reconciled; return; }
      } catch { /* Absence cannot establish non-delivery after an ambiguous write. */ }
      operation.state = 'unconfirmed';
    }
  }
  try {
    if (!await fresh()) return publication;
    existing = await api.list<RemoteComment>(commentsPath);
    if (!await fresh()) return publication;
    publication.started = true;
    for (const detail of details) {
      if (!await fresh()) break;
      await deliver(detail.operation, detail.body);
    }
    if (!publication.superseded && await fresh()) {
      for (const item of inline) {
        if (!await fresh()) break;
        try { await deliver(item.operation, item.body, { comments: item.comments }); }
        catch (error) { item.operation.state = 'failed'; item.operation.error = message(error); }
      }
    }
    if (!publication.superseded && await fresh()) {
      // Refresh the shared summary before merging; do not derive newest from queue order.
      existing = await api.list<RemoteComment>(commentsPath);
      const previous = readSummary(trusted(existing, 'summary')[0]);
      const detailStatus = details.map(d => `- Page ${d.operation.id}: ${d.operation.state}${d.operation.remoteId ? ` (comment ${d.operation.remoteId})` : ''}`).join('\n');
      const inlineLimit = inline.some(i => i.operation.state !== 'confirmed') ? '\n\nInline delivery is incomplete. All accepted concerns are required in the detail pages above.' : '';
      const detailText = detailStatus.length < 4000 ? detailStatus : `${details.filter(d => d.operation.state === 'confirmed').length}/${details.length} required detail pages confirmed. See artifact for operation IDs.`;
      const current = { order, status: analysis.status, text: analysisText(analysis, manifest.headSha, manifest.model) + '\n' + detailText + inlineLimit + '\n\n' + (options.notices ?? []).slice(0, 8).join('\n').slice(0, 1000) };
      const body = `${marker('summary')}\n${summaryBody(mergeSummary(previous, current, details.every(d => d.operation.state === 'confirmed')))}`;
      if (Buffer.byteLength(body) >= 50000) throw new Error('Required summary exceeds safe comment size');
      if (await fresh()) await deliver(summaryOperation, body);
    }
  } catch (error) {
    // Reconciliation/read failures still leave a complete operation ledger for the caller.
    publication.started = true;
    for (const operation of publication.operations.filter(o => o.state === 'pending')) operation.error = message(error);
  } finally {
    if (publication.started) for (const operation of publication.operations.filter(o => o.state === 'pending')) {
      operation.state = 'failed'; operation.error ??= publication.superseded ? 'Superseded before this required write could be issued' : 'Write not issued before finalization';
    }
    publication.status = deliveryStatus(publication);
  }
  return publication;
}
