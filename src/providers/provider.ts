import type { Task, Inventory, LookupResult } from '../contracts.js';
import { reviewPrompt, integrationPrompt } from '../prompts.js';
import { wireSchema } from '../review/schema.js';
import type { Rules } from '../source/rules.js';
import { project, protocolVersion, type RepairFeedback } from './projection.js';
import { hash } from '../util.js';

export type Request = {
  model: string; systemInstruction: { parts: Array<{ text: string }> };
  contents: Array<{ role: 'user'; parts: Array<{ text: string }> }>;
  generationConfig: { candidateCount: number; temperature: number; maxOutputTokens: number;
    thinkingConfig: { thinkingBudget: number }; responseMimeType: string; responseJsonSchema: unknown };
};
export type Generation = { text: string; finishReason: string; usage?: { totalTokenCount?: number; promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number } };
export interface Provider {
  count(request: Request, signal: AbortSignal): Promise<number>;
  generateOnce(request: Request, signal: AbortSignal): Promise<Generation>;
}
export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs = 0) { super(message); }
}
export function requestFor(task: Task, inventory: Inventory, rules: Rules, model: string, output: number, compact = false, lookups: LookupResult[] = []): Request {
  return prepareRequest(task, inventory, rules, model, output, compact, lookups).request;
}
export function prepareRequest(task: Task, inventory: Inventory, rules: Rules, model: string, output: number, compact = false, lookups: LookupResult[] = [], feedback?: RepairFeedback) {
  const { payload, binding, identity } = project(task, inventory, lookups);
  // Stable trusted-order rules precede varying task data, without promoting rules to system instructions.
  const input = { rules: rules.files, protocolVersion, requestId: '', ...payload, ...feedback ? { repair: feedback } : {} };
  const request: Request = {
    model: model.startsWith('models/') ? model : `models/${model}`,
    systemInstruction: { parts: [{ text: reviewPrompt + (task.kind === 'integration' ? '\n' + integrationPrompt : '') }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
    generationConfig: { candidateCount: 1, temperature: 0.2, maxOutputTokens: output,
      thinkingConfig: { thinkingBudget: compact ? 8192 : -1 }, responseMimeType: 'application/json', responseJsonSchema: wireSchema },
  };
  binding.requestId = hash([identity, request]).slice(0, 24);
  input.requestId = binding.requestId;
  request.contents[0]!.parts[0]!.text = JSON.stringify(input);
  return { request, binding };
}
