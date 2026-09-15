import type { Atom, Evidence, Inventory, LookupResult, Task } from '../contracts.js';
import { obligations } from '../contracts.js';
import { hash } from '../util.js';

export const protocolVersion = 'compact-v2';
export type RepairFeedback = { code: 'json' | 'shape' | 'kind' | 'identity' | 'completion' | 'reference'; expectedIds?: string[] };
export type Binding = { requestId: string; taskId: string; expectedIds: string[];
  atoms: Map<string, string>; evidence: Map<string, string>; relations: Map<string, string> };
export type SourceBlock = Omit<Evidence, 'id'> & { id: string };
type Reference = { id: string; block: string; start: number; end: number };

/** Lossless with respect to the supplied evidence views, not the original file bytes. */
export function sourceBlocks(evidence: Evidence[]): { blocks: SourceBlock[]; references: Reference[] } {
  const groups = new Map<string, Evidence[]>();
  for (const e of evidence) {
    const key = JSON.stringify([e.path, e.revision, e.blobId, e.side]);
    groups.set(key, [...groups.get(key) ?? [], e]);
  }
  const blocks: SourceBlock[] = []; const references: Reference[] = [];
  const add = (items: Evidence[], start: number, end: number, text: string) => {
    const first = items[0]!; const id = `s${blocks.length}`;
    blocks.push({ id, path: first.path, revision: first.revision, blobId: first.blobId, side: first.side, start, end, text });
    for (const e of items) references.push({ id: e.id, block: id, start: e.start, end: e.end });
  };
  for (const items of groups.values()) {
    items.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
    const lines = new Map<number, string>(); let conflict = false;
    for (const e of items) {
      const parts = e.text.split('\n');
      if (parts.length !== e.end - e.start + 1) conflict = true;
      parts.forEach((text, i) => {
        const line = e.start + i;
        if (lines.has(line) && lines.get(line) !== text) conflict = true;
        lines.set(line, text);
      });
    }
    // Do not invent a combined view when any original interval is ambiguous.
    if (conflict) { for (const e of items) add([e], e.start, e.end, e.text); continue; }
    let segment: Evidence[] = []; let start = 0; let end = 0;
    const flush = () => { if (segment.length) add(segment, start, end, Array.from({ length: end - start + 1 }, (_, i) => lines.get(start + i)!).join('\n')); };
    for (const e of items) {
      if (!segment.length || e.start > end + 1) { flush(); segment = []; start = e.start; end = e.end; }
      segment.push(e); end = Math.max(end, e.end);
    }
    flush();
  }
  return { blocks, references };
}

export function project(task: Task, inventory: Inventory, lookups: LookupResult[] = []) {
  const relations = inventory.relations.filter(r => task.kind === 'integration' ? task.relationIds.includes(r.id) : r.atomIds.every(id => task.atomIds.includes(id)));
  const atoms = inventory.atoms.filter(a => task.kind === 'review' ? task.atomIds.includes(a.id) : relations.some(r => r.atomIds.includes(a.id)));
  const evidence = [...new Set(task.evidenceIds)].sort().map(id => {
    const e = inventory.evidence.get(id); if (!e) throw new Error('Missing supplied evidence'); return e;
  });
  const aliases = <T extends { id: string }>(items: T[], prefix: string) => new Map(items.map(i => i.id).sort().map((id, index) => [id, `${prefix}${index}`]));
  const atomIds = aliases(atoms, 'a'); const evidenceIds = aliases(evidence, 'e'); const relationIds = aliases(relations, 'r');
  const reference = (map: Map<string, string>, id: string): string => { const value = map.get(id); if (value === undefined) throw new Error('Reference outside request'); return value; };
  const views = sourceBlocks(evidence);
  const path = (a: Atom) => a.side === 'LEFT' ? a.oldPath : a.path;
  const wireAtoms = atoms.map(a => {
    const recoverable = views.blocks.some(b => b.path === path(a) && b.side === a.side && a.evidenceIds.some(id => views.references.some(r => r.id === id && r.block === b.id)) && b.start <= a.start && b.end >= a.end
      && b.text.split('\n').slice(a.start - b.start, a.end - b.start + 1).join('\n') === a.text);
    return { id: reference(atomIds, a.id), path: path(a), side: a.side, start: a.start, end: a.end,
      evidenceIds: a.evidenceIds.filter(id => evidenceIds.has(id)).map(id => reference(evidenceIds, id)), ...recoverable ? {} : { text: a.text } };
  });
  const payload = { kind: task.kind, expectedIds: obligations(task).map(id => reference(task.kind === 'review' ? atomIds : relationIds, id)),
    atoms: wireAtoms, relations: relations.map(r => ({ id: reference(relationIds, r.id), question: r.question,
      atomIds: r.atomIds.map(id => reference(atomIds, id)), evidenceIds: r.evidenceIds.filter(id => evidenceIds.has(id)).map(id => reference(evidenceIds, id)) })),
    sourceBlocks: views.blocks, evidence: views.references.map(e => ({ ...e, id: reference(evidenceIds, e.id) })),
    lookups: lookups.map(l => ({ request: l.request, limited: l.limited, reason: l.reason,
      evidenceIds: l.evidence.map(e => reference(evidenceIds, e.id)) })) };
  const reverse = (map: Map<string, string>) => new Map([...map].map(([id, alias]) => [alias, id]));
  const binding: Binding = { taskId: task.id, requestId: '', expectedIds: payload.expectedIds,
    atoms: reverse(atomIds), evidence: reverse(evidenceIds), relations: reverse(relationIds) };
  // Bind stable identities too: equal short aliases from another task are not interchangeable.
  const identity = hash([task, payload, [...binding.atoms], [...binding.evidence], [...binding.relations]]);
  return { payload, binding, identity };
}
