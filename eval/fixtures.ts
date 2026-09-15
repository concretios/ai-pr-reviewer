import { readdir, readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { hash } from '../src/util.js';
import { resolveSettings } from '../src/config.js';
import type { Rules } from '../src/source/rules.js';
const exec = promisify(execFile);
const schema = z.object({ id: z.string(), category: z.enum(['clean', 'local', 'context']), split: z.enum(['development', 'held-out']),
  baseFiles: z.record(z.string(), z.string()), headFiles: z.record(z.string(), z.string()), sourceHash: z.string(),
  baseSha: z.string().optional(), headSha: z.string().optional(),
  eligibleAtoms: z.number().int().nonnegative().optional(),
  gold: z.array(z.object({ id: z.string(), severity: z.string(), trigger: z.string(), consequence: z.string() })) });
export type Fixture = z.infer<typeof schema>;
/** Known pinned fixture rules retain provenance even for a trial never admitted by suite budgets. */
export function fixtureRules(fixture: Fixture): Rules {
  const files: Rules['files'] = []; const notices: string[] = [];
  for (const path of resolveSettings(undefined, {}).rules_paths) {
    const text = fixture.baseFiles[path];
    if (text === undefined) { notices.push(`Configured rules path not found: ${path}`); continue; }
    const blobId = createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
    files.push({ path, text, blobId });
  }
  return { files, notices, hash: hash({ files, notices }) };
}
export async function fixtures(): Promise<Fixture[]> {
  const root = new URL('./fixtures/', import.meta.url);
  return Promise.all((await readdir(root)).filter(n => n.endsWith('.json')).sort().map(async name => schema.parse(JSON.parse(await readFile(new URL(name, root), 'utf8')))));
}
export async function materialize(fixture: Fixture): Promise<{ directory: string; baseSha: string; headSha: string; dispose: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'ai-review-eval-'));
  const git = async (...args: string[]) => (await exec('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Reviewer Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Reviewer Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', GIT_AUTHOR_DATE: '2026-09-15T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-15T00:00:00Z' } })).stdout.trim();
  const write = async (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
      if (path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.git')) throw new Error('Unsafe fixture path');
      await mkdir(join(directory, path, '..'), { recursive: true }); await writeFile(join(directory, path), text);
    }
  };
  try {
    await git('init', '--object-format=sha1', '-b', 'main'); await write(fixture.baseFiles); await git('add', '.'); await git('commit', '-m', `${fixture.id}:base`);
    const baseSha = await git('rev-parse', 'HEAD');
    for (const path of Object.keys(fixture.baseFiles)) await rm(join(directory, path));
    await write(fixture.headFiles); await git('add', '-A'); await git('commit', '-m', `${fixture.id}:head`);
    const headSha = await git('rev-parse', 'HEAD');
    if (fixture.baseSha && fixture.baseSha !== baseSha || fixture.headSha && fixture.headSha !== headSha) throw new Error(`Pinned fixture identity changed: ${fixture.id}`);
    return { directory, baseSha, headSha, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
