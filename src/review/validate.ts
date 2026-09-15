import type { Inventory, Task, Finding, Diagnostic } from '../contracts.js';
import { obligations } from '../contracts.js';
import { TaskResponseSchema, type TaskResponse } from './schema.js';
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
