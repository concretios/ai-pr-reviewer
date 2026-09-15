import { describe, expect, it } from 'vitest';
import { emptyAnalysis, runReview } from '../src/runtime/runner.js';
import { summarizeUsage, usageText } from '../src/reporting/usage.js';
import type { Attempt } from '../src/contracts.js';
import { provider, result, source, rules, testLimits, settings } from './helpers.js';

function analysis(attempts: Attempt[]) {
  return { ...emptyAnalysis(), attempts, usage: { attempts: attempts.length, charged: 453376, reserved: 0, unknown: 0 } };
}
const attempt = (input: number, total: number): Attempt => ({ taskId: 'test', preflight: input, promptTokenCount: input, totalTokenCount: total });
describe('usage and cost reporting', () => {
  it('prices the successful Trace run, without double counting thinking or using the admission ledger', () => {
    const a = analysis([{ ...attempt(258407, 327330), thoughtsTokenCount: 60000 }]);
    const report = summarizeUsage(a, 'models/gemini-2.5-flash');
    expect(report).toMatchObject({ totalTokens: 327330, inputTokens: 258407, outputTokens: 68923, thoughtsTokens: 60000, unreportedAttempts: 0 });
    expect(report.estimatedCostUsd).toBeCloseTo(0.2498296, 9);
    expect(usageText(a, 'gemini-2.5-flash')).toContain('$0.2498 USD');
  });
  it('includes malformed/truncated generations and prices each Pro request at its own threshold', () => {
    const a = analysis([{ ...attempt(200000, 201000), finishReason: 'MAX_TOKENS' }, { ...attempt(200001, 201001), error: 'Invalid JSON' }]);
    expect(summarizeUsage(a, 'gemini-2.5-pro').estimatedCostUsd).toBeCloseTo(0.7750025, 9);
  });
  it('reports missing usage as unknown rather than as zero or a full price', () => {
    const a = analysis([attempt(1000, 1200), { taskId: 'timeout', preflight: 32000, error: 'timeout' }]);
    a.usage.unknown = 1;
    const summary = summarizeUsage(a, 'gemini-2.5-flash');
    expect(summary).toMatchObject({ unreportedAttempts: 1, totalTokens: 1200, pricedAttempts: 1 });
    expect(usageText(a, 'gemini-2.5-flash')).toContain('incomplete: 1/2 attempts priced');
    const failed = analysis([{ taskId: 'error', preflight: 100 }]);
    expect(summarizeUsage(failed, 'gemini-2.5-flash')).toMatchObject({ totalTokens: null, estimatedCostUsd: null });
  });
  it('keeps totals but declines to price missing or inconsistent input splits', () => {
    const a = analysis([{ taskId: 'test', preflight: 100, totalTokenCount: 500 }, attempt(1000, 500)]);
    expect(summarizeUsage(a, 'gemini-2.5-flash')).toMatchObject({ totalTokens: 1000, inputTokens: null, outputTokens: null, estimatedCostUsd: null });
  });
  it('handles skipped runs, zero usage, unknown model aliases and Flash-Lite rates', () => {
    expect(summarizeUsage(emptyAnalysis(), 'gemini-2.5-flash')).toMatchObject({ totalTokens: 0, estimatedCostUsd: 0 });
    expect(summarizeUsage(analysis([attempt(0, 0)]), 'gemini-2.5-flash').pricedAttempts).toBe(1);
    expect(summarizeUsage(analysis([attempt(1000, 2000)]), 'gemini-flash-latest').estimatedCostUsd).toBeNull();
    expect(summarizeUsage(analysis([attempt(1000000, 2000000)]), 'gemini-2.5-flash-lite').estimatedCostUsd).toBeCloseTo(0.5);
  });
  it('retains optional output/thinking metadata before decoding the result', async () => {
    const p = provider(async req => ({ ...result(req), usage: { promptTokenCount: 400, candidatesTokenCount: 50, thoughtsTokenCount: 70, totalTokenCount: 520 } }));
    const run = await runReview({ inventory: source(), rules, provider: p, model: settings.model, limits: testLimits, lookup: async () => { throw new Error('Unexpected lookup'); } });
    expect(run.attempts[0]).toMatchObject({ candidatesTokenCount: 50, thoughtsTokenCount: 70 });
    expect(summarizeUsage(run, settings.model).outputTokens).toBe(120);
  });
});

it('reports cached input separately without repricing or counting it twice', () => {
  const analysis = emptyAnalysis();
  analysis.attempts = [{ taskId: 'a', preflight: 1000, promptTokenCount: 1000, totalTokenCount: 2000, cachedContentTokenCount: 800 }];
  analysis.usage = { attempts: 1, charged: 2000, reserved: 0, unknown: 0 };
  const summary = summarizeUsage(analysis, 'gemini-2.5-flash');
  expect(summary.cachedTokens).toBe(800); expect(summary.cacheReportedAttempts).toBe(1);
  expect(summary.totalTokens).toBe(2000); expect(summary.estimatedCostUsd).toBeCloseTo(0.0028);
  delete analysis.attempts[0]!.cachedContentTokenCount;
  expect(summarizeUsage(analysis, 'gemini-2.5-flash').cachedTokens).toBeNull();
  analysis.attempts[0]!.cachedContentTokenCount = 2000;
  expect(summarizeUsage(analysis, 'gemini-2.5-flash').cacheReportedAttempts).toBe(0);
});
