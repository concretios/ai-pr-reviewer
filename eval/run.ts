import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fixtures, materialize, fixtureRules } from './fixtures.js';
import { Snapshot } from '../src/source/snapshot.js';
import { inventory } from '../src/source/diff.js';
import { addRelationships, lookup } from '../src/source/context.js';
import { readRules } from '../src/source/rules.js';
import { resolveSettings, limits } from '../src/config.js';
import { Gemini } from '../src/providers/gemini.js';
import { runReview } from '../src/runtime/runner.js';
import { Budget } from '../src/runtime/budget.js';
import { ProviderError, type Provider, type Generation } from '../src/providers/provider.js';
import { bounded, hash, message, delay } from '../src/util.js';
import { baselineRequest } from './baseline.js';
import { reviewPrompt, integrationPrompt } from '../src/prompts.js';
import { wireSchema } from '../src/review/schema.js';
import { sourceRevision } from './provenance.js';
import type { Manifest, Analysis } from '../src/contracts.js';
import { z } from 'zod';

export type Trial = { id: string; fixture: string; variant: 'v1' | 'v2'; trial: number; mocked: boolean; manifest: Manifest; status: string;
  findings: Array<{ severity: string; title: string; description: string }>; elapsedMs: number; usage: { attempts: number; charged: number; unknown: number };
  coverage: { completed: number; total: number } | null; raw?: unknown; error?: string };
const { values } = parseArgs({ options: { suite: { type: 'string', default: 'smoke' }, publish: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
if (values.publish !== 'false') throw new Error('Evaluation is diagnostic only. Pass --publish=false.');
if (!['smoke', 'release'].includes(values.suite)) throw new Error('suite must be smoke or release');
if (!values['dry-run'] && !process.env.GEMINI_API_KEY) throw new Error('Manual paid evaluation requires GEMINI_API_KEY. Use --dry-run for provenance-only mocked smoke testing.');
const suite = values.suite; const mocked = values['dry-run'];
const selected = (await fixtures()).filter(f => f.split === (suite === 'smoke' ? 'development' : 'held-out'));
const destination = mocked ? 'eval-results/mock' : 'eval-results';
await mkdir(`${destination}/blind`, { recursive: true });
const suiteLimits = { ...limits('auto'), attempts: suite === 'smoke' ? 120 : 720, tokens: suite === 'smoke' ? 2000000 : 12000000 };
const suiteLedger = new Budget(suiteLimits); const suiteSignal = AbortSignal.timeout(suite === 'smoke' ? 30 * 60000 : 110 * 60000);
const gemini = new Gemini(process.env.GEMINI_API_KEY ?? 'mock');
const revision = await sourceRevision();
const baselinePromptHash = hash(await readFile(new URL('./baseline-v1/prompts/code-review.md', import.meta.url), 'utf8'));
const baselineWire = JSON.parse(await readFile(new URL('./baseline-v1/schemas/review-output.json', import.meta.url), 'utf8')); delete baselineWire.$schema;
const baselineSchemaHash = hash(baselineWire);
const reports: Trial[] = [];
const baselineSchema = z.object({ summary: z.string(), verdict: z.enum(['approve', 'comment', 'request_changes']), findings: z.array(z.object({ severity: z.enum(['critical', 'high', 'medium', 'low']), title: z.string(), comment: z.string(), file: z.string(), line: z.number(), category: z.string() })) });
async function generation(work: () => Promise<Generation>, signal: AbortSignal, reservation?: number): Promise<Generation> {
  signal.throwIfAborted();
  const ticket = suiteLedger.reserve(reservation); if (!ticket) throw new ProviderError('Suite admission budget exhausted', false);
  try { const result = await bounded(work(), signal); suiteLedger.settle(ticket, result.usage?.totalTokenCount); return result; }
  catch (error) { suiteLedger.settle(ticket); throw error; }
}
const provider: Provider = {
  count: (request, signal) => mocked ? Promise.resolve(Math.ceil(JSON.stringify(request).length / 4)) : gemini.count(request, signal),
  generateOnce: (request, signal) => generation(async () => {
    if (!mocked) return gemini.generateOnce(request, signal);
    const input = JSON.parse(request.contents[0]!.parts[0]!.text);
    return { finishReason: 'STOP', text: JSON.stringify({ kind: 'result', taskId: input.taskId, items: input.expectedIds.map((id: string) => ({ id, status: 'reviewed', reason: 'Mocked harness test, not model-quality evidence' })), findings: [] }), usage: { totalTokenCount: 100 } };
  }, signal),
};
try {
  for (const fixture of selected) {
    const material = await materialize(fixture);
    try {
      for (let trial = 1; trial <= (suite === 'release' ? 3 : 1); trial++) {
        // Paired order is frozen but alternates to avoid always testing v1 first.
        const variants: Array<'v1' | 'v2'> = parseInt(hash([fixture.id, trial]).slice(0, 2), 16) % 2 ? ['v2', 'v1'] : ['v1', 'v2'];
        for (const variant of variants) {
          const start = Date.now(); const signal = AbortSignal.any([suiteSignal, AbortSignal.timeout(300000)]);
          const settings = resolveSettings(undefined, {});
          const manifest: Manifest = { repository: `fixtures/${fixture.id}`, repositoryId: 0, prNumber: 1, baseRef: 'main', baseSha: material.baseSha, headSha: material.headSha,
            mergeBaseSha: material.baseSha, actionRevision: variant === 'v1' ? '510a61aad69d2c82319057d8db510dae35a54848' : revision,
            model: settings.model, configurationHash: hash(variant === 'v1' ? { ...settings, max_files: 20, max_diff_size: 10000, context_depth: 'changed-files', output_limit: 16384 } : settings),
            ruleHash: fixtureRules(fixture).hash, promptHash: variant === 'v1' ? baselinePromptHash : hash([reviewPrompt, integrationPrompt]),
            schemaHash: variant === 'v1' ? baselineSchemaHash : hash(wireSchema), evidenceBlobs: {} };
          const report: Trial = { id: hash([fixture.id, trial, variant, revision]).slice(0, 24), fixture: fixture.id, variant, trial, mocked, manifest,
            status: 'incomplete', findings: [], elapsedMs: 0, usage: { attempts: 0, charged: 0, unknown: 0 }, coverage: variant === 'v2' ? { completed: 0, total: fixture.eligibleAtoms ?? 0 } : null };
          const before = suiteLedger.snapshot(); let snapshot: Snapshot | undefined;
          try {
            signal.throwIfAborted();
            if (before.attempts >= suiteLimits.attempts || before.charged + suiteLimits.input + suiteLimits.output > suiteLimits.tokens) throw new Error('Suite budget exhausted before trial');
            snapshot = await Snapshot.capture(manifest, material.directory, signal);
            const rules = await readRules(snapshot, settings); manifest.ruleHash = rules.hash;
            if (variant === 'v2') {
              const source = await inventory(snapshot); await addRelationships(snapshot, source);
              const analysis: Analysis = await runReview({ inventory: source, rules, provider, model: settings.model,
                limits: { ...limits('auto'), durationMs: 300000, reserveMs: 10000 }, startedAt: start, signal, lookup: (req, signal) => lookup(snapshot!, req, signal) });
              report.status = analysis.status; report.raw = analysis;
              report.findings = analysis.findings.map(f => ({ severity: f.severity, title: f.title, description: `${f.changedBehavior}\n${f.trigger}\n${f.consequence}` }));
              report.coverage = { completed: Object.values(analysis.atoms).filter(a => a.status === 'reviewed').length, total: Object.keys(analysis.atoms).length };
            } else {
              const request = await baselineRequest(snapshot, rules); manifest.promptHash = request.promptHash; manifest.schemaHash = request.schemaHash;
              const model = `models/${settings.model}`;
              const counted = mocked ? Math.ceil(JSON.stringify(request.body).length / 4) : await bounded(gemini.countRaw(model, { model, ...request.body }, signal), signal);
              // The frozen baseline's large requests are not misreported as zero-cost successes.
              if (counted + 16384 > 500000) throw new Error('Baseline exceeds fixture admission budget');
              const baselineLedger = new Budget({ ...limits('auto'), input: Math.max(counted, suiteLimits.input), output: 16384, attempts: 3 });
              for (let attempt = 0; attempt < 3; attempt++) {
                const ticket = baselineLedger.reserve(); if (!ticket) throw new Error('Baseline fixture budget exhausted');
                try {
                  const generated = await generation(() => mocked ? Promise.resolve({ finishReason: 'STOP', text: JSON.stringify({ summary: 'Mock', verdict: 'comment', findings: [] }), usage: { totalTokenCount: 100 } })
                    : gemini.generateRawOnce(model, request.body, AbortSignal.any([signal, AbortSignal.timeout(120000)])), signal, counted + 16384);
                  baselineLedger.settle(ticket, generated.usage?.totalTokenCount);
                  report.raw = { ...generated, preflight: counted };
                  if (generated.finishReason !== 'STOP') throw new Error(`Baseline unsuccessful generation: ${generated.finishReason}`);
                  const decoded = baselineSchema.parse(JSON.parse(generated.text));
                  report.findings = decoded.findings.map(f => ({ severity: f.severity, title: f.title, description: f.comment })); report.status = 'complete'; break;
                } catch (error) {
                  baselineLedger.settle(ticket);
                  if (!(error instanceof ProviderError && error.retryable) || attempt === 2) throw error;
                  await delay(Math.max(5000 * 2 ** attempt, error.retryAfterMs), signal);
                }
              }
            }
          } catch (error) { report.error = message(error); }
          finally {
            if (snapshot) { manifest.evidenceBlobs = Object.fromEntries(snapshot.consumed); await snapshot.dispose(); }
            report.elapsedMs = Date.now() - start;
            const after = suiteLedger.snapshot(); report.usage = { attempts: after.attempts - before.attempts, charged: after.charged - before.charged, unknown: after.unknown - before.unknown };
            reports.push(report);
            await writeFile(`${destination}/${report.id}.json`, JSON.stringify(report, null, 2));
            await writeFile(`${destination}/blind/${report.id}.json`, JSON.stringify({ id: report.id, fixture: fixture.id, findings: report.findings,
              instruction: 'Assess against pinned source. Label valid novel findings too; second assessor resolves disagreements. Variant is intentionally omitted.' }, null, 2));
            await writeFile(`${destination}/suite.json`, JSON.stringify({ suite, mocked, sourceRevision: revision, publication: 'disabled', budgets: suiteLimits,
              usage: suiteLedger.snapshot(), qualityGate: 'unassessed', trials: reports.map(r => ({ id: r.id, status: r.status, fixture: r.fixture, variant: r.variant })) }, null, 2));
          }
        }
      }
    } finally { await material.dispose(); }
  }
} finally { suiteLedger.close(); }
console.log(`${reports.length} ${mocked ? 'MOCKED' : 'model'} trials written to ${destination}. Human adjudication required; no quality claim made.`);
if (reports.some(r => r.status !== 'complete')) process.exitCode = 1;
