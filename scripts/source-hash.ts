import { readFile, readdir } from 'node:fs/promises';
import { hash } from '../src/util.js';

const root = new URL('../', import.meta.url);

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(new URL(directory + '/', root), { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? files(directory + '/' + e.name) : [directory + '/' + e.name]))).flat().sort();
}

// Any path added here changes the embedded action revision. Keep this file itself
// in the list: it is part of what determines the hash's own output.
export async function sourcePaths(): Promise<string[]> {
  return [...await files('src'), ...await files('prompts'), 'action.yml', 'package-lock.json', 'scripts/build.ts', 'scripts/source-hash.ts'];
}

export async function sourceHash(): Promise<string> {
  const paths = await sourcePaths();
  return hash(await Promise.all(paths.map(async path => [path, await readFile(new URL(path, root), 'utf8')])));
}
