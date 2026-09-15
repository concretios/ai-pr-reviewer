import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { wireSchema } from '../src/review/schema.js';
import { sourceHash } from './source-hash.js';

const root = new URL('../', import.meta.url);
const revision = await sourceHash();
const prompts = { reviewPrompt: await readFile(new URL('prompts/review.md', root), 'utf8'), integrationPrompt: await readFile(new URL('prompts/integration.md', root), 'utf8') };
await mkdir(new URL('dist/', root), { recursive: true });
await build({ entryPoints: [new URL('src/entry.ts', root).pathname], outfile: new URL('dist/index.js', root).pathname,
  absWorkingDir: root.pathname,
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', legalComments: 'eof', sourcemap: false,
  plugins: [{ name: 'embed-prompts', setup(build) {
    build.onLoad({ filter: /[/\\]src[/\\]prompts\.ts$/ }, () => ({ contents: Object.entries(prompts).map(([name, text]) => `export const ${name} = ${JSON.stringify(text)};`).join('\n'), loader: 'ts' }));
  } }],
  define: { __ACTION_SOURCE_HASH__: JSON.stringify(revision) },
});
await writeFile(new URL('dist/package.json', root), '{"type":"commonjs"}\n');
await writeFile(new URL('schemas/review-output.json', root), JSON.stringify(wireSchema, null, 2) + '\n');
console.log(`Built action source ${revision}`);
