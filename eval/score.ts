import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { fixtures, type Fixture } from './fixtures.js';
import type { Trial } from './run.js';
export type Assessment = { trialId: string; findingIndex: number; valid: boolean; severityCorrect: boolean; matchedGoldIds: string[]; assessor: string; disputed: boolean; secondAssessor?: string; resolved?: boolean };
const assessmentSchema = z.array(z.object({ trialId: z.string(), findingIndex: z.number().int().nonnegative(), valid: z.boolean(), severityCorrect: z.boolean(),
  matchedGoldIds: z.array(z.string()), assessor: z.string().min(1), disputed: z.boolean(), secondAssessor: z.string().min(1).optional(), resolved: z.boolean().optional() }));
const ratio = (n: number, d: number): number | null => d ? n / d : null;
const percentile = (values: number[], p: number): number | null => values.length ? [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * p) - 1)]! : null;
export function score(trials: Trial[], corpus: Fixture[], assessments: Assessment[]) {
  const index = new Map(assessments.map(a => [`${a.trialId}:${a.findingIndex}`, a]));
  if (index.size !== assessments.length) throw new Error('Duplicate assessments');
  for (const item of assessments) {
    const trial = trials.find(t => t.id === item.trialId);
    if (!trial || !trial.findings[item.findingIndex]) throw new Error('Assessment references an unknown finding');
    if (item.matchedGoldIds.some(id => !corpus.find(f => f.id === trial.fixture)?.gold.some(g => g.id === id))) throw new Error('Assessment references foreign gold IDs');
    if (!item.valid && item.matchedGoldIds.length) throw new Error('Invalid findings cannot count toward recall');
  }
  return Object.fromEntries((['v1', 'v2'] as const).map(variant => {
    const group = trials.filter(t => t.variant === variant); let delivered = 0; let valid = 0; let high = 0; let highValid = 0; let severityCorrect = 0; let unknown = 0; let known = 0; let recalled = 0; let clean = 0; let alarms = 0;
    for (const trial of group) {
      const fixture = corpus.find(f => f.id === trial.fixture); if (!fixture) throw new Error('Unknown evaluation fixture');
      known += fixture.gold.length; const matched = new Set<string>();
      if (fixture.category === 'clean') { clean++; if (trial.findings.length) alarms++; }
      trial.findings.forEach((finding, i) => {
        delivered++; const isHigh = ['critical', 'high'].includes(finding.severity); if (isHigh) high++;
        const assessment = index.get(`${trial.id}:${i}`);
        if (!assessment || assessment.disputed && (!assessment.resolved || !assessment.secondAssessor || assessment.secondAssessor === assessment.assessor)) { unknown++; return; }
        if (assessment.valid) {
          valid++; if (assessment.severityCorrect) { severityCorrect++; if (isHigh) highValid++; }
          assessment.matchedGoldIds.forEach(id => matched.add(id));
        }
      });
      recalled += matched.size;
    }
    const usage = group.reduce((sum, t) => ({ attempts: sum.attempts + t.usage.attempts, charged: sum.charged + t.usage.charged, unknown: sum.unknown + t.usage.unknown }), { attempts: 0, charged: 0, unknown: 0 });
    const comparisons = group.flatMap(t => {
      const attempt = z.object({ preflight: z.number(), promptTokenCount: z.number() });
      const v2 = z.object({ attempts: z.array(z.unknown()) }).safeParse(t.raw);
      const v1 = z.object({ preflight: z.number(), usage: z.object({ promptTokenCount: z.number() }) }).safeParse(t.raw);
      const rows = variant === 'v2' && v2.success ? v2.data.attempts : v1.success ? [{ preflight: v1.data.preflight, promptTokenCount: v1.data.usage.promptTokenCount }] : [];
      return rows.flatMap(row => { const parsed = attempt.safeParse(row); return parsed.success ? [parsed.data.promptTokenCount - parsed.data.preflight] : []; });
    });
    return [variant, { trials: group.length, completed: group.filter(t => t.status === 'complete').length,
      deliveredFindings: delivered, validFindings: valid, unassessedOrDisputed: unknown,
      allDeliveredPrecision: unknown ? null : ratio(valid, delivered), highCritical: { delivered: high, correct: highValid, precision: unknown ? null : ratio(highValid, high) },
      severityCorrectness: unknown ? null : ratio(severityCorrect, delivered),
      knownDefectRecall: unknown ? null : ratio(recalled, known), knownDefects: known, recalledDefects: recalled,
      cleanFalseAlarmRate: ratio(alarms, clean), cleanTrials: clean, cleanAlarms: alarms,
      changedRangeCoverage: variant === 'v1' ? null : ratio(group.reduce((n,t) => n+(t.coverage?.completed ?? 0),0), group.reduce((n,t) => n+(t.coverage?.total ?? 0),0)),
      usage, tokenCountComparison: { samples: comparisons.length, meanActualMinusPreflight: comparisons.length ? comparisons.reduce((n,d) => n+d,0) / comparisons.length : null, maxActualMinusPreflight: comparisons.length ? Math.max(...comparisons) : null },
      medianMs: percentile(group.map(t => t.elapsedMs), .5), p95Ms: percentile(group.map(t => t.elapsedMs), .95),
      bySize: Object.fromEntries(['small','medium','large'].map(size => {
        const sized = group.filter(t => { const count = trials.find(v => v.fixture === t.fixture && v.trial === t.trial && v.variant === 'v2')?.coverage?.total ?? 0; return (count <= 25 ? 'small' : count <= 250 ? 'medium' : 'large') === size; });
        return [size, { trials: sized.length, medianMs: percentile(sized.map(t => t.elapsedMs), .5), p95Ms: percentile(sized.map(t => t.elapsedMs), .95) }];
      })),
    }];
  }));
}
// Keep importable scoring pure; the CLI entry point is separate.
export async function scoreCLI(): Promise<void> {
  const { values } = parseArgs({ options: { directory: { type: 'string', default: 'eval-results' }, assessments: { type: 'string' } } });
  if (!values.assessments) throw new Error('Provide --assessments path to blind human labels');
  const suite = JSON.parse(await readFile(`${values.directory}/suite.json`, 'utf8'));
  if (suite.mocked) throw new Error('Mocked trials cannot establish model quality');
  const reports: Trial[] = await Promise.all(suite.trials.map(async (t: { id: string }) => JSON.parse(await readFile(`${values.directory}/${t.id}.json`, 'utf8'))));
  const labels = assessmentSchema.parse(JSON.parse(await readFile(values.assessments, 'utf8')));
  const metrics = score(reports, await fixtures(), labels);
  const v1 = metrics.v1!; const v2 = metrics.v2!;
  const conclusive = v1.allDeliveredPrecision !== null && v2.allDeliveredPrecision !== null && v1.knownDefectRecall !== null && v2.knownDefectRecall !== null && v2.highCritical.precision !== null;
  const observedTargetsMet = conclusive && v2.allDeliveredPrecision! >= v1.allDeliveredPrecision! && v2.knownDefectRecall! >= v1.knownDefectRecall! && v2.highCritical.precision! >= .9;
  const report = { metrics, observedTargetsMet, qualityGate: 'requires human review of sample sufficiency and context/batching improvement',
    pairedCostComparison: 'Not claimed. v1 supplies no auditable changed-range completion contract; select paired comparable-coverage cases before cost conclusions.',
    notes: ['Failed and omitted reviews remain in recall denominators.', 'Valid novel findings may have no matched gold IDs.', 'Zero delivered findings gives null precision, never 100%.'] };
  await writeFile(`${values.directory}/metrics.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
