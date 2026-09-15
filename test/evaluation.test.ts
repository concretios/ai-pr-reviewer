import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fixtures, materialize, fixtureRules } from '../eval/fixtures.js';
import { Snapshot } from '../src/source/snapshot.js';
import { readRules } from '../src/source/rules.js';
import { settings } from './helpers.js';
import { score } from '../eval/score.js';
import { manifest } from './helpers.js';
import type { Trial } from '../eval/run.js';

describe('evaluation integrity', () => {
  it('pins 30 source cases with ten development and twenty held out', async () => {
    const cases = await fixtures(); expect(cases).toHaveLength(30);
    expect(cases.filter(f => f.split === 'held-out')).toHaveLength(20);
    for (const category of ['clean', 'local', 'context']) expect(cases.filter(f => f.category === category)).toHaveLength(10);
    for (const fixture of cases) { expect(fixture.baseSha).toMatch(/^[0-9a-f]{40}$/); expect(fixture.headSha).toMatch(/^[0-9a-f]{40}$/); }
    const material = await materialize(cases[0]!);
    try {
      expect(material.baseSha).toBe(cases[0]!.baseSha);
      const snapshot = await Snapshot.capture({ ...manifest, baseSha: material.baseSha, headSha: material.headSha }, material.directory, AbortSignal.timeout(10000));
      try { expect(fixtureRules(cases[0]!).hash).toBe((await readRules(snapshot, settings)).hash); }
      finally { await snapshot.dispose(); }
    } finally { await material.dispose(); }
  });
  it('freezes the original historical comparison and million-character regression', async () => {
    const data = JSON.parse(await readFile(new URL('./fixtures/trace-pr29.json', import.meta.url), 'utf8'));
    expect(data.headSha).toBe('fd1e44149a5a52687dc0e31f44485e316a947d39'); expect(data.changedFiles).toBe(67); expect(data.reportedOriginalPromptCharacters).toBe(1042368); expect(data.diagnosticOnly).toBe(true);
    const baseline = await readFile(new URL('../eval/baseline-v1/scripts/post-review.sh', import.meta.url), 'utf8');
    expect(baseline).toContain('POST_INLINE'); // frozen source remains reviewable independently of v2
  });
  it('keeps failed reviews in recall and does not call zero findings perfect precision', async () => {
    const corpus = await fixtures(); const fixture = corpus.find(f => f.category === 'local')!;
    const trial: Trial = { id: 'trial', fixture: fixture.id, variant: 'v2', trial: 1, mocked: false, manifest, status: 'incomplete', findings: [], elapsedMs: 1,
      usage: { attempts: 1, charged: 64768, unknown: 1 }, coverage: { completed: 0, total: 2 } };
    const metrics = score([trial], corpus, []).v2!;
    expect(metrics.knownDefectRecall).toBe(0); expect(metrics.allDeliveredPrecision).toBeNull(); expect(metrics.highCritical.precision).toBeNull(); expect(metrics.usage.charged).toBe(64768);
  });
  it('accepts valid novel findings and requires another assessor for disputes', async () => {
    const corpus = await fixtures(); const fixture = corpus.find(f => f.category === 'local')!;
    const trial: Trial = { id: 'trial', fixture: fixture.id, variant: 'v2', trial: 1, mocked: false, manifest, status: 'complete', findings: [{ severity: 'high', title: 'Novel', description: 'Source-backed novel concern' }], elapsedMs: 1, usage: { attempts: 1, charged: 100, unknown: 0 }, coverage: { completed: 2, total: 2 } };
    const label = { trialId: trial.id, findingIndex: 0, valid: true, severityCorrect: true, matchedGoldIds: [], assessor: 'alice', disputed: true };
    expect(score([trial], corpus, [label]).v2!.allDeliveredPrecision).toBeNull();
    expect(score([trial], corpus, [{ ...label, secondAssessor: 'bob', resolved: true }]).v2!.allDeliveredPrecision).toBe(1);
  });
});
