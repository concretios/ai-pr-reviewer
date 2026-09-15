import { execFile } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnsupportedSnapshot, hash } from '../util.js';
import type { Evidence, Manifest, Side } from '../contracts.js';

const exec = promisify(execFile);
const oid = /^[a-f0-9]{40,64}$/;
export type Entry = { mode: string; type: string; oid: string; path: string };
export type SnapshotIdentity = Pick<Manifest, 'repository' | 'repositoryId' | 'prNumber' | 'baseRef' | 'baseSha' | 'headSha'>;
export class Snapshot {
  readonly trees = new Map<string, Map<string, Entry>>();
  readonly consumed = new Map<string, { revision: string; path: string; blobId: string }>();
  private readonly blobs = new Map<string, string | undefined>();
  private cachedBytes = 0;
  mergeBaseSha = '';
  private constructor(readonly directory: string, readonly identity: SnapshotIdentity, readonly signal: AbortSignal, private readonly token?: string) {}

  static async capture(identity: SnapshotIdentity, remote: string, signal: AbortSignal, token?: string): Promise<Snapshot> {
    if (!oid.test(identity.baseSha) || !oid.test(identity.headSha)) throw new UnsupportedSnapshot('Invalid commit identity');
    const snapshot = new Snapshot(await mkdtemp(join(tmpdir(), 'ai-review-source-')), identity, signal, token);
    try {
      await snapshot.git(['init', '--bare', '--template=', snapshot.directory]);
      await snapshot.fetch(remote, [identity.baseSha, identity.headSha]);
      snapshot.mergeBaseSha = await snapshot.mergeBase(identity.baseSha, identity.headSha);
      return snapshot;
    } catch (error) { await snapshot.dispose(); throw error; }
  }

  async git(args: string[], input?: string): Promise<string> {
    this.signal.throwIfAborted();
    if (input !== undefined) throw new Error('Git stdin is not supported');
    const auth = this.token ? `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}` : '';
    // Disable ambient Git config, credential helpers, hooks, replacement objects, and prompting.
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: auth };
    try {
      const { stdout } = await exec('git', ['--git-dir', this.directory, '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.attributesFile=/dev/null', '-c', 'credential.helper=', '-c', 'diff.renames=true', ...args],
      { env, signal: this.signal, maxBuffer: 128 * 1024 * 1024, encoding: 'buffer' });
      // Distinguish malformed UTF-8 from a legitimate U+FFFD source character.
      if (args[0] === 'cat-file' && args[1] === 'blob' && !isUtf8(stdout)) return '\0';
      return stdout.toString('utf8');
    } catch (error) {
      // execFile errors include arguments/stdout; never include auth or arbitrary repository text in logs.
      throw new UnsupportedSnapshot(`Git ${args[0]} failed (${(error as NodeJS.ErrnoException).code ?? 'unknown'}). Snapshot unavailable.`);
    }
  }

  async fetch(remote: string, shas: string[]): Promise<void> {
    if (shas.some(sha => !oid.test(sha))) throw new UnsupportedSnapshot('Invalid fetch object');
    await this.git(['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-recurse-submodules', '--', remote, ...shas]);
  }
  async mergeBase(base: string, head: string): Promise<string> {
    const bases = (await this.git(['merge-base', '--all', base, head])).trim().split(/\s+/).filter(Boolean);
    if (bases.length !== 1) throw new UnsupportedSnapshot(`Unsupported snapshot: expected one merge base, found ${bases.length}`);
    return bases[0]!;
  }
  async tree(revision: string): Promise<Map<string, Entry>> {
    if (!oid.test(revision)) throw new UnsupportedSnapshot('Invalid tree revision');
    const cached = this.trees.get(revision);
    if (cached) return cached;
    const entries = new Map<string, Entry>();
    const raw = await this.git(['ls-tree', '-rz', '--full-tree', revision]);
    for (const entry of raw.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const [mode, type, object] = entry.slice(0, tab).split(' ');
      const path = entry.slice(tab + 1);
      entries.set(path, { mode: mode!, type: type!, oid: object!, path });
    }
    this.trees.set(revision, entries);
    return entries;
  }
  async read(revision: string, path: string): Promise<{ text: string; blobId: string } | undefined> {
    const entry = (await this.tree(revision)).get(path);
    if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) return undefined;
    let text = this.blobs.get(entry.oid);
    if (!this.blobs.has(entry.oid)) {
      const size = Number((await this.git(['cat-file', '-s', entry.oid])).trim());
      if (size > 64 * 1024 * 1024) throw new UnsupportedSnapshot(`Source blob exceeds 64 MiB: ${path}`);
      const value = await this.git(['cat-file', 'blob', entry.oid]);
      text = value.includes('\0') ? undefined : value;
      const bytes = Buffer.byteLength(text ?? '');
      while (this.cachedBytes + bytes > 64 * 1024 * 1024 && this.blobs.size) {
        const first = this.blobs.keys().next().value!;
        this.cachedBytes -= Buffer.byteLength(this.blobs.get(first) ?? ''); this.blobs.delete(first);
      }
      this.blobs.set(entry.oid, text); this.cachedBytes += bytes;
    }
    if (text === undefined) return undefined;
    this.consumed.set(`${revision}:${path}`, { revision, path, blobId: entry.oid });
    return { text, blobId: entry.oid };
  }
  revision(side: Side): string { return side === 'LEFT' ? this.mergeBaseSha : this.identity.headSha; }
  async evidence(path: string, side: Side, start: number, end: number): Promise<Evidence | undefined> {
    const revision = this.revision(side);
    const source = await this.read(revision, path);
    if (!source) return undefined;
    const lines = sourceLines(source.text);
    const last = Math.min(end, lines.length);
    if (start < 1 || start > last || last - start >= 200) return undefined;
    const id = `e-${hash([revision, path, source.blobId, start, last]).slice(0, 24)}`;
    return { id, path, side, revision, blobId: source.blobId, start, end: last, text: lines.slice(start - 1, last).join('\n') };
  }
  async dispose(): Promise<void> { await rm(this.directory, { recursive: true, force: true }); }
}
export function sourceLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
