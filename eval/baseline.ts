import { readFile } from 'node:fs/promises';
import type { Snapshot } from '../src/source/snapshot.js';
import type { Rules } from '../src/source/rules.js';
import { parseNames } from '../src/source/diff.js';
import { hash } from '../src/util.js';

/** Frozen v1 prompt/request assembly, with safe immutable reads replacing its checkout reads. */
export async function baselineRequest(snapshot: Snapshot, rules: Rules, checkout = snapshot.identity.headSha,
  metadata = { title: 'Pinned evaluation change', body: '', author: 'fixture' }, related = false, maxFiles = 20) {
  const template = await readFile(new URL('./baseline-v1/prompts/code-review.md', import.meta.url), 'utf8');
  const schema = JSON.parse(await readFile(new URL('./baseline-v1/schemas/review-output.json', import.meta.url), 'utf8')); delete schema.$schema;
  const diff = await snapshot.git(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', snapshot.mergeBaseSha, snapshot.identity.headSha, '--']);
  const changed = parseNames(await snapshot.git(['diff', '--name-status', '-z', '--find-renames', snapshot.mergeBaseSha, snapshot.identity.headSha, '--']));
  const selected = changed.slice(0, maxFiles);
  const contents = async (paths: string[]) => (await Promise.all(paths.map(async path => {
    const source = await snapshot.read(checkout, path); return source ? `=== FILE: ${path} ===\n${source.text}\n` : `=== FILE: ${path} (deleted) ===\n\n`;
  }))).join('');
  const relatedPaths = new Set<string>();
  if (related) {
    const { posix } = await import('node:path'); const tree = await snapshot.tree(checkout);
    for (const item of selected) {
      const source = await snapshot.read(checkout, item.path); if (!source) continue;
      for (const match of source.text.matchAll(/(?:from|require\()\s*['"](\.[^'"]+)['"]/g)) {
        const stem = posix.normalize(posix.join(posix.dirname(item.path), match[1]!));
        const path = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'].map(ext => stem + ext).find(p => tree.has(p));
        if (path && !selected.some(c => c.path === path)) relatedPaths.add(path);
      }
    }
  }
  const values: Record<string, string> = {
    tech_stack: 'TypeScript', project_tree: [...(await snapshot.tree(checkout)).keys()].sort().slice(0, 200).map(p => './' + p).join('\n'),
    rules_content: rules.files.map(f => `\n\n--- Rules from ${f.path} ---\n${f.text.trimEnd()}`).join(''),
    no_rules_section: rules.files.length ? '' : '**IMPORTANT:** No coding standards files were found in this repository. In your review, include a missing_guardrails section recommending which standards files to create for this TypeScript project, with starter content for each.',
    pr_title: metadata.title, pr_body: metadata.body, pr_author: metadata.author, diff,
    changed_files: await contents(selected.map(c => c.path)), related_files: await contents([...relatedPaths].sort()),
    context_notes: changed.length > maxFiles ? `NOTE: This PR touches ${changed.length} files. Only the first ${maxFiles} are included for review.` : '',
  };
  const prompt = template.split('<!-- END HEADER -->').slice(1).join('').replace(/\{\{([a-z_]+)\}\}/g, (match, name: string) => values[name]?.trimEnd() ?? match);
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, temperature: 0.2, maxOutputTokens: 16384 },
    safetySettings: ['HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_DANGEROUS_CONTENT', 'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_SEXUALLY_EXPLICIT'].map(category => ({ category, threshold: 'BLOCK_ONLY_HIGH' })) };
  return { body, promptCharacters: prompt.length, changedFiles: changed.length, selectedFiles: selected.length, promptHash: hash(template), schemaHash: hash(schema) };
}
