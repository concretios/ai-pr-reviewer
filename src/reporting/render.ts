import type { Analysis, Evidence, FinalizedRun, Publication, ReviewStatus, RunOrder } from '../contracts.js';
import type { Finding } from '../review/schema.js';
import { findingId } from '../review/validate.js';
import { summarizeUsage, usageText } from './usage.js';
export const safe = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '&#64;');
export function renderFinding(finding: Finding, source?: { repositoryUrl: string; evidence: Map<string, Evidence> }): string {
  const links = source ? finding.evidenceIds.map(id => {
    const e = source.evidence.get(id);
    return e ? `[${safe(e.path)}:${e.start}-${e.end}](${source.repositoryUrl}/blob/${e.revision}/${e.path.split('/').map(encodeURIComponent).join('/')}#L${e.start}-L${e.end})` : id;
  }).join('\n\n') : `Introduced by: ${finding.introducedByAtomIds.join(', ')}\n\nEvidence: ${finding.evidenceIds.join(', ')}`;
  return `### ${finding.severity.toUpperCase()}: ${safe(finding.title)}\n\n${safe(finding.changedBehavior)} ${safe(finding.trigger)} ${safe(finding.consequence)}\n\n<details>\n<summary>Evidence</summary>\n\n${links}\n\n</details>\n`;
}
export function diagnosis(analysis: Analysis): string {
  if (analysis.analysisStatus === 'unavailable') return 'Review unavailable. Manual review needed.';
  if (analysis.analysisStatus === 'skipped') return 'No eligible changes to examine.';
  const concerns = analysis.findings.length ? 'Concerns reported.' : 'No actionable concerns reported in the examined scope.';
  return concerns + (analysis.analysisStatus !== 'complete' ? ' Check-up incomplete.' : '');
}
export function mainResult(analysis: Analysis, sha: string, model: string): string {
  const usage = summarizeUsage(analysis, model);
  const counts = (['critical', 'high', 'medium', 'low'] as const).map(level => {
    const n = analysis.findings.filter(f => f.severity === level).length; return n ? `${n} ${level}` : '';
  }).filter(Boolean).join(' · ') || '0 concerns';
  const cost = usage.estimatedCostUsd === null ? 'cost unavailable' : `estimated $${usage.estimatedCostUsd.toFixed(4)} USD before cache discounts`;
  const incomplete = usage.pricedAttempts < usage.generationAttempts ? ` (incomplete: ${usage.pricedAttempts}/${usage.generationAttempts} attempts priced)` : '';
  return `**Diagnosis: ${diagnosis(analysis)}**\n\n${counts}\n\nReviewed commit: ${sha}\n\nCoverage: ${coverage(analysis)}\n\nThis run: ${usage.totalTokens === null ? 'unknown' : usage.totalTokens.toLocaleString('en-US')} known tokens · ${cost}${incomplete}\n\nFindings are advisory model-reported concerns.`;
}
export function detailPages(findings: Finding[], maxBytes = 47000): Array<{ text: string; findingIds: string[] }> {
  const pages: Array<{ text: string; findingIds: string[] }> = [];
  let text = ''; let ids: string[] = []; let bytes = 0;
  // Split even a worst-case Unicode concern without losing text. Never split a UTF-8 character.
  for (const finding of findings) {
    const id = findingId(finding);
    for (const char of renderFinding(finding) + '\n') {
      const size = Buffer.byteLength(char, 'utf8');
      if (bytes + size > maxBytes) { pages.push({ text, findingIds: ids }); text = ''; ids = []; bytes = 0; }
      if (!ids.includes(id)) ids.push(id);
      text += char; bytes += size;
    }
  }
  if (text) pages.push({ text, findingIds: ids });
  return pages;
}
export function coverage(analysis: Analysis): string {
  const atoms = Object.values(analysis.atoms); const relations = Object.values(analysis.relations);
  return `${atoms.filter(a => a.status === 'reviewed').length}/${atoms.length} changed ranges; ${relations.filter(r => r.status === 'reviewed').length}/${relations.length} cross-file questions`;
}
export function analysisText(analysis: Analysis, sha: string, model?: string): string {
  return `Analysis: **${analysis.analysisStatus}**${analysis.superseded ? ' (live attempt superseded)' : ''}\n\nCaptured head: ${sha}\n\nCoverage: ${coverage(analysis)}\n\nModel-reported concerns: ${analysis.findings.length}. These are advisory concerns, not independently verified defects.\n\n${analysis.analysisStatus === 'complete' && !analysis.findings.length ? 'No actionable concerns reported in the declared scope.' : analysis.analysisStatus !== 'complete' ? 'Review coverage is incomplete. Unreviewed or unresolved code may contain issues.' : ''}\n\n${usageText(analysis, model)}\n`;
}
export type SummaryRecord = { order: RunOrder; status: ReviewStatus; text: string };
export type SummaryState = { version?: 2; latest: SummaryRecord; completed?: SummaryRecord; current?: SummaryRecord };
export function summaryBody(state: SummaryState): string {
  const unordered = state.current && (!state.current.order.createdAt || !state.latest.order.createdAt) && state.current.order.runId !== state.latest.order.runId;
  const primary = unordered ? state.current! : state.latest;
  const key = (r: SummaryRecord) => `${r.order.runId}/${r.order.attempt}`;
  const seen = new Set([key(primary)]);
  const history = [state.current, state.latest, state.completed].filter((r): r is SummaryRecord => {
    if (!r || seen.has(key(r))) return false; seen.add(key(r)); return true;
  });
  return `<!-- state:${Buffer.from(JSON.stringify({ ...state, version: 2 })).toString('base64')} -->\n## 🩺 Dr. Concret.io\n\n${unordered ? '**This attempt. Relative run ordering is unconfirmed.**\n\n' : ''}${primary.text}${history.length ? `\n\n<details>\n<summary>Previous results and other attempts</summary>\n\n${history.map(r => `Run ${r.order.runId}, attempt ${r.order.attempt} (${r.status})\n\n${r.text}`).join('\n\n')}\n\n</details>` : ''}`;
}
export function deliveryStatus(publication: Publication): Publication['status'] {
  if (!publication.started) return 'not_requested';
  const required = publication.operations.filter(o => o.required);
  if (required.some(o => o.state === 'unconfirmed')) return 'uncertain';
  if (required.some(o => o.state !== 'confirmed')) return required.some(o => o.state === 'confirmed') ? 'partial' : 'failed';
  return publication.operations.some(o => o.state !== 'confirmed') ? 'partial' : 'published';
}
export function actionExitCode(run: FinalizedRun): 0 | 1 {
  return run.configurationError || run.internalError || run.analysis.status === 'unavailable'
    || (run.publication.started && run.publication.operations.some(o => o.required && o.state !== 'confirmed')) ? 1 : 0;
}
export function renderReport(run: FinalizedRun): string {
  const unresolved = [...Object.entries(run.analysis.atoms), ...Object.entries(run.analysis.relations)].filter(([, item]) => item.status !== 'reviewed');
  return `# AI PR reviewer report\n\n${analysisText(run.analysis, run.manifest?.headSha ?? 'not captured', run.manifest?.model)}\nPublication: **${run.publication.status}**\n\n${[run.configurationError, run.internalError, ...run.notices].filter(Boolean).map(s => safe(s!)).join('\n\n')}\n\n## Concerns\n\n${run.analysis.findings.map(f => renderFinding(f)).join('\n')}\n## Unresolved scope\n\n${unresolved.map(([id, item]) => `- ${id}: ${safe(item.reason)}`).join('\n')}\n\n## Source limitations\n\n${run.omissions.map(o => `- ${safe(o.path)}: ${safe(o.reason)}`).join('\n')}\n\n## Delivery operations\n\n${run.publication.operations.map(o => `- ${o.id} (${o.required ? 'required' : 'inline'}): ${o.state}; concerns: ${o.findingIds.join(', ') || 'summary'}${o.error ? `; ${safe(o.error)}` : ''}`).join('\n')}\n`;
}
