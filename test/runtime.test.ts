import { describe, expect, it, vi } from 'vitest';
import { Budget } from '../src/runtime/budget.js';
import { runReview } from '../src/runtime/runner.js';
import { limits } from '../src/config.js';
import { ProviderError } from '../src/providers/provider.js';
import { source, provider, result, rules, testLimits, taskInput, finding } from './helpers.js';
import type { Generation } from '../src/providers/provider.js';
const options = () => ({ inventory: source(), provider: provider(), rules, limits: testLimits, model: 'gemini-2.5-flash', lookup: vi.fn() });

describe('atomic admission ledger', () => {
  it('rejects attempt thirteen and accounts thinking only once', () => {
    const budget = new Budget(limits('auto'));
    for (let i = 0; i < 12; i++) { const t = budget.reserve()!; expect(t).toBeDefined(); budget.settle(t, 100); budget.settle(t, 999999); }
    expect(budget.reserve()).toBeUndefined(); expect(budget.snapshot().charged).toBe(1200);
  });
  it('reserves concurrent calls and retains unknown usage after closure', () => {
    const budget = new Budget({ ...limits('auto'), tokens: 130000 });
    const one = budget.reserve()!; const two = budget.reserve()!;
    expect(budget.reserve()).toBeUndefined(); budget.settle(one, 1000); budget.close(); budget.settle(two, 1);
    expect(budget.snapshot()).toEqual({ attempts: 2, charged: 65768, reserved: 0, unknown: 1 });
  });
});
describe('harness completion and finite recovery', () => {
  it('completes zero-finding reviews without requiring praise', async () => {
    const run = await runReview(options()); expect(run.status).toBe('complete'); expect(run.findings).toEqual([]);
  });
  it('STOP plus a context request completes no work and repeated requests stay unresolved', async () => {
    const o = options();
    o.provider = provider(async req => ({ finishReason: 'STOP', text: JSON.stringify({ kind: 'context_request', taskId: taskInput(req).taskId,
      requests: [{ kind: 'range', path: 'file0.ts', side: 'RIGHT', start: 1, end: 1 }] }) }));
    o.lookup.mockResolvedValue({ request: {}, evidence: [...o.inventory.evidence.values()], limited: false });
    const run = await runReview(o);
    expect(run.status).toBe('unavailable'); expect(o.lookup).toHaveBeenCalledTimes(1); expect(o.provider.generateOnce).toHaveBeenCalledTimes(2);
    expect(run.diagnostics[0]!.reason).toContain('Repeated');
  });
  it.each(['missing', 'duplicate', 'foreign', 'json'])('rejects %s IDs/JSON with only one replacement', async kind => {
    const o = options(); o.provider = provider(async req => {
      const value = JSON.parse(result(req).text);
      if (kind === 'missing') value.items = [];
      if (kind === 'duplicate') value.items.push(value.items[0]);
      if (kind === 'foreign') value.items[0].id = 'bogus';
      return { finishReason: 'STOP', text: kind === 'json' ? '{' : JSON.stringify(value) };
    });
    const run = await runReview(o); expect(run.status).toBe('unavailable'); expect(run.usage.attempts).toBe(2);
  });
  it('recovers singleton truncation once with 8192 thinking tokens', async () => {
    const o = options(); o.provider = provider(async req => req.generationConfig.thinkingConfig.thinkingBudget === -1 ? { finishReason: 'MAX_TOKENS', text: '{}' } : result(req));
    const run = await runReview(o); expect(run.status).toBe('complete'); expect(run.usage.attempts).toBe(2);
  });
  it('splits truncated work with inherited retry allowances and exclusive ownership', async () => {
    const o = options(); o.inventory = source(4);
    o.provider = provider(async req => taskInput(req).expectedIds.length > 1 ? { finishReason: 'MAX_TOKENS', text: '' } : result(req));
    o.provider.count = vi.fn(async req => 100 + taskInput(req).expectedIds.length * 100);
    const run = await runReview(o); expect(run.status).toBe('complete'); expect(Object.keys(run.atoms)).toHaveLength(4); expect(run.usage.attempts).toBe(7);
  });
  it('terminates shared-rule overhead without generating or recursively splitting', async () => {
    const o = options(); o.inventory = source(20); o.provider.count = vi.fn(async () => 32000);
    const run = await runReview(o); expect(run.status).toBe('unavailable'); expect(o.provider.generateOnce).not.toHaveBeenCalled(); expect(o.provider.count).toHaveBeenCalledTimes(1);
  });
  it('marks indivisible oversized lines unresolved', async () => {
    const o = options(); o.provider.count = vi.fn(async req => taskInput(req).expectedIds.length ? 50000 : 100);
    const run = await runReview(o); expect(run.status).toBe('unavailable'); expect(o.provider.generateOnce).not.toHaveBeenCalled();
  });
  it('preserves completed work when another batch exhausts attempts', async () => {
    const o = options(); o.inventory = source(2); o.limits = { ...testLimits, attempts: 1, input: 1000 };
    o.provider.count = vi.fn(async req => 100 + taskInput(req).expectedIds.length * 600);
    const run = await runReview(o); expect(run.status).toBe('partial'); expect(Object.values(run.atoms).filter(a => a.status === 'reviewed')).toHaveLength(1);
  });
  it('unresolved integration prevents complete changed-code review from claiming complete', async () => {
    const o = options(); o.inventory = source(2); o.limits = { ...testLimits, input: 1000 };
    o.inventory.relations.push({ id: 'r1', atomIds: ['a0', 'a1'], evidenceIds: ['e0', 'e1'], question: 'Does the caller match?' });
    o.provider = provider(async req => {
      const value = result(req); if (taskInput(req).kind === 'integration') {
        const body = JSON.parse(value.text); body.items[0].status = 'unresolved'; value.text = JSON.stringify(body);
      } return value;
    });
    o.provider.count = vi.fn(async req => 100 + taskInput(req).expectedIds.length * 600);
    const run = await runReview(o); expect(run.status).toBe('partial'); expect(run.relations.r1!.status).toBe('unresolved');
  });
  it('a retryable transport failure has one retry, unknown usage stays charged', async () => {
    const o = options(); o.provider = provider(async () => { throw new ProviderError('503', true); });
    const run = await runReview(o); expect(run.status).toBe('unavailable'); expect(run.usage.attempts).toBe(2); expect(run.usage.unknown).toBe(2);
  });
  it('does not retry permanent authentication failures', async () => {
    const o = options(); o.provider = provider(async () => { throw new ProviderError('401', false); });
    expect((await runReview(o)).usage.attempts).toBe(1);
  });
  it('late generation cannot mutate a finalized report, schedule a lookup, or refund usage', async () => {
    let finish!: (value: Generation) => void;
    const o = options(); o.limits = { ...testLimits, durationMs: 100, reserveMs: 50 };
    o.provider = provider(async () => new Promise(resolve => { finish = resolve; }));
    const run = await runReview(o); const frozen = JSON.stringify(run);
    expect(run.status).toBe('unavailable'); expect(run.usage.unknown).toBe(1);
    finish({ finishReason: 'STOP', text: JSON.stringify({ kind: 'context_request', taskId: 'late', requests: [] }), usage: { totalTokenCount: 1 } });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(JSON.stringify(run)).toBe(frozen); expect(o.lookup).not.toHaveBeenCalled(); expect(o.provider.generateOnce).toHaveBeenCalledTimes(1);
  });
  it('late lookup cannot accept findings or schedule a rerun after cancellation', async () => {
    const o = options(); const controller = new AbortController(); let finish!: (value: unknown) => void;
    o.provider = provider(async req => ({ finishReason: 'STOP', text: JSON.stringify({ kind: 'context_request', taskId: taskInput(req).taskId, requests: [{ kind: 'search', side: 'RIGHT', literal: 'caller' }] }) }));
    o.lookup.mockImplementation(() => new Promise(resolve => { finish = resolve; controller.abort(); }));
    const run = await runReview({ ...o, signal: controller.signal }); const frozen = JSON.stringify(run);
    finish({ evidence: [], limited: false }); await Promise.resolve();
    expect(run.status).toBe('unavailable'); expect(JSON.stringify(run)).toBe(frozen); expect(o.provider.generateOnce).toHaveBeenCalledTimes(1);
  });
  it('deduplicates accepted concerns and counts invalid candidates as terminal diagnostics', async () => {
    const o = options(); o.provider = provider(async req => result(req, [finding, finding, { ...finding, evidenceIds: ['fabricated'] }]));
    const run = await runReview(o); expect(run.status).toBe('complete'); expect(run.findings).toHaveLength(1); expect(run.diagnostics[0]!.disposition).toBe('rejected_invalid_evidence');
  });
});

it('creates mandatory integration work when output recovery splits a formerly single batch', async () => {
  const o = options(); o.inventory = source(2);
  o.inventory.relations.push({ id: 'r1', atomIds: ['a0', 'a1'], evidenceIds: ['e0', 'e1'], question: 'Do the changed interfaces match?' });
  o.provider = provider(async req => {
    const input = taskInput(req);
    if (input.kind === 'review' && input.expectedIds.length > 1) return { finishReason: 'MAX_TOKENS', text: '' };
    const response = result(req);
    if (input.kind === 'integration') { const body = JSON.parse(response.text); body.items[0].status = 'unresolved'; response.text = JSON.stringify(body); }
    return response;
  });
  o.provider.count = vi.fn(async req => 100 + taskInput(req).expectedIds.length * 100);
  const run = await runReview(o); expect(run.status).toBe('partial'); expect(run.relations.r1!.status).toBe('unresolved');
  expect(Object.values(run.atoms).every(a => a.status === 'reviewed')).toBe(true);
});
it('plans a thousand changed ranges without a count API call per range', async () => {
  const o = options(); o.inventory = source(1000);
  o.provider.count = vi.fn(async req => 100 + taskInput(req).expectedIds.length * 100);
  const run = await runReview(o); expect(run.status).toBe('complete');
  expect(vi.mocked(o.provider.count).mock.calls.length).toBeLessThan(30);
});
it('rejects lookup rounds over 8000 counted tokens', async () => {
  const o = options();
  o.provider = provider(async req => ({ finishReason: 'STOP', text: JSON.stringify({ kind: 'context_request', taskId: taskInput(req).taskId, requests: [{ kind: 'search', side: 'RIGHT', literal: 'caller' }] }) }));
  o.lookup.mockResolvedValue({ request: {}, evidence: [...o.inventory.evidence.values()], limited: false });
  o.provider.count = vi.fn(async req => req.contents[0]!.parts[0]!.text.startsWith('[') ? 10000 : 100);
  const run = await runReview(o); expect(run.status).toBe('unavailable'); expect(run.usage.attempts).toBe(1); expect(run.diagnostics[0]!.reason).toContain('8,000');
});
it('retries one planning transport failure while keeping inherited recovery finite', async () => {
  const o = options(); let calls = 0;
  o.provider.count = vi.fn(async () => { if (++calls === 1) throw new ProviderError('count 503', true); return 100; });
  const run = await runReview(o); expect(run.status).toBe('complete'); expect(run.usage.attempts).toBe(1);
});

it('consumes late rejections when cancellation occurs while creating asynchronous work', async () => {
  const { bounded } = await import('../src/util.js');
  let reject!: (error: Error) => void;
  const work = new Promise<never>((_, failure) => { reject = failure; });
  const controller = new AbortController(); controller.abort(new Error('closed'));
  await expect(bounded(work, controller.signal)).rejects.toThrow('closed');
  reject(new Error('late transport rejection'));
  await new Promise(resolve => setImmediate(resolve));
});

it('keeps supersession independent of the analysis outcome and rejects late findings', async () => {
  const { Superseded } = await import('../src/util.js');
  const o = options(); const controller = new AbortController(); let finish!: () => void;
  o.provider = provider(async req => new Promise(resolve => {
    finish = () => resolve(result(req, [finding])); controller.abort(new Superseded('Head changed'));
  }));
  const run = await runReview({ ...o, signal: controller.signal });
  expect(run.status).toBe('superseded'); expect(run.analysisStatus).toBe('unavailable'); expect(run.usage.unknown).toBe(1);
  finish(); await Promise.resolve(); expect(run.findings).toEqual([]); expect(o.lookup).not.toHaveBeenCalled();
});
