import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { Snapshot } from '../src/source/snapshot.js';
import { inventory } from '../src/source/diff.js';
import { readRules } from '../src/source/rules.js';
import { resolveSettings, limits } from '../src/config.js';
import { addRelationships, lookup } from '../src/source/context.js';
import { runReview } from '../src/runtime/runner.js';
import { baselineRequest } from './baseline.js';
import { hash } from '../src/util.js';
import { reviewPrompt, integrationPrompt } from '../src/prompts.js';
import { wireSchema } from '../src/review/schema.js';
import { sourceRevision } from './provenance.js';
const fixture = JSON.parse(await readFile(new URL('../test/fixtures/trace-pr29.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: { 'mock-analysis': { type: 'boolean', default: false } } });
const exec = promisify(execFile);
let token = process.env.GITHUB_TOKEN;
if (!token) { try { token = (await exec('gh', ['auth', 'token'])).stdout.trim(); } catch { /* public fetch remains available */ } }
const signal = AbortSignal.timeout(300000);
const snapshot = await Snapshot.capture({ ...fixture, repositoryId: fixture.repositoryId }, `https://github.com/${fixture.repository}.git`, signal, token);
try {
  if (snapshot.mergeBaseSha !== fixture.mergeBaseSha) throw new Error('Historical merge-base mismatch');
  await snapshot.fetch(`https://github.com/${fixture.repository}.git`, [fixture.historicalCheckoutSha]);
  const settings = resolveSettings((await snapshot.read(fixture.baseSha, '.ai-review.yml'))?.text, {});
  const rules = await readRules(snapshot, settings);
  const source = await inventory(snapshot);
  const baseline = await baselineRequest(snapshot, rules, fixture.historicalCheckoutSha);
  if (baseline.changedFiles !== fixture.changedFiles) throw new Error(`Historical file count mismatch: ${baseline.changedFiles}`);
  const manifest = { ...snapshot.identity, mergeBaseSha: snapshot.mergeBaseSha, actionRevision: await sourceRevision(), model: settings.model,
    configurationHash: hash(settings), ruleHash: rules.hash, promptHash: hash([reviewPrompt, integrationPrompt]), schemaHash: hash(wireSchema), evidenceBlobs: Object.fromEntries(snapshot.consumed) };
  await mkdir('eval-results/trace-pr29', { recursive: true });
  if (values['mock-analysis']) {
    await addRelationships(snapshot, source);
    let countCalls = 0;
    const analysis = await runReview({ inventory: source, rules, model: settings.model, limits: limits('auto'), signal,
      lookup: (request, signal) => lookup(snapshot, request, signal), provider: {
        count: async request => { countCalls++; return Math.ceil(JSON.stringify(request).length / 4); },
        generateOnce: async request => {
          const input = JSON.parse(request.contents[0]!.parts[0]!.text);
          return { finishReason: 'STOP', text: JSON.stringify({ kind: 'result', protocolVersion: input.protocolVersion, requestId: input.requestId,
            reviewedIds: input.expectedIds, unresolved: [], findings: [] }),
            usage: { totalTokenCount: Math.ceil(JSON.stringify(request).length / 4) + 100 } };
        },
      } });
    manifest.evidenceBlobs = Object.fromEntries(snapshot.consumed);
    await writeFile('eval-results/trace-pr29/mock-analysis.json', JSON.stringify({ mocked: true, approximateTokenCounter: true, countCalls, analysis }, null, 2));
    console.log(`Mocked analysis: ${analysis.status}, ${analysis.usage.attempts} generations, ${countCalls} count calls. This is harness evidence only.`);
  }
  await writeFile('eval-results/trace-pr29/manifest.json', JSON.stringify(manifest, null, 2));
  await writeFile('eval-results/trace-pr29/replay.json', JSON.stringify({ diagnosticOnly: true, publish: false, modelCalls: 0, manifest: './manifest.json',
    reportedOriginalPromptCharacters: fixture.reportedOriginalPromptCharacters, replayPromptCharacters: baseline.promptCharacters,
    limitation: 'Default v1 input/metadata reconstruction is diagnostic; exact original prompt bytes require original workflow inputs and PR metadata.',
    changedFiles: baseline.changedFiles, eligibleAtoms: source.atoms.length, eligibleChangedLines: source.atoms.reduce((n, a) => n + a.end - a.start + 1, 0), omissions: source.omissions }, null, 2));
  const workflows = [...(await snapshot.tree(fixture.historicalCheckoutSha)).keys()].filter(p => p.startsWith('.github/workflows/') && /review|gemini/i.test(p));
  await writeFile('eval-results/trace-pr29/historical-workflows.json', JSON.stringify(await Promise.all(workflows.map(async path => ({ path, source: await snapshot.read(fixture.historicalCheckoutSha, path) }))), null, 2));
  console.log(`Replayed original PR #29: ${baseline.changedFiles} files, ${source.atoms.length} eligible ranges. No model calls or publication. See eval-results/trace-pr29.`);
} finally { await snapshot.dispose(); }
