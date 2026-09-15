import type { Settings } from '../config.js';
import { hash, ConfigurationError } from '../util.js';
import { Snapshot } from './snapshot.js';

export type Rules = { files: Array<{ path: string; blobId: string; text: string }>; notices: string[]; hash: string };
export async function readRules(snapshot: Snapshot, settings: Settings, revision = snapshot.identity.baseSha): Promise<Rules> {
  const tree = await snapshot.tree(revision);
  const files: Rules['files'] = []; const notices: string[] = []; const seen = new Set<string>();
  for (const configured of settings.rules_paths) {
    const path = configured.replace(/\/$/, '');
    if (path.startsWith('/') || path.split('/').includes('..')) throw new ConfigurationError(`rules_paths must be repository-relative: ${path}`);
    const paths = tree.has(path) ? [path] : [...tree.keys()].filter(p => p.startsWith(path + '/')).sort();
    if (!paths.length) notices.push(`Configured rules path not found: ${configured}`);
    for (const name of paths) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!name.toLowerCase().endsWith('.md')) { notices.push(`Unsupported rule format: ${name}; only Markdown is interpreted, globally in supplied order.`); continue; }
      const content = await snapshot.read(revision, name);
      if (!content) { notices.push(`Unsupported rule source: ${name}`); continue; }
      files.push({ path: name, ...content });
    }
  }
  return { files, notices, hash: hash({ files, notices }) };
}
