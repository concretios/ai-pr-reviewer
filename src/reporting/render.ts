import type { Analysis, FinalizedRun, Publication, ReviewStatus, RunOrder } from '../contracts.js';
import type { Finding } from '../review/schema.js';
import { findingId } from '../review/validate.js';
export const safe = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '&#64;');
export function renderFinding(finding: Finding): string {
  return `### ${finding.severity.toUpperCase()}: ${safe(finding.title)}\n\nConcern ID: ${findingId(finding)}\n\n**Changed behavior:** ${safe(finding.changedBehavior)}\n\n**Trigger:** ${safe(finding.trigger)}\n\n**Consequence:** ${safe(finding.consequence)}\n\nIntroduced by: ${finding.introducedByAtomIds.join(', ')}\n\nEvidence: ${finding.evidenceIds.join(', ')}\n`;
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
export function analysisText(analysis: Analysis, sha: string): string {
  return `Analysis: **${analysis.analysisStatus}**${analysis.superseded ? ' (live attempt superseded)' : ''}\n\nCaptured head: ${sha}\n\nCoverage: ${coverage(analysis)}\n\nModel-reported concerns: ${analysis.findings.length}. These are advisory concerns, not independently verified defects.\n\n${analysis.analysisStatus === 'complete' && !analysis.findings.length ? 'No actionable concerns reported in the declared scope.' : analysis.analysisStatus !== 'complete' ? 'Review coverage is incomplete. Unreviewed or unresolved code may contain issues.' : ''}\n\nGeneration attempts: ${analysis.usage.attempts}. Admission tokens charged: ${analysis.usage.charged}; unknown-usage attempts: ${analysis.usage.unknown}. This ledger is not an invoice guarantee.\n`;
}
export type SummaryRecord = { order: RunOrder; status: ReviewStatus; text: string };
export type SummaryState = { latest: SummaryRecord; completed?: SummaryRecord; current?: SummaryRecord };
export function summaryBody(state: SummaryState): string {
  return `<!-- state:${Buffer.from(JSON.stringify(state)).toString('base64')} -->\n## AI PR review\n\n### Last completed result\n\n${state.completed?.text ?? 'No completed result recorded.'}\n\n### Latest attempt\n\n${state.latest.text}${state.current ? `\n\n### This attempt (older or ordering unconfirmed)\n\n${state.current.text}` : ''}`;
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
  return `# AI PR reviewer report\n\n${analysisText(run.analysis, run.manifest?.headSha ?? 'not captured')}\nPublication: **${run.publication.status}**\n\n${[run.configurationError, run.internalError, ...run.notices].filter(Boolean).map(s => safe(s!)).join('\n\n')}\n\n## Concerns\n\n${run.analysis.findings.map(renderFinding).join('\n')}\n## Unresolved scope\n\n${unresolved.map(([id, item]) => `- ${id}: ${safe(item.reason)}`).join('\n')}\n\n## Source limitations\n\n${run.omissions.map(o => `- ${safe(o.path)}: ${safe(o.reason)}`).join('\n')}\n\n## Delivery operations\n\n${run.publication.operations.map(o => `- ${o.id} (${o.required ? 'required' : 'inline'}): ${o.state}; concerns: ${o.findingIds.join(', ') || 'summary'}${o.error ? `; ${safe(o.error)}` : ''}`).join('\n')}\n`;
}
