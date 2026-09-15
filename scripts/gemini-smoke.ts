import { parseArgs } from 'node:util';
import { Gemini } from '../src/providers/gemini.js';
import { requestFor } from '../src/providers/provider.js';
import { decode, validateFindings } from '../src/review/validate.js';
import { limits } from '../src/config.js';
import type { Inventory, ReviewTask } from '../src/contracts.js';

// Explicit paid contract check. Synthetic source only; no GitHub writes.
const { values } = parseArgs({ options: { model: { type: 'string', default: 'gemini-2.5-flash' } } });
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error('Set GEMINI_API_KEY to run the paid Gemini contract smoke test.');
const task: ReviewTask = { kind: 'review', id: 'contract-smoke', lineageId: 'contract-smoke', atomIds: ['a0'], evidenceIds: ['e0'] };
const text = 'export const answer = 42;';
const inventory: Inventory = {
  atoms: [{ id: 'a0', path: 'example.ts', oldPath: 'example.ts', side: 'RIGHT', start: 1, end: 1, text, evidenceIds: ['e0'], priority: 2 }],
  evidence: new Map([['e0', { id: 'e0', path: 'example.ts', revision: 'b'.repeat(40), blobId: 'b'.repeat(40), side: 'RIGHT', start: 1, end: 1, text }]]),
  relations: [], omissions: [],
};
const request = requestFor(task, inventory, { files: [], notices: [], hash: 'synthetic' }, values.model!, limits('auto').output);
const provider = new Gemini(key);
const signal = AbortSignal.timeout(120000);
const counted = await provider.count(request, signal);
const response = await provider.generateOnce(request, signal);
if (response.finishReason !== 'STOP') throw new Error(`Contract smoke failed: ${response.finishReason}`);
const decoded = decode(response.text, task);
if (decoded.kind !== 'result') throw new Error('Contract smoke expected a result for fully supplied synthetic source.');
if (validateFindings(decoded.findings, task, inventory).diagnostics.length) throw new Error('Contract smoke returned invalid evidence.');
console.log(JSON.stringify({ model: values.model, counted, finishReason: response.finishReason, responseKind: decoded.kind,
  expectedIdsValidated: true, usage: response.usage }, null, 2));
