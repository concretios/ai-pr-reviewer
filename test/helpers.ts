import { vi } from 'vitest';
import type { Inventory, Finding, Manifest } from '../src/contracts.js';
import type { Request, Provider, Generation } from '../src/providers/provider.js';
import type { GitHubAPI } from '../src/github/client.js';
import { resolveSettings, limits } from '../src/config.js';
export const settings = resolveSettings(undefined, {});
export const rules = { files: [], notices: [], hash: 'rules' };
export const testLimits = { ...limits('auto'), durationMs: 10000, reserveMs: 100 };
export const manifest: Manifest = { repository: 'owner/repo', repositoryId: 1, prNumber: 29, baseRef: 'main',
  baseSha: 'a'.repeat(40), mergeBaseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), actionRevision: 'sourcehash', model: settings.model,
  configurationHash: 'config', promptHash: 'prompt', schemaHash: 'schema', ruleHash: 'rules', evidenceBlobs: {} };
export const finding: Finding = { severity: 'high', title: 'Concrete regression', changedBehavior: 'The change removes a guard.', trigger: 'An empty input reaches the caller.',
  consequence: 'The request fails.', introducedByAtomIds: ['a0'], evidenceIds: ['e0'], anchor: { path: 'file0.ts', side: 'RIGHT', line: 1 } };
export function source(size = 1): Inventory {
  return { atoms: Array.from({ length: size }, (_, i) => ({ id: `a${i}`, path: `file${i}.ts`, oldPath: `file${i}.ts`, side: 'RIGHT' as const,
    start: 1, end: 1, text: 'changed()', evidenceIds: [`e${i}`], priority: 2 })),
  evidence: new Map(Array.from({ length: size }, (_, i) => [`e${i}`, { id: `e${i}`, path: `file${i}.ts`, revision: manifest.headSha, blobId: `blob${i}`,
    side: 'RIGHT' as const, start: 1, end: 1, text: 'changed()' }])), omissions: [], relations: [] };
}
export function taskInput(req: Request): { requestId: string; protocolVersion: string; kind: string; expectedIds: string[]; evidence: unknown[] } {
  return JSON.parse(req.contents[0]!.parts[0]!.text);
}
export function result(req: Request, findings: Finding[] = []): Generation {
  const input = taskInput(req);
  return { finishReason: 'STOP', text: JSON.stringify({ kind: 'result', protocolVersion: input.protocolVersion, requestId: input.requestId,
    reviewedIds: input.expectedIds, unresolved: [], findings }), usage: { totalTokenCount: 500, promptTokenCount: 400 } };
}
export function provider(generate: (req: Request, signal: AbortSignal) => Promise<Generation> = async req => result(req)): Provider {
  return { count: vi.fn(async () => 100), generateOnce: vi.fn(generate) };
}
export function api(get: (path: string) => unknown): GitHubAPI {
  return { get: vi.fn(async <T>(path: string) => get(path) as T), list: vi.fn(async <T>() => [] as T[]), write: vi.fn(async <T>() => ({} as T)) } as unknown as GitHubAPI;
}
