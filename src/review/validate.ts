import type { Inventory, Task, Finding, Diagnostic } from '../contracts.js';
import { obligations } from '../contracts.js';
import { CompactResponseSchema, TaskResponseSchema, type TaskResponse } from './schema.js';
import type { Binding, RepairFeedback } from '../providers/projection.js';

export class ResponseError extends Error {
  constructor(readonly feedback: RepairFeedback) { super(`Invalid response: ${feedback.code}`); }
}
export function decodeCompact(text: string, task: Task, binding: Binding): TaskResponse {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ResponseError({ code: 'json' }); }
  if (typeof value !== 'object' || !value || !('kind' in value) || !['result', 'context_request'].includes(String(value.kind))) throw new ResponseError({ code: 'kind' });
  const parsed = CompactResponseSchema.safeParse(value);
  if (!parsed.success) throw new ResponseError({ code: 'shape' });
  const response = parsed.data;
  if (response.requestId !== binding.requestId || task.id !== binding.taskId) throw new ResponseError({ code: 'identity' });
  if (response.kind === 'context_request') return { kind: response.kind, taskId: task.id, requests: response.requests };
  const actual = [...response.reviewedIds, ...response.unresolved.map(i => i.id)];
  if (actual.length !== binding.expectedIds.length || unique(actual).length !== actual.length || actual.some(id => !binding.expectedIds.includes(id))) {
    throw new ResponseError({ code: 'completion', expectedIds: binding.expectedIds });
  }
  const translate = (map: Map<string, string>, id: string): string => {
    const stable = map.get(id); if (!stable) throw new ResponseError({ code: 'reference' }); return stable;
  };
  const ids = task.kind === 'review' ? binding.atoms : binding.relations;
  const findings = response.findings.map(f => ({ ...f, introducedByAtomIds: f.introducedByAtomIds.map(id => translate(binding.atoms, id)),
    evidenceIds: f.evidenceIds.map(id => translate(binding.evidence, id)) }));
  return decode(JSON.stringify({ kind: 'result', taskId: task.id,
    items: [...response.reviewedIds.map(id => ({ id: translate(ids, id), status: 'reviewed', reason: 'Completion metadata: model marked this obligation reviewed.' })),
      ...response.unresolved.map(item => ({ ...item, id: translate(ids, item.id), status: 'unresolved' }))], findings }), task);
}
import { hash, unique } from '../util.js';

export function decode(text: string, task: Task): TaskResponse {
  const response = TaskResponseSchema.parse(JSON.parse(text));
  if (response.taskId !== task.id) throw new Error('Response taskId does not match');
  if (response.kind === 'result') {
    const expected = obligations(task); const actual = response.items.map(i => i.id);
    if (actual.length !== expected.length || unique(actual).length !== actual.length || actual.some(id => !expected.includes(id))) {
      throw new Error('Expected exactly the task result IDs, with no missing, duplicate, or foreign IDs');
    }
  }
  return response;
}
export const findingId = (finding: Finding): string => hash({ ...finding,
  evidenceIds: [...finding.evidenceIds].sort(), introducedByAtomIds: [...finding.introducedByAtomIds].sort() }).slice(0, 24);
export function validateFindings(findings: Finding[], task: Task, inventory: Inventory): { accepted: Finding[]; diagnostics: Diagnostic[] } {
  const accepted: Finding[] = []; const diagnostics: Diagnostic[] = [];
  const scope = task.kind === 'review' ? task.atomIds : inventory.relations.filter(r => task.relationIds.includes(r.id)).flatMap(r => r.atomIds);
  for (const finding of findings) {
    const introduced = inventory.atoms.filter(a => finding.introducedByAtomIds.includes(a.id));
    const evidence = finding.evidenceIds.map(id => inventory.evidence.get(id));
    const valid = finding.introducedByAtomIds.every(id => scope.includes(id))
      && finding.evidenceIds.every(id => task.evidenceIds.includes(id) && inventory.evidence.has(id))
      && introduced.every(a => evidence.some(e => e && e.path === (a.side === 'LEFT' ? a.oldPath : a.path) && e.side === a.side && e.start <= a.end && e.end >= a.start))
      && (!finding.anchor || introduced.some(a => finding.anchor!.path === (a.side === 'LEFT' ? a.oldPath : a.path) && a.side === finding.anchor!.side && finding.anchor!.line >= a.start && finding.anchor!.line <= a.end));
    if (!valid) diagnostics.push({ taskId: task.id, disposition: 'rejected_invalid_evidence', reason: `Rejected ${findingId(finding)}: fabricated/unsupplied evidence, foreign change, or invalid diff anchor` });
    else accepted.push(finding);
  }
  return { accepted, diagnostics };
}
