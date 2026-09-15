import type { Analysis, Manifest, Operation, Publication, RunOrder, Inventory, Finding } from '../contracts.js';
import type { Settings } from '../config.js';
import { GitHubError, type GitHubAPI } from './client.js';
import { mainResult, deliveryStatus, detailPages, renderFinding, summaryBody, safe, type SummaryState, type SummaryRecord } from '../reporting/render.js';
import { findingId } from '../review/validate.js';
import { hash, message } from '../util.js';
import { prUsageFooter, prUsageBreakdown } from '../reporting/usage.js';
import { z } from 'zod';

export type RemoteComment = { id: number; body: string; user: { id: number }; html_url?: string; commit_id?: string; original_commit_id?: string; pull_request_review_id?: number; path?: string; side?: string; line?: number | null; original_line?: number; subject_type?: string; in_reply_to_id?: number };
const recordSchema = z.object({ order: z.object({ createdAt: z.string(), runId: z.string().regex(/^\d+$/), attempt: z.number().int() }),
  status: z.enum(['complete', 'partial', 'unavailable', 'skipped', 'superseded']), text: z.string().max(10000) });
const stateSchema = z.object({ latest: recordSchema, completed: recordSchema.optional(), current: recordSchema.optional(), version: z.literal(2).optional() });
export function compareOrder(a: RunOrder, b: RunOrder): number | undefined {
  if (a.runId === b.runId) return a.attempt - b.attempt;
  if (!a.createdAt || !b.createdAt) return undefined;
  const time = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (!Number.isFinite(time)) return undefined;
  return time || (BigInt(a.runId) > BigInt(b.runId) ? 1 : -1);
}
export function mergeSummary(previous: SummaryState | undefined, current: SummaryRecord, completedEligible = true): SummaryState {
  if (!previous) return { latest: current, completed: current.status === 'complete' && completedEligible ? current : undefined };
  if (previous.current && (compareOrder(previous.current.order, previous.latest.order) ?? -1) >= 0) previous = { ...previous, latest: previous.current };
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
  authorId: number; fresh: () => Promise<boolean>; notices?: string[]; inventory?: Inventory;
};
export async function publish(options: PublishOptions): Promise<Publication> {
  const { api, manifest, analysis, settings, order, authorId } = options;
  const publication: Publication = { started: false, status: 'not_requested', operations: [], superseded: false };
  const root = `/repos/${manifest.repository}`;
  const commentsPath = `${root}/issues/${manifest.prNumber}/comments`;
  const reviewsPath = `${root}/pulls/${manifest.prNumber}/reviews`;
  const inlinePath = `${root}/pulls/${manifest.prNumber}/comments`;
  const web = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${manifest.repository}`;
  const marker = (id: string) => `<!-- ai-pr-reviewer:v2:${settings.bot_name}:${id} -->`;
  const newOperation = (id: string, required: boolean, findingIds: string[] = []): Operation => {
    const operation: Operation = { id, required, findingIds, state: 'pending', contentHash: '' };
    publication.operations.push(operation); return operation;
  };
  const allIds = analysis.findings.map(findingId);
  const prepare = newOperation('summary-prepare', true, allIds);
  const summary = newOperation('summary', true, allIds);
  const fresh = async () => {
    if (await options.fresh()) return true;
    publication.superseded = true; return false;
  };
  let existing: RemoteComment[] = [];
  const trusted = (items: RemoteComment[], id: string) => items.filter(c => c.user.id === authorId && c.body.startsWith(marker(id) + '\n'));
  async function deliver(operation: Operation, body: string, identity = operation.id, review?: { comments: unknown[] }): Promise<void> {
    operation.contentHash = hash(body);
    const collection = review ? reviewsPath : commentsPath;
    const items = review ? await api.list<RemoteComment>(collection) : existing;
    const candidates = trusted(items, identity);
    const matches = (c: RemoteComment) => hash(c.body) === operation.contentHash && (!review || c.commit_id === manifest.headSha);
    const identical = candidates.find(matches);
    if (identical) { operation.state = 'confirmed'; operation.remoteId = identical.id; return; }
    const previous = !review ? candidates[0] : undefined;
    try {
      const result = await api.write<RemoteComment>(previous ? 'PATCH' : 'POST', previous ? `${root}/issues/comments/${previous.id}` : collection,
        review ? { body, event: 'COMMENT', commit_id: manifest.headSha, comments: review.comments } : { body });
      if (result.user.id !== authorId || !matches(result)) throw new GitHubError('Accepted response identity/content mismatch', true);
      operation.state = 'confirmed'; operation.remoteId = result.id;
      if (!review) existing = [...existing.filter(c => c.id !== result.id), result];
    } catch (error) {
      operation.error = message(error);
      if (error instanceof GitHubError && !error.uncertain) { operation.state = 'failed'; return; }
      try {
        const reconciled = await api.list<RemoteComment>(collection);
        const found = trusted(reconciled, identity).find(matches);
        if (found) { operation.state = 'confirmed'; operation.remoteId = found.id; operation.error = undefined; if (!review) existing = reconciled; return; }
      } catch { /* Never blindly recreate an ambiguous write. */ }
      operation.state = 'unconfirmed';
    }
  }
  type Target = { finding: Finding; path: string; side?: string; line?: number; subject_type: 'file' | 'line'; operation: Operation; body: string };
  const targets: Target[] = [];
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  for (const finding of analysis.findings) {
    if (!settings.post_inline_comments || rank[finding.severity] > rank[settings.comment_severity_threshold]) continue;
    let anchor: Omit<Target, 'finding' | 'operation' | 'body'> | undefined;
    if (finding.anchor) anchor = { ...finding.anchor, subject_type: 'line' };
    else if (options.inventory) {
      const atoms = options.inventory.atoms.filter(a => finding.introducedByAtomIds.includes(a.id));
      const paths = new Set(atoms.map(a => a.side === 'LEFT' ? a.oldPath : a.path));
      if (atoms.length === finding.introducedByAtomIds.length && paths.size === 1) {
        const path = [...paths][0]!;
        // A deleted or renamed-away path is not a valid current file target.
        if (options.inventory.atoms.some(a => a.path === path && a.side === 'RIGHT') || manifest.evidenceBlobs[`${manifest.headSha}:${path}`]?.path === path) anchor = { path, subject_type: 'file' };
      }
    }
    if (!anchor) continue;
    const id = `finding-${manifest.headSha}-${findingId(finding)}`;
    const body = `${marker(id)}\n${renderFinding(finding, options.inventory ? { repositoryUrl: web, evidence: options.inventory.evidence } : undefined)}`;
    const operation = newOperation(id, false, [findingId(finding)]);
    operation.contentHash = hash(body);
    if (Buffer.byteLength(body) >= 50000) { operation.state = 'failed'; operation.error = 'Inline comment exceeds safe size; full finding retained in required fallback'; }
    targets.push({ finding, ...anchor, operation, body });
  }
  const pages = detailPages(analysis.findings);
  let details: Array<{ operation: Operation; body: string }> = [];
  try {
    if (!await fresh()) return publication;
    existing = await api.list<RemoteComment>(commentsPath);
    if (!await fresh()) return publication;
    publication.started = true;
    // Per-finding reconciliation is independent of batch membership and order.
    let remote: RemoteComment[] = []; let reviews: RemoteComment[] = [];
    let inlineReadable = true;
    if (targets.length) {
      try { reviews = await api.list<RemoteComment>(reviewsPath); remote = await api.list<RemoteComment>(inlinePath); }
      catch (error) { inlineReadable = false; for (const t of targets) { t.operation.state = 'unconfirmed'; t.operation.error = message(error); } }
    }
    const legacyReviews = new Set(reviews.filter(r => r.user.id === authorId && r.commit_id === manifest.headSha
      && r.body.startsWith(`<!-- ai-pr-reviewer:v2:${settings.bot_name}:inline-${manifest.headSha}-`)).map(r => r.id));
    const matchesTarget = (c: RemoteComment, t: Target) => c.user.id === authorId && !c.in_reply_to_id
      && (c.original_commit_id ?? c.commit_id) === manifest.headSha && c.path === t.path
      && (t.subject_type === 'file' ? c.subject_type === 'file' : c.subject_type !== 'file' && c.side === t.side && (c.original_line ?? c.line) === t.line)
      && (c.body.startsWith(marker(t.operation.id) + '\n') || legacyReviews.has(c.pull_request_review_id!) && c.body.includes(`Concern ID: ${findingId(t.finding)}\n`));
    for (const t of targets) {
      t.operation.contentHash = hash(t.body);
      const match = remote.find(c => matchesTarget(c, t));
      if (match) { t.operation.state = 'confirmed'; t.operation.remoteId = match.id; t.operation.contentHash = hash(match.body); }
    }
    const previous = readSummary(trusted(existing, 'summary')[0]);
    // Backfill old minimum-permission records when the consumer now grants actions:read.
    const dates = new Map<string, string>();
    for (const record of [previous?.latest, previous?.completed, previous?.current]) {
      if (!record || record.order.createdAt) continue;
      if (!dates.has(record.order.runId)) {
        try {
          const metadata = await api.get<{ created_at: string }>(`${root}/actions/runs/${record.order.runId}`);
          dates.set(record.order.runId, Number.isFinite(Date.parse(metadata.created_at)) ? metadata.created_at : '');
        } catch { dates.set(record.order.runId, ''); }
      }
      record.order.createdAt = dates.get(record.order.runId)!;
    }
    // Bound legacy verbose metadata. Full findings never live in hidden summary state.
    const compact = (r: SummaryRecord | undefined) => r ? { ...r, text: r.text.slice(0, 1400) } : undefined;
    const prior = previous ? { latest: compact(previous.latest)!, completed: compact(previous.completed), current: compact(previous.current) } : undefined;
    const runLink = `[Workflow and report](${web}/actions/runs/${order.runId})`;
    const current: SummaryRecord = { order, status: analysis.status, text: `${mainResult(analysis, manifest.headSha)}\n\n${runLink}\n\n${prUsageFooter(analysis, manifest.model)}` };
    const merged = (eligible: boolean) => mergeSummary(prior, current, eligible && details.every(d => d.operation.state === 'confirmed'));
    const render = (fallback: string, eligible = false) => {
      const incomplete = targets.some(t => t.operation.state !== 'confirmed');
      const linked = targets.filter(t => t.operation.remoteId);
      const links = linked.slice(0, 20).map(t => `[${safe(t.finding.title.slice(0, 80))}](${web}/pull/${manifest.prNumber}#discussion_r${t.operation.remoteId})`);
      const unresolved = [...Object.values(analysis.atoms), ...Object.values(analysis.relations)].filter(v => v.status !== 'reviewed');
      const reasons = [...new Set(unresolved.map(v => v.reason))].slice(0, 12).map(reason => `- ${safe(reason.slice(0, 350))}`).join('\n');
      return `${marker('summary')}\n${summaryBody(merged(eligible))}\n\n<details>\n<summary>All findings for ${manifest.headSha.slice(0, 7)} (${analysis.findings.length})</summary>\n\n${fallback || 'No actionable concerns reported.'}\n\n</details>\n\n<details>\n<summary>Coverage limitations and delivery status for this attempt</summary>\n\n${incomplete ? 'Inline delivery is incomplete. All accepted concerns are retained in the main comment or required overflow pages.' : 'Requested line/file comments confirmed.'}\n\n${links.join('\n\n')}\n\n${reasons}\n\n${(options.notices ?? []).slice(0, 8).map(n => safe(n.slice(0, 250))).join('\n')}\n\n</details>\n\n<details>\n<summary>Usage breakdown</summary>\n\n${prUsageBreakdown(analysis, manifest.model)}\n\n</details>`;
    };
    let fallback = pages.map(p => p.text).join('');
    // Reserve space for individual discussion URLs added during finalization.
    if (Buffer.byteLength(render(fallback)) >= 35000) {
      details = pages.map((page, i) => {
        const id = `detail-${order.runId}-${order.attempt}-${manifest.headSha}-${i + 1}`;
        const operation = newOperation(id, true, page.findingIds);
        return { operation, body: `${marker(id)}\n## 🩺 Dr. Concret.io: findings ${i + 1}/${pages.length}\n\nReviewed commit: ${manifest.headSha}\n\n${page.text}` };
      });
      for (const d of details) { if (!await fresh()) return publication; await deliver(d.operation, d.body); }
      fallback = details.map((d, i) => d.operation.remoteId ? `[Findings page ${i + 1}](${web}/pull/${manifest.prNumber}#issuecomment-${d.operation.remoteId})` : `Findings page ${i + 1}: ${d.operation.state}; see the report artifact.`).join('\n\n');
    }
    const initialBody = render(fallback);
    if (Buffer.byteLength(initialBody) >= 50000) throw new Error('Required main comment exceeds safe size');
    if (!await fresh()) return publication;
    await deliver(prepare, initialBody, 'summary');
    // Publishing inline feedback requires a confirmed durable fallback first.
    if (prepare.state !== 'confirmed') return publication;
    const mainLink = `${web}/pull/${manifest.prNumber}#issuecomment-${prepare.remoteId}`;
    const missingLines = targets.filter(t => t.subject_type === 'line' && t.operation.state === 'pending');
    if (inlineReadable) for (let offset = 0; offset < missingLines.length; offset += 50) {
      const batch = missingLines.slice(offset, offset + 50);
      if (!await fresh()) return publication;
      const id = `inline-${manifest.headSha}-${hash(batch.map(t => t.operation.id).sort()).slice(0, 24)}`;
      const batchOp: Operation = { id, required: false, findingIds: [], state: 'pending', contentHash: '' };
      const body = `${marker(id)}\n🩺 Dr. Concret.io: [main diagnosis](${mainLink}).\n\nPayload: ${hash(batch.map(t => t.body))}`;
      try {
        await deliver(batchOp, body, id, { comments: batch.map(t => ({ path: t.path, side: t.side, line: t.line, body: t.body })) });
        // Review acceptance is atomic, but individual URLs require reading its comments.
        if (batchOp.state === 'confirmed') {
          try { remote = await api.list<RemoteComment>(inlinePath); } catch { /* Review confirmation remains valid. */ }
        }
        for (const t of batch) {
          t.operation.state = batchOp.state; t.operation.error = batchOp.error;
          t.operation.remoteId = remote.find(c => matchesTarget(c, t))?.id;
        }
      } catch (error) { for (const t of batch) { t.operation.state = 'failed'; t.operation.error = message(error); } }
    }
    if (inlineReadable) for (const t of targets.filter(t => t.subject_type === 'file' && t.operation.state === 'pending')) {
      if (!await fresh()) return publication;
      try {
        const result = await api.write<RemoteComment>('POST', inlinePath, { body: t.body, commit_id: manifest.headSha, path: t.path, subject_type: 'file' });
        if (!matchesTarget(result, t)) throw new GitHubError('File comment response mismatch', true);
        t.operation.state = 'confirmed'; t.operation.remoteId = result.id;
      } catch (error) {
        t.operation.error = message(error);
        t.operation.state = error instanceof GitHubError && !error.uncertain ? 'failed' : 'unconfirmed';
        if (t.operation.state === 'unconfirmed') {
          try { const match = (await api.list<RemoteComment>(inlinePath)).find(c => matchesTarget(c, t));
            if (match) { t.operation.state = 'confirmed'; t.operation.remoteId = match.id; t.operation.error = undefined; }
          } catch { /* One bounded reconciliation only. */ }
        }
      }
    }
    if (!await fresh()) return publication;
    const body = render(fallback, true);
    if (Buffer.byteLength(body) >= 50000) throw new Error('Final main comment exceeds safe size');
    await deliver(summary, body, 'summary');
  } catch (error) {
    publication.started = true;
    for (const op of publication.operations.filter(o => o.state === 'pending')) op.error = message(error);
  } finally {
    if (publication.started) for (const op of publication.operations.filter(o => o.state === 'pending')) {
      op.state = 'failed'; op.error ??= publication.superseded ? 'Superseded before publication finished' : 'Write not issued before finalization';
    }
    publication.status = deliveryStatus(publication);
  }
  return publication;
}
