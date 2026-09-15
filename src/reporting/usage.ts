import type { Analysis, UsageReport } from '../contracts.js';

export const pricingSource = 'https://ai.google.dev/gemini-api/docs/pricing';
export const pricingChecked = '2026-09-15';
type Rates = { input: number; output: number };
// USD per million tokens, standard paid-tier text pricing. Exact models only.
// Recheck the official source before changing this table; never guess alias rates.
function rates(model: string, input: number): Rates | undefined {
  switch (model) {
    case 'gemini-2.5-flash': return { input: 0.30, output: 2.50 };
    case 'gemini-2.5-flash-lite': return { input: 0.10, output: 0.40 };
    case 'gemini-2.5-pro': return input > 200000 ? { input: 2.50, output: 15 } : { input: 1.25, output: 10 };
    default: return undefined;
  }
}
const tokenCount = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0;

export function summarizeUsage(analysis: Analysis, model = ''): UsageReport {
  model = model.replace(/^models\//, '');
  const attempts = Math.max(analysis.usage.attempts, analysis.attempts.length);
  let reported = 0; let components = 0; let priced = 0; let total = 0; let input = 0; let output = 0; let cost = 0;
  let thoughts = 0; let thoughtsReported = 0;
  // Count every generation, even malformed/blocked/truncated responses and retries.
  // Preflight counts and admission reservations are never treated as billed usage.
  for (const attempt of analysis.attempts) {
    if (tokenCount(attempt.thoughtsTokenCount)) { thoughts += attempt.thoughtsTokenCount; thoughtsReported++; }
    if (!tokenCount(attempt.totalTokenCount)) continue;
    reported++; total += attempt.totalTokenCount;
    if (!tokenCount(attempt.promptTokenCount) || attempt.promptTokenCount > attempt.totalTokenCount) continue;
    const generated = attempt.totalTokenCount - attempt.promptTokenCount;
    components++; input += attempt.promptTokenCount; output += generated;
    const price = rates(model, attempt.promptTokenCount);
    if (price) {
      priced++;
      cost += (attempt.promptTokenCount * price.input + generated * price.output) / 1000000;
    }
  }
  const supported = rates(model, 0) !== undefined;
  return {
    model, generationAttempts: attempts, reportedAttempts: reported, unreportedAttempts: Math.max(0, attempts - reported),
    totalTokens: reported || !attempts ? total : null,
    inputTokens: components || !attempts ? input : null, outputTokens: components || !attempts ? output : null,
    componentAttempts: components, thoughtsTokens: thoughtsReported || !attempts ? thoughts : null, thoughtsReportedAttempts: thoughtsReported,
    estimatedCostUsd: supported && (priced || !attempts) ? cost : null, pricedAttempts: priced,
    pricingChecked, pricingSource,
    pricingBasis: 'Standard paid-tier text list prices; output includes thinking. Before cache discounts, free-tier allowances, credits and taxes. This invocation only; not a Google invoice.',
    unavailableReason: !supported ? 'No verified rate for this exact model.' : attempts && !priced ? 'Input/output usage was not reported.' : undefined,
  };
}

const number = (value: number | null): string => value === null ? 'not reported' : value.toLocaleString('en-US');
export function usageText(analysis: Analysis, model?: string): string {
  const usage = summarizeUsage(analysis, model);
  const incomplete = usage.pricedAttempts < usage.generationAttempts;
  const cost = usage.estimatedCostUsd === null ? `Unavailable. ${usage.unavailableReason}`
    : `$${usage.estimatedCostUsd.toFixed(4)} USD${incomplete ? ` (incomplete: ${usage.pricedAttempts}/${usage.generationAttempts} attempts priced)` : ''}`;
  return `### Token usage and estimated cost (this run)\n\n`
    + `| Metric | Value |\n| --- | ---: |\n`
    + `| Generation attempts, including retries | ${usage.generationAttempts} |\n`
    + `| Total known generation tokens | ${number(usage.totalTokens)} |\n`
    + `| Input tokens | ${number(usage.inputTokens)} |\n`
    + `| Output tokens, including thinking | ${number(usage.outputTokens)} |\n`
    + `| Thinking tokens (included above, when reported) | ${number(usage.thoughtsTokens)} |\n`
    + `| Attempts without total usage | ${usage.unreportedAttempts} |\n`
    + `| Estimated API cost | ${cost} |\n\n`
    + `Usage totals cover ${usage.reportedAttempts}/${usage.generationAttempts} attempts; input/output covers ${usage.componentAttempts}/${usage.generationAttempts}; thinking covers ${usage.thoughtsReportedAttempts}/${usage.generationAttempts}. Unknown usage is excluded, not zero.\n\n`
    + `Model: ${usage.model || 'not captured'}. [Rates checked ${pricingChecked}](${pricingSource}). ${usage.pricingBasis}\n\n`
    + `Admission budget charged: ${number(analysis.usage.charged)} tokens; unknown-usage reservations: ${analysis.usage.unknown}. This is a scheduling ledger, not token consumption or dollars.\n`;
}
