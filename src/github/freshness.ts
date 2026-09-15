import { prSchema, type PullRequest } from './authorize.js';
import type { GitHubAPI } from './client.js';
import type { Snapshot } from '../source/snapshot.js';
import { readRules, type Rules } from '../source/rules.js';
import type { Settings } from '../config.js';

export function freshnessGate(api: GitHubAPI, snapshot: Snapshot, captured: PullRequest, remote: string,
  settings: Settings, rules: Rules, configPath: string, configBlobId?: string): () => Promise<boolean> {
  return async () => {
    const current = prSchema.parse(await api.get(`/repos/${snapshot.identity.repository}/pulls/${captured.number}`));
    if (current.state !== 'open' || current.head.sha !== captured.head.sha || current.head.repo?.id !== captured.head.repo?.id
      || current.base.repo?.id !== captured.base.repo?.id || current.base.ref !== captured.base.ref) return false;
    if (current.base.sha === captured.base.sha) return true;
    await snapshot.fetch(remote, [current.base.sha]);
    if (await snapshot.mergeBase(current.base.sha, current.head.sha) !== snapshot.mergeBaseSha) return false;
    if ((await readRules(snapshot, settings, current.base.sha)).hash !== rules.hash) return false;
    if ((await snapshot.tree(current.base.sha)).get(configPath)?.oid !== configBlobId) return false;
    // Compare only consumed captured-base blobs. Merge-base evidence is already pinned by equivalence above.
    const tree = await snapshot.tree(current.base.sha);
    for (const source of snapshot.consumed.values()) {
      if (source.revision === captured.base.sha && tree.get(source.path)?.oid !== source.blobId) return false;
    }
    return true;
  };
}
