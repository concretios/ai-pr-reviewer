import type { Atom, Inventory, Task } from '../contracts.js';
import { obligations } from '../contracts.js';
import { hash, unique } from '../util.js';

export type CountTask = (task: Task) => Promise<number>;
export const fits = (count: number, ceiling: number): boolean => Math.ceil(count * 1.05) <= ceiling;
export function reviewTask(atoms: Atom[], suffix = ''): Task {
  const id = `review-${hash(atoms.map(a => a.id)).slice(0, 20)}${suffix}`;
  return { kind: 'review', id, lineageId: id, atomIds: atoms.map(a => a.id), evidenceIds: unique(atoms.flatMap(a => a.evidenceIds)) };
}
export function childTask(parent: Task, ids: string[], inventory: Inventory, index: number): Task {
  const common = { id: `${parent.id}.${index}`, lineageId: parent.lineageId };
  return parent.kind === 'review'
    ? { ...common, kind: 'review', atomIds: ids, evidenceIds: unique(inventory.atoms.filter(a => ids.includes(a.id)).flatMap(a => a.evidenceIds)) }
    : { ...common, kind: 'integration', relationIds: ids, evidenceIds: unique(inventory.relations.filter(r => ids.includes(r.id)).flatMap(r => r.evidenceIds)) };
}
export function splitTask(task: Task, inventory: Inventory): Task[] {
  const ids = obligations(task);
  if (ids.length < 2) return [];
  const mid = Math.ceil(ids.length / 2);
  return [childTask(task, ids.slice(0, mid), inventory, 0), childTask(task, ids.slice(mid), inventory, 1)];
}
export async function plan(inventory: Inventory, count: CountTask, ceiling: number): Promise<Task[]> {
  if (!inventory.atoms.length) return [];
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const ordered = [...inventory.atoms].sort((a, b) => a.priority - b.priority || compare(a.path, b.path) || compare(a.side, b.side) || a.start - b.start);
  const whole = reviewTask(ordered);
  whole.evidenceIds = unique([...whole.evidenceIds, ...inventory.relations.flatMap(r => r.evidenceIds)]);
  if (fits(await count(whole), ceiling)) return [whole];
  const tasks: Task[] = [];
  async function pack(atoms: Atom[]): Promise<void> {
    const task = reviewTask(atoms);
    if (fits(await count(task), ceiling)) { tasks.push(task); return; }
    if (atoms.length > 1) {
      // Divide around a nearby file boundary. Full-request counting takes O(batch count)
      // calls rather than one network call per changed range in a large PR.
      const middle = Math.ceil(atoms.length / 2);
      const boundaries = atoms.map((a, i) => i > 0 && a.path !== atoms[i - 1]!.path ? i : 0).filter(Boolean);
      const split = boundaries.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b)[0] ?? middle;
      await pack(atoms.slice(0, split)); await pack(atoms.slice(split)); return;
    }
    const atom = atoms[0]!;
    const originalEvidence = inventory.evidence.get(atom.evidenceIds[0]!)!;
    if (atom.start === atom.end && originalEvidence.start === atom.start && originalEvidence.end === atom.end) {
      tasks.push(task); return; // Counted indivisible input is finalized as unresolved by the runner.
    }
    const middle = Math.floor((atom.start + atom.end) / 2);
    const ranges = atom.start === atom.end ? [[atom.start, atom.end]] : [[atom.start, middle], [middle + 1, atom.end]];
    const children = ranges.map(([start, end]) => {
      const text = atom.text.split('\n').slice(start! - atom.start, end! - atom.start + 1).join('\n');
      const evidence = { ...originalEvidence, id: `e-${hash([originalEvidence.blobId, originalEvidence.path, start, end]).slice(0, 24)}`, start: start!, end: end!, text };
      inventory.evidence.set(evidence.id, evidence);
      return { ...atom, id: ranges.length === 1 ? atom.id : `a-${hash([atom.id, start, end]).slice(0, 24)}`, start: start!, end: end!, text, evidenceIds: [evidence.id] };
    });
    inventory.atoms.splice(inventory.atoms.findIndex(a => a.id === atom.id), 1, ...children);
    for (const relation of inventory.relations.filter(r => r.atomIds.includes(atom.id))) {
      relation.atomIds = relation.atomIds.flatMap(id => id === atom.id ? children.map(a => a.id) : [id]);
      relation.evidenceIds = unique([...relation.evidenceIds.filter(id => !atom.evidenceIds.includes(id)), ...children.flatMap(a => a.evidenceIds)]);
    }
    for (const child of children) await pack([child]);
  }
  await pack(ordered);
  const owner = new Map(tasks.flatMap(t => obligations(t).map(id => [id, t.id] as const)));
  for (const relation of inventory.relations) {
    // Same-batch questions can use an unchanged endpoint, too; include its raw source.
    const owners = unique(relation.atomIds.map(id => owner.get(id)).filter((id): id is string => Boolean(id)));
    const single = owners.length === 1 ? tasks.find(t => t.id === owners[0]) : undefined;
    if (single) {
      const expanded = { ...single, evidenceIds: unique([...single.evidenceIds, ...relation.evidenceIds]) };
      if (fits(await count(expanded), ceiling)) { single.evidenceIds = expanded.evidenceIds; continue; }
    }
    const id = `integration-${relation.id}`;
    tasks.push({ kind: 'integration', id, lineageId: id, relationIds: [relation.id], evidenceIds: relation.evidenceIds });
  }
  return tasks;
}
