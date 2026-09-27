import { describe, expect, it } from 'vitest';
import { sourceBlocks } from '../src/providers/projection.js';
import { prepareRequest } from '../src/providers/provider.js';
import { CompactResponseSchema } from '../src/review/schema.js';
import { decodeCompact } from '../src/review/validate.js';
import { reviewTask } from '../src/planning/planner.js';
import { source, rules, result, finding } from './helpers.js';
import type { Evidence } from '../src/contracts.js';

const e = (id: string, start: number, text: string, extra: Partial<Evidence> = {}): Evidence => ({ id, start, end: start + text.split('\n').length - 1,
  text, path: 'file.ts', revision: 'head', blobId: 'blob', side: 'RIGHT', ...extra });
function reconstruct(evidence: Evidence[]) {
  const projected = sourceBlocks(evidence);
  return projected.references.map(r => {
    const block = projected.blocks.find(b => b.id === r.block)!;
    return { id: r.id, text: block.text.split('\n').slice(r.start - block.start, r.end - block.start + 1).join('\n') };
  });
}
describe('lossless request projection', () => {
  it('merges overlaps and adjacent windows while preserving original evidence intervals', () => {
    const evidence = [e('e1', 1, 'a\r\n\n🌍'), e('e2', 3, '🌍\ntail'), e('e3', 5, 'last')];
    expect(sourceBlocks(evidence).blocks).toHaveLength(1);
    expect(reconstruct(evidence)).toEqual(evidence.map(({ id, text }) => ({ id, text })));
  });
  it('never bridges gaps or merges different revisions, sides, blobs or rename paths', () => {
    const evidence = [e('1', 1, 'a'), e('2', 3, 'b'), e('3', 1, 'a', { side: 'LEFT' }),
      e('4', 1, 'a', { revision: 'base' }), e('5', 1, 'a', { blobId: 'different' }), e('6', 1, 'a', { path: 'old.ts' })];
    expect(sourceBlocks(evidence).blocks).toHaveLength(6);
    expect(reconstruct(evidence)).toEqual(evidence.map(({ id, text }) => ({ id, text })));
  });
  it('falls back to original blocks on conflicts or ambiguous line metadata', () => {
    const conflict = [e('1', 1, 'a\nb'), e('2', 2, 'wrong')];
    expect(sourceBlocks(conflict).blocks).toHaveLength(2);
    expect(reconstruct(conflict)).toEqual(conflict.map(({ id, text }) => ({ id, text })));
    expect(sourceBlocks([e('3', 1, 'x', { end: 4 })]).blocks[0]!.text).toBe('x');
  });
  it('omits atom text only when supplied source reconstructs exactly; lookup source appears once', () => {
    const inv = source(); const task = reviewTask(inv.atoms);
    const lookup = { request: { kind: 'range' as const, path: 'file0.ts', side: 'RIGHT' as const, start: 1, end: 1 }, evidence: [...inv.evidence.values()], limited: false };
    const prepared = prepareRequest(task, inv, rules, 'gemini-2.5-flash', 32768, false, [lookup]);
    const text = prepared.request.contents[0]!.parts[0]!.text;
    expect(text.match(/changed\(\)/g)).toHaveLength(1);
    expect(JSON.parse(text).atoms[0].text).toBeUndefined();
    expect(JSON.parse(text).lookups[0]).toMatchObject({ evidenceIds: ['e0'], limited: false });
    inv.atoms[0]!.text = 'different()';
    expect(JSON.parse(prepareRequest(task, inv, rules, 'gemini-2.5-flash', 32768).request.contents[0]!.parts[0]!.text).atoms[0].text).toBe('different()');
  });
  it('preserves ordered rules as the stable prefix and does not mutate inventory', () => {
    const inv = source(2); const before = structuredClone(inv);
    const r = { ...rules, files: [{ path: 'first.md', blobId: '1', text: 'first' }, { path: 'second.md', blobId: '2', text: 'second' }] };
    const one = prepareRequest(reviewTask([inv.atoms[0]!]), inv, r, 'gemini-2.5-flash', 32768);
    const two = prepareRequest(reviewTask([inv.atoms[1]!]), inv, r, 'gemini-2.5-flash', 32768);
    expect(one.request.contents[0]!.parts[0]!.text.split(',"requestId"')[0]).toBe(two.request.contents[0]!.parts[0]!.text.split(',"requestId"')[0]);
    expect(inv).toEqual(before);
  });
});
describe('compact response identity and completion', () => {
  const setup = () => {
    const inv = source(); const task = reviewTask(inv.atoms);
    return { task, prepared: prepareRequest(task, inv, rules, 'gemini-2.5-flash', 32768) };
  };
  it('translates aliases to stable identities before validating finding anchors', () => {
    const inv = source(); inv.atoms[0]!.id = 'stable-atom'; inv.atoms[0]!.evidenceIds = ['stable-evidence'];
    const ev = inv.evidence.get('e0')!; inv.evidence = new Map([['stable-evidence', { ...ev, id: 'stable-evidence' }]]);
    const task = reviewTask(inv.atoms); const p = prepareRequest(task, inv, rules, 'gemini-2.5-flash', 32768);
    const decoded = decodeCompact(result(p.request, [finding]).text, task, p.binding);
    expect(decoded.kind).toBe('result');
    if (decoded.kind === 'result') {
      expect(decoded.findings[0]).toMatchObject({ introducedByAtomIds: ['stable-atom'], evidenceIds: ['stable-evidence'] });
      expect(decoded.items[0]).toMatchObject({ id: 'stable-atom', status: 'reviewed' });
    }
  });
  it.each(['missing', 'duplicate', 'foreign', 'both', 'wrong-request', 'version', 'foreign-evidence', 'namespace'])('rejects %s before accepting completion', mode => {
    const { task, prepared: p } = setup(); const value = JSON.parse(result(p.request, [finding]).text);
    if (mode === 'missing') value.reviewedIds = [];
    if (mode === 'duplicate') value.reviewedIds.push('a0');
    if (mode === 'foreign') value.reviewedIds = ['a1'];
    if (mode === 'both') value.unresolved = [{ id: 'a0', reason: 'missing' }];
    if (mode === 'wrong-request') value.requestId = 'another-request';
    if (mode === 'version') value.protocolVersion = 'old';
    if (mode === 'foreign-evidence') value.findings[0].evidenceIds = ['e999'];
    if (mode === 'namespace') value.findings[0].evidenceIds = ['a0'];
    expect(() => decodeCompact(JSON.stringify(value), task, p.binding)).toThrow();
  });
  it('rejects cross-task and stale repair responses even when aliases are identical', () => {
    const { task, prepared: p } = setup(); const inv = source();
    const repair = prepareRequest(task, inv, rules, 'gemini-2.5-flash', 32768, false, [], { code: 'json' });
    expect(() => decodeCompact(result(p.request).text, task, repair.binding)).toThrow('identity');
    expect(() => decodeCompact(result(p.request).text, { ...task, id: 'another-task' }, p.binding)).toThrow('identity');
    expect(p.request.contents[0]!.parts[0]!.text).not.toContain('repair');
  });
  it('context requests complete no work and enforce local bounds', () => {
    const { task, prepared: p } = setup();
    const response = { protocolVersion: 'compact-v2', requestId: p.binding.requestId, kind: 'context_request',
      requests: [{ kind: 'search', side: 'RIGHT', literal: 'definition' }] };
    expect(decodeCompact(JSON.stringify(response), task, p.binding).kind).toBe('context_request');
    expect(CompactResponseSchema.safeParse({ ...response, requests: Array(5).fill(response.requests[0]) }).success).toBe(false);
  });
});
it('filters improvements, preferences and unsupported claims without spending a replacement', () => {
  const inv = source(); const task = reviewTask(inv.atoms);
  const p = prepareRequest(task, inv, rules, 'gemini-2.5-flash', 32768);
  const value = JSON.parse(result(p.request, [finding]).text);
  value.findings.push(...['improvement', 'preference', 'existing_issue', 'insufficient_evidence'].map(classification => ({ ...value.findings[0], classification, title: classification })));
  const response = decodeCompact(JSON.stringify(value), task, p.binding);
  expect(response.kind).toBe('result');
  if (response.kind === 'result') expect(response.findings).toHaveLength(1);
  expect(response.filteredCandidates).toHaveLength(4);
});
