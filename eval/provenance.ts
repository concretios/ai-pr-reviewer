import { readFile, readdir } from 'node:fs/promises';
import { hash } from '../src/util.js';
export async function sourceRevision(): Promise<string> {
  const root = new URL('../', import.meta.url);
  async function files(path: string): Promise<string[]> {
    const items = await readdir(new URL(path + '/', root), { withFileTypes: true });
    return (await Promise.all(items.map(e => e.isDirectory() ? files(path + '/' + e.name) : [path + '/' + e.name]))).flat().sort();
  }
  const paths = [...await files('src'), ...await files('prompts'), 'action.yml', 'package-lock.json', 'scripts/build.ts'];
  return `sha256:${hash(await Promise.all(paths.map(async p => [p, await readFile(new URL(p, root), 'utf8')])) )}`;
}
