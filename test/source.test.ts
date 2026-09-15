import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Snapshot } from '../src/source/snapshot.js';
import { inventory, parseNames } from '../src/source/diff.js';
import { lookup } from '../src/source/context.js';
import { readRules } from '../src/source/rules.js';
import { resolveSettings } from '../src/config.js';
import { freshnessGate } from '../src/github/freshness.js';
import { manifest, api } from './helpers.js';
import type { PullRequest } from '../src/github/authorize.js';
const exec = promisify(execFile);
const directories: string[] = []; const snapshots: Snapshot[] = [];
afterEach(async () => { await Promise.all(snapshots.splice(0).map(s => s.dispose())); await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'review-fixture-')); directories.push(dir);
  const git = async (...args: string[]) => (await exec('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args])).stdout.trim();
  await git('init', '-b', 'main');
  await writeFile(join(dir, 'old name.ts'), 'keep\nremove\n');
  await writeFile(join(dir, 'delete.ts'), 'deleted();\n');
  await writeFile(join(dir, 'AGENTS.md'), 'Base rule\n');
  await writeFile(join(dir, 'unchanged.ts'), 'export function guard() { return false; }\n');
  await git('add', '.'); await git('commit', '-m', 'base'); const base = await git('rev-parse', 'HEAD');
  await git('checkout', '-b', 'topic');
  await rename(join(dir, 'old name.ts'), join(dir, '新 name\t.ts'));
  await writeFile(join(dir, '新 name\t.ts'), 'keep\nreplacement\n');
  await rm(join(dir, 'delete.ts'));
  await writeFile(join(dir, 'AGENTS.md'), 'PR attempts to replace its own rules\n');
  await writeFile(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(join(dir, 'binary'), Buffer.from([0, 1, 2]));
  await symlink('/etc/passwd', join(dir, 'link'));
  await writeFile(join(dir, 'large.ts'), Array.from({ length: 3000 }, (_, i) => `const n${i} = ${i};`).join('\n') + '\n');
  await git('add', '.'); await git('commit', '-m', 'head'); const head = await git('rev-parse', 'HEAD');
  const capture = async (baseSha = base, headSha = head) => {
    const s = await Snapshot.capture({ ...manifest, baseSha, headSha }, dir, AbortSignal.timeout(10000)); snapshots.push(s); return s;
  };
  return { dir, git, base, head, capture };
}
describe('immutable source and diff coverage', () => {
  it('preserves Unicode, tabs, newlines, and whitespace from NUL-delimited names', () => {
    expect(parseNames('R100\0old name\0新\nname\0D\0a\tb\0')).toEqual([{ status: 'R100', oldPath: 'old name', path: '新\nname' }, { status: 'D', oldPath: 'a\tb', path: 'a\tb' }]);
  });
  it('reads only pinned regular objects, retains deletion/lockfile/huge-file hunks and base rules', async () => {
    const f = await fixture(); const s = await f.capture(); const inv = await inventory(s);
    expect(inv.atoms.some(a => a.path === 'delete.ts' && a.side === 'LEFT')).toBe(true);
    expect(inv.atoms.some(a => a.path === 'package-lock.json')).toBe(true);
    expect(inv.atoms.some(a => a.path === '新 name\t.ts')).toBe(true);
    expect(inv.atoms.filter(a => a.path === 'large.ts').reduce((n, a) => n + a.end - a.start + 1, 0)).toBe(3000);
    expect(inv.omissions).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'binary' }), expect.objectContaining({ path: 'link' })]));
    expect(await s.read(f.head, 'link')).toBeUndefined();
    const rules = await readRules(s, resolveSettings(undefined, {})); expect(rules.files[0]!.text).toBe('Base rule\n');
    await writeFile(join(f.dir, 'AGENTS.md'), 'uncommitted changes'); expect((await readRules(s, resolveSettings(undefined, {}))).hash).toBe(rules.hash);
  });
  it('does not collapse a historical comparison into the merged-current-base snapshot', async () => {
    const f = await fixture(); expect((await inventory(await f.capture())).atoms.length).toBeGreaterThan(0);
    expect((await inventory(await f.capture(f.head, f.head))).atoms).toEqual([]);
  });
  it('fails explicitly when histories have no common merge base', async () => {
    const f = await fixture(); const tree = await f.git('rev-parse', `${f.head}^{tree}`); const orphan = await f.git('commit-tree', tree, '-m', 'orphan');
    await expect(f.capture(orphan, f.head)).rejects.toThrow('merge-base');
  });
  it('rejects multiple best merge bases from a criss-cross history', async () => {
    const f = await fixture(); const tree = await f.git('rev-parse', `${f.head}^{tree}`);
    const a = await f.git('commit-tree', tree, '-p', f.base, '-m', 'a'); const b = await f.git('commit-tree', tree, '-p', f.base, '-m', 'b');
    const left = await f.git('commit-tree', tree, '-p', a, '-p', b, '-m', 'left'); const right = await f.git('commit-tree', tree, '-p', b, '-p', a, '-m', 'right');
    await expect(f.capture(left, right)).rejects.toThrow('found 2');
  });
  it('lookup admits unchanged/base-side evidence and returns explicit bounds', async () => {
    const f = await fixture(); const s = await f.capture();
    const read = await lookup(s, { kind: 'range', path: 'unchanged.ts', side: 'LEFT', start: 1, end: 1 });
    expect(read.evidence[0]!.revision).toBe(f.base);
    expect((await lookup(s, { kind: 'range', path: 'large.ts', side: 'RIGHT', start: 1, end: 201 })).limited).toBe(true);
    expect((await lookup(s, { kind: 'search', literal: 'const n', side: 'RIGHT' })).limited).toBe(true);
  });
  it('lists submodules without initializing them', async () => {
    const f = await fixture(); await f.git('update-index', '--add', '--cacheinfo', `160000,${f.base},external`);
    await f.git('commit', '-m', 'submodule');
    const s = await f.capture(f.base, await f.git('rev-parse', 'HEAD'));
    expect((await inventory(s)).omissions).toContainEqual({ path: 'external', reason: 'submodule' });
    expect(await s.read(s.identity.headSha, 'external')).toBeUndefined();
  });
  it('reports unsupported configured rule dialects', async () => {
    const f = await fixture(); await f.git('checkout', 'main'); await mkdir(join(f.dir, 'rules')); await writeFile(join(f.dir, 'rules/a.mdc'), 'scoped');
    await f.git('add', '.'); await f.git('commit', '-m', 'rules');
    const s = await f.capture(await f.git('rev-parse', 'HEAD'));
    expect((await readRules(s, resolveSettings(undefined, { rules_paths: 'rules' }))).notices[0]).toContain('Unsupported rule format');
  });
  it('allows harmless base advancement but rejects retargeting and changed consumed base evidence', async () => {
    const f = await fixture(); const s = await f.capture(); const settings = resolveSettings(undefined, {}); const rules = await readRules(s, settings);
    const repo = { id: 1, full_name: manifest.repository, default_branch: 'main' };
    const pr: PullRequest = { number: 29, state: 'open', user: { login: 'dev' }, base: { repo, sha: f.base, ref: 'main' }, head: { repo, sha: f.head, ref: 'topic' } };
    let current = structuredClone(pr); const gh = api(() => current);
    const gate = freshnessGate(gh, s, pr, f.dir, settings, rules, '.ai-review.yml');
    await f.git('checkout', 'main'); await writeFile(join(f.dir, 'unrelated.txt'), 'advance'); await f.git('add', '.'); await f.git('commit', '-m', 'advance');
    current.base.sha = await f.git('rev-parse', 'HEAD'); expect(await gate()).toBe(true);
    current.base.ref = 'release'; expect(await gate()).toBe(false); current.base.ref = 'main';
    await writeFile(join(f.dir, 'AGENTS.md'), 'changed base rules'); await f.git('add', '.'); await f.git('commit', '-m', 'changed rules');
    current.base.sha = await f.git('rev-parse', 'HEAD'); expect(await gate()).toBe(false);
    current = { ...pr, head: { ...pr.head, sha: f.base } }; expect(await gate()).toBe(false);
  });
});
