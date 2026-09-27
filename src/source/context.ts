import { posix } from 'node:path';
import type { Inventory, LookupRequest, LookupResult, Relation } from '../contracts.js';
import { hash, unique } from '../util.js';
import { Snapshot } from './snapshot.js';

/** One-hop literal imports and adjacent tests only. No graph traversal. */
export async function addRelationships(snapshot: Snapshot, inventory: Inventory): Promise<void> {
  const paths = unique(inventory.atoms.map(a => a.path)).sort();
  const tree = await snapshot.tree(snapshot.identity.headSha);
  for (const path of paths) {
    const atoms = inventory.atoms.filter(a => a.path === path);
    const snippets = unique(atoms.flatMap(a => a.evidenceIds)).map(id => inventory.evidence.get(id)!.text).join('\n');
    const targets = new Set<string>();
    for (const match of snippets.matchAll(/(?:from\s*|require\(\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      const stem = posix.normalize(posix.join(posix.dirname(path), match[1]!));
      const candidate = ['', '.ts', '.tsx', '.js', '.jsx', '.py', '/index.ts', '/index.js'].map(ext => stem + ext).find(p => tree.has(p));
      if (candidate) targets.add(candidate);
    }
    const stem = path.replace(/\.[^/.]+$/, '');
    for (const candidate of [`${stem}.test.ts`, `${stem}.spec.ts`, `${stem}.test.js`, `${posix.dirname(path)}/test_${posix.basename(stem)}.py`]) {
      if (tree.has(candidate)) targets.add(candidate);
    }
    const candidates = [...targets].sort().slice(0, 4).filter(target => target !== path);
    const relations = await Promise.all(candidates.map(async target => {
      const endpoint = await snapshot.evidence(target, 'RIGHT', 1, 200);
      if (!endpoint) return undefined;
      inventory.evidence.set(endpoint.id, endpoint);
      const others = inventory.atoms.filter(a => a.path === target);
      const relation: Relation = { id: `r-${hash([path, target]).slice(0, 24)}`,
        question: `Do the changes in ${path} remain consistent with the directly referenced definition or associated test in ${target}? Request exact context if these bounded endpoints do not establish the contract.`,
        atomIds: unique([...atoms, ...others].map(a => a.id)), evidenceIds: unique([...atoms.flatMap(a => a.evidenceIds), ...others.flatMap(a => a.evidenceIds), endpoint.id]) };
      return relation;
    }));
    for (const relation of relations) if (relation) inventory.relations.push(relation);
  }
}

export async function lookup(snapshot: Snapshot, request: LookupRequest, signal = snapshot.signal): Promise<LookupResult> {
  signal.throwIfAborted();
  if (request.kind === 'range') {
    if (request.end < request.start || request.end - request.start >= 200) return { request, evidence: [], limited: true, reason: 'Range must contain 1 to 200 lines' };
    const evidence = await snapshot.evidence(request.path, request.side, request.start, request.end);
    signal.throwIfAborted();
    return { request, evidence: evidence ? [evidence] : [], limited: !evidence || evidence.end < request.end, reason: evidence ? undefined : 'Tracked regular text range not found' };
  }
  const evidence = []; let scanned = 0; let limited = false;
  const revision = snapshot.revision(request.side);
  // Literal search uses pinned Git objects, not a shell or regular expression provided by the model.
  for (const path of [...(await snapshot.tree(revision)).keys()].sort()) {
    signal.throwIfAborted();
    if (++scanned > 2000) { limited = true; break; }
    const source = await snapshot.read(revision, path);
    signal.throwIfAborted();
    if (!source) continue;
    const lines = source.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.includes(request.literal)) continue;
      if (evidence.length >= 4) { limited = true; break; }
      const item = await snapshot.evidence(path, request.side, Math.max(1, i - 9), i + 11);
      signal.throwIfAborted();
      if (item) evidence.push(item);
    }
    if (limited) break;
  }
  return { request, evidence, limited, reason: limited ? 'Search result limit: 4 ranges or 2,000 files' : evidence.length ? undefined : 'No literal references found' };
}
