import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from '../src/util.js';
import { wireSchema } from '../src/review/schema.js';

const root = new URL('../', import.meta.url);
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(new URL(directory + '/', root), { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? files(join(directory, e.name)) : [join(directory, e.name)]))).flat().sort();
}
const sources = [...await files('src'), ...await files('prompts'), 'action.yml', 'package-lock.json', 'scripts/build.ts'];
const sourceHash = hash(await Promise.all(sources.map(async path => [path, await readFile(new URL(path, root), 'utf8')])));
const prompts = { reviewPrompt: await readFile(new URL('prompts/review.md', root), 'utf8'), integrationPrompt: await readFile(new URL('prompts/integration.md', root), 'utf8') };
await mkdir(new URL('dist/', root), { recursive: true });
await build({ entryPoints: [new URL('src/entry.ts', root).pathname], outfile: new URL('dist/index.js', root).pathname,
  absWorkingDir: root.pathname,
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', legalComments: 'eof', sourcemap: false,
  plugins: [{ name: 'embed-prompts', setup(build) {
    build.onLoad({ filter: /[/\\]src[/\\]prompts\.ts$/ }, () => ({ contents: Object.entries(prompts).map(([name, text]) => `export const ${name} = ${JSON.stringify(text)};`).join('\n'), loader: 'ts' }));
  } }],
  define: { __ACTION_SOURCE_HASH__: JSON.stringify(sourceHash) },
});
await writeFile(new URL('dist/package.json', root), '{"type":"commonjs"}\n');
await writeFile(new URL('schemas/review-output.json', root), JSON.stringify(wireSchema, null, 2) + '\n');
console.log(`Built action source ${sourceHash}`);
