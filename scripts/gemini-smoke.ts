import { parseArgs } from 'node:util';
import { Gemini } from '../src/providers/gemini.js';
import { prepareRequest } from '../src/providers/provider.js';
import { decodeCompact, validateFindings } from '../src/review/validate.js';
import { limits } from '../src/config.js';
import type { Inventory, Task } from '../src/contracts.js';

async function main() {
// Explicit functional API checks, with synthetic source and no GitHub writes.
const { values } = parseArgs({ options: { model: { type: 'string', default: 'gemini-2.5-flash' }, scenario: { type: 'string', default: 'all' } } });
if (!['all', 'result', 'context'].includes(values.scenario!)) throw new Error('scenario must be all, result or context');
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error('Set GEMINI_API_KEY to run the paid Gemini contract smoke test.');
const provider = new Gemini(key);
for (const scenario of values.scenario === 'all' ? ['result', 'context'] : [values.scenario]) {
  const text = scenario === 'result' ? 'export const answer = 42;' : 'export const allowed = authorize(request);';
  const inventory: Inventory = {
    atoms: [{ id: 'stable-atom', path: 'example.ts', oldPath: 'example.ts', side: 'RIGHT', start: 1, end: 1, text, evidenceIds: ['stable-evidence'], priority: 2 }],
    evidence: new Map([['stable-evidence', { id: 'stable-evidence', path: 'example.ts', revision: 'b'.repeat(40), blobId: 'b'.repeat(40), side: 'RIGHT', start: 1, end: 1, text }]]),
    relations: [], omissions: [],
  };
  const task: Task = scenario === 'result'
    ? { kind: 'review', id: 'contract-result', lineageId: 'contract-result', atomIds: ['stable-atom'], evidenceIds: ['stable-evidence'] }
    : { kind: 'integration', id: 'contract-context', lineageId: 'contract-context', relationIds: ['stable-relation'], evidenceIds: ['stable-evidence'] };
  if (scenario === 'context') inventory.relations.push({ id: 'stable-relation', atomIds: ['stable-atom'], evidenceIds: ['stable-evidence'],
    question: 'Does authorize(request) reject disabled accounts? Its definition is essential but absent from the supplied context. Request the authorize definition with a literal search on RIGHT before answering; do not infer its implementation.' });
  const { request, binding } = prepareRequest(task, inventory, { files: [], notices: [], hash: 'synthetic' }, values.model!, limits('auto').output);
  const signal = AbortSignal.timeout(120000);
  const counted = await provider.count(request, signal);
  const response = await provider.generateOnce(request, signal);
  if (response.finishReason !== 'STOP') throw new Error(`Contract smoke failed: ${response.finishReason}`);
  const decoded = decodeCompact(response.text, task, binding);
  const expected = scenario === 'result' ? 'result' : 'context_request';
  if (decoded.kind !== expected) throw new Error(`Contract smoke expected ${expected}, got ${decoded.kind}`);
  if (decoded.kind === 'result' && validateFindings(decoded.findings, task, inventory).diagnostics.length) throw new Error('Contract smoke returned invalid evidence.');
  console.log(JSON.stringify({ scenario, model: values.model, counted, finishReason: response.finishReason, responseKind: decoded.kind,
    requestIdentityValidated: true, expectedIdsValidated: decoded.kind === 'result', usage: response.usage }, null, 2));
}

}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Smoke failed"); process.exitCode = 1; });
