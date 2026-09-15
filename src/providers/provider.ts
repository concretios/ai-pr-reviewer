import type { Task, Inventory, LookupResult } from '../contracts.js';
import { obligations } from '../contracts.js';
import { reviewPrompt, integrationPrompt } from '../prompts.js';
import { wireSchema } from '../review/schema.js';
import type { Rules } from '../source/rules.js';

export type Request = {
  model: string; systemInstruction: { parts: Array<{ text: string }> };
  contents: Array<{ role: 'user'; parts: Array<{ text: string }> }>;
  generationConfig: { candidateCount: number; temperature: number; maxOutputTokens: number;
    thinkingConfig: { thinkingBudget: number }; responseMimeType: string; responseJsonSchema: unknown };
};
export type Generation = { text: string; finishReason: string; usage?: { totalTokenCount?: number; promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } };
export interface Provider {
  count(request: Request, signal: AbortSignal): Promise<number>;
  generateOnce(request: Request, signal: AbortSignal): Promise<Generation>;
}
export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs = 0) { super(message); }
}
export function requestFor(task: Task, inventory: Inventory, rules: Rules, model: string, output: number, compact = false, lookups: LookupResult[] = []): Request {
  return {
    model: model.startsWith('models/') ? model : `models/${model}`,
    systemInstruction: { parts: [{ text: reviewPrompt + (task.kind === 'integration' ? '\n' + integrationPrompt : '') }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify({ taskId: task.id, kind: task.kind,
      expectedIds: obligations(task),
      atoms: inventory.atoms.filter(a => task.kind === 'review' ? task.atomIds.includes(a.id) : inventory.relations.some(r => task.relationIds.includes(r.id) && r.atomIds.includes(a.id))),
      relations: inventory.relations.filter(r => task.kind === 'integration' ? task.relationIds.includes(r.id) : r.atomIds.every(id => task.atomIds.includes(id))),
      evidence: task.evidenceIds.map(id => inventory.evidence.get(id)), rules: rules.files, lookups,
    }) }] }],
    generationConfig: { candidateCount: 1, temperature: 0.2, maxOutputTokens: output,
      thinkingConfig: { thinkingBudget: compact ? 8192 : -1 }, responseMimeType: 'application/json', responseJsonSchema: wireSchema },
  };
}
