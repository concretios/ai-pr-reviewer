import { hash, UnsupportedSnapshot } from '../util.js';
import type { Atom, Inventory, Side } from '../contracts.js';
import { Snapshot, sourceLines } from './snapshot.js';

export type Change = { status: string; oldPath: string; path: string };
export function parseNames(raw: string): Change[] {
  const fields = raw.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++]!;
    const oldPath = fields[i++]!;
    const path = /^[RC]/.test(status) ? fields[i++]! : oldPath;
    if (!path) throw new UnsupportedSnapshot('Malformed NUL-delimited diff');
    changes.push({ status, oldPath, path });
  }
  return changes;
}
export function changedRanges(patch: string): Array<{ side: Side; start: number; end: number }> {
  const ranges: Array<{ side: Side; start: number; end: number }> = [];
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const left = Number(match[1]); const right = Number(match[3]);
    const removed = Number(match[2] ?? 1); const added = Number(match[4] ?? 1);
    if (removed) ranges.push({ side: 'LEFT', start: left, end: left + removed - 1 });
    if (added) ranges.push({ side: 'RIGHT', start: right, end: right + added - 1 });
  }
  return ranges;
}
export function priority(path: string): number {
  return /auth|security|permission|secret|crypt/i.test(path) ? 0 : /migrat|schema|database|persist|api|route/i.test(path) ? 1 : 2;
}
export async function inventory(snapshot: Snapshot, exclusions: string[] = []): Promise<Inventory> {
  const result: Inventory = { atoms: [], evidence: new Map(), omissions: [], relations: [] };
  const changes = parseNames(await snapshot.git(['diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', snapshot.mergeBaseSha, snapshot.identity.headSha, '--']));
  for (const change of changes) {
    snapshot.signal.throwIfAborted();
    if (exclusions.some(x => change.path === x || change.path.startsWith(x.replace(/\/$/, '') + '/'))) {
      result.omissions.push({ path: change.path, reason: 'explicit exclusion' }); continue;
    }
    const left = (await snapshot.tree(snapshot.mergeBaseSha)).get(change.oldPath);
    const right = (await snapshot.tree(snapshot.identity.headSha)).get(change.path);
    if ([left, right].some(e => e && !['100644', '100755'].includes(e.mode))) {
      result.omissions.push({ path: change.path, reason: [left, right].some(e => e?.mode === '160000') ? 'submodule' : 'unsupported source mode (including symlink)' }); continue;
    }
    let oldSource; let newSource;
    try {
      oldSource = left ? await snapshot.read(snapshot.mergeBaseSha, change.oldPath) : undefined;
      newSource = right ? await snapshot.read(snapshot.identity.headSha, change.path) : undefined;
    } catch (error) { result.omissions.push({ path: change.path, reason: error instanceof Error ? error.message : 'unsupported source' }); continue; }
    if ((left && !oldSource) || (right && !newSource)) { result.omissions.push({ path: change.path, reason: 'binary or unsupported non-UTF-8 text' }); continue; }
    const patch = await snapshot.git(['--literal-pathspecs', 'diff', '--text', '--no-ext-diff', '--no-textconv', '--unified=0', '--find-renames', snapshot.mergeBaseSha, snapshot.identity.headSha, '--', change.oldPath, change.path]);
    const ranges = changedRanges(patch);
    for (const range of ranges) {
      const source = range.side === 'LEFT' ? oldSource : newSource;
      if (!source) throw new UnsupportedSnapshot('Diff references missing source');
      const lines = sourceLines(source.text);
      // Contiguous line groups are the smallest declared coverage units. Long lines remain intact.
      for (let start = range.start; start <= range.end; start += 40) {
        const end = Math.min(start + 39, range.end);
        const path = range.side === 'LEFT' ? change.oldPath : change.path;
        const evidence = await snapshot.evidence(path, range.side, Math.max(1, start - 20), end + 20);
        if (!evidence) throw new UnsupportedSnapshot('Could not materialize changed range');
        result.evidence.set(evidence.id, evidence);
        const atom: Atom = { id: `a-${hash([change.oldPath, change.path, range.side, start, end, source.blobId]).slice(0, 24)}`,
          path: change.path, oldPath: change.oldPath, side: range.side, start, end,
          text: lines.slice(start - 1, end).join('\n'), evidenceIds: [evidence.id], priority: priority(change.path) };
        result.atoms.push(atom);
      }
    }
    if (!ranges.length) result.omissions.push({ path: change.path, reason: 'metadata-only change (rename, mode, or empty file); no text hunks' });
  }
  return result;
}
