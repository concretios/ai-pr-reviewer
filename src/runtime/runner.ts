import type { Analysis, Inventory, Task, LookupResult, LookupRequest, Attempt } from '../contracts.js';
import { obligations } from '../contracts.js';
import type { Limits } from '../config.js';
import { Budget, ExecutionEpoch } from './budget.js';
import { ProviderError, requestFor, type Provider, type Request } from '../providers/provider.js';
import { fits, plan, splitTask } from '../planning/planner.js';
import { decode, findingId, validateFindings } from '../review/validate.js';
import type { Rules } from '../source/rules.js';
import { bounded, delay, hash, message, unique, Superseded } from '../util.js';

type Allowances = { invalid: boolean; transport: boolean; compact: boolean; lookup: boolean };
export type RunnerOptions = {
  inventory: Inventory; rules: Rules; provider: Provider; model: string; limits: Limits;
  startedAt?: number; signal?: AbortSignal; lookup: (request: LookupRequest, signal: AbortSignal) => Promise<LookupResult>;
  onProgress?: (text: string) => void;
};
export function emptyAnalysis(): Analysis {
  return { status: 'skipped', analysisStatus: 'skipped', superseded: false, atoms: {}, relations: {}, findings: [], diagnostics: [], attempts: [], usage: { attempts: 0, charged: 0, reserved: 0, unknown: 0 } };
}
export function deriveReviewStatus(analysis: Analysis): Analysis['status'] {
  if (analysis.superseded) return 'superseded';
  const items = [...Object.values(analysis.atoms), ...Object.values(analysis.relations)];
  if (!items.length) return 'skipped';
  if (!items.some(i => i.status === 'reviewed')) return 'unavailable';
  return items.some(i => i.status !== 'reviewed') ? 'partial' : 'complete';
}
export async function runReview(options: RunnerOptions): Promise<Analysis> {
  const { inventory, rules, provider, model, limits } = options;
  const run = emptyAnalysis(); const ledger = new Budget(limits); const epoch = new ExecutionEpoch();
  const cutoff = (options.startedAt ?? Date.now()) + limits.durationMs - limits.reserveMs;
  const allowances = new Map<string, Allowances>(); const seen = new Set<string>();
  const continuation = new Map<string, { compact: boolean; context: LookupResult[] }>();
  const counts = new Map<string, number>();
  let planningTransportUsed = false;
  let queue: Task[] = [];
  const close = () => {
    if (options.signal?.aborted && options.signal.reason instanceof Superseded) run.superseded = true;
    epoch.close('Generation cutoff or cancellation'); ledger.close();
  };
  const timer = setTimeout(close, Math.max(0, cutoff - Date.now()));
  options.signal?.addEventListener('abort', close, { once: true });
  if (options.signal?.aborted || Date.now() >= cutoff) close();
  const open = () => epoch.isOpen() && Date.now() < cutoff;
  const allowed = (task: Task) => {
    let value = allowances.get(task.lineageId);
    if (!value) { value = { invalid: true, transport: !planningTransportUsed, compact: true, lookup: true }; allowances.set(task.lineageId, value); }
    return value;
  };
  const request = (task: Task, compact = false, context: LookupResult[] = []) => requestFor(task, inventory, rules, model, limits.output, compact, context);
  const count = async (req: Request): Promise<number> => {
    const key = hash(req); const cached = counts.get(key); if (cached !== undefined) return cached;
    const value = await bounded(provider.count(req, epoch.signal), epoch.signal);
    if (open()) counts.set(key, value);
    return value;
  };
  const planningCount = async (req: Request): Promise<number> => {
    try { return await count(req); }
    catch (error) {
      if (!open() || planningTransportUsed || !(error instanceof ProviderError && error.retryable)) throw error;
      planningTransportUsed = true;
      await delay(Math.max(250, Math.min(30000, error.retryAfterMs)), epoch.signal);
      return count(req);
    }
  };
  const unresolved = (task: Task, reason: string) => {
    if (!open()) return;
    const state = task.kind === 'review' ? run.atoms : run.relations;
    for (const id of obligations(task)) state[id] = { status: 'unresolved', reason };
    run.diagnostics.push({ taskId: task.id, reason, disposition: reason.includes('context') ? 'unresolved_missing_context' : undefined });
  };
  const recoverSplit = async (task: Task, parentCount: number, compact = false, context: LookupResult[] = []): Promise<boolean> => {
    const children = splitTask(task, inventory);
    if (!children.length) return false;
    const lookupEvidence = context.flatMap(result => result.evidence.map(e => e.id));
    for (const child of children) child.evidenceIds = unique([...child.evidenceIds, ...lookupEvidence]);
    const counts: number[] = [];
    for (const child of children) counts.push(await count(request(child, compact, context)));
    if (!open()) return false;
    // No split may reproduce the same counted request or unchanged obligation group.
    if (counts.some(c => c >= parentCount)) return false;
    for (const child of children) continuation.set(child.id, { compact, context });
    queue.unshift(...children);
    // A recovery split can turn a previously in-batch relationship into cross-batch work.
    // Preserve those obligations rather than claiming completion from the child atoms alone.
    if (task.kind === 'review') for (const relation of inventory.relations) {
      if (run.relations[relation.id] || !relation.atomIds.some(id => task.atomIds.includes(id))) continue;
      const id = `integration-${relation.id}-recovery`;
      run.relations[relation.id] = { status: 'pending', reason: 'Relationship crossed a recovery split' };
      queue.push({ kind: 'integration', id, lineageId: task.lineageId, relationIds: [relation.id], evidenceIds: relation.evidenceIds });
    }
    return true;
  };
  async function execute(task: Task, compact = false, context: LookupResult[] = []): Promise<void> {
    if (!open()) return;
    const allowance = allowed(task);
    try {
      const req = request(task, compact, context);
      const preflight = await count(req);
      if (!open()) return;
      if (!fits(preflight, limits.input)) {
        if (!await recoverSplit(task, preflight, compact, context)) unresolved(task, context.length ? 'Required context cannot fit within request ceiling' : 'Indivisible input cannot fit');
        return;
      }
      const ticket = ledger.reserve(preflight + limits.output);
      if (!ticket) { unresolved(task, 'Global token or generation-attempt budget exhausted'); return; }
      const attempt: Attempt = { taskId: task.id, preflight }; run.attempts.push(attempt);
      options.onProgress?.(`Reviewing ${task.kind} task, generation ${ledger.snapshot().attempts}/${limits.attempts}`);
      let generated;
      try {
        const signal = AbortSignal.any([epoch.signal, AbortSignal.timeout(Math.max(1, Math.min(120000, cutoff - Date.now())))]);
        generated = await bounded(provider.generateOnce(req, signal), signal);
      } catch (error) {
        if (!open()) return;
        ledger.settle(ticket); attempt.error = message(error);
        throw error instanceof ProviderError ? error : new ProviderError('Generation timeout; usage unknown', true);
      }
      if (!open()) return;
      // Record accounting and finish boundary before parsing application-level content.
      ledger.settle(ticket, generated.usage?.totalTokenCount);
      attempt.finishReason = generated.finishReason;
      attempt.totalTokenCount = generated.usage?.totalTokenCount;
      attempt.promptTokenCount = generated.usage?.promptTokenCount;
      if (generated.finishReason === 'MAX_TOKENS') {
        if (await recoverSplit(task, preflight, compact, context)) return;
        if (!open()) return;
        if (obligations(task).length > 1) { unresolved(task, 'Truncated group cannot be split into smaller counted requests'); return; }
        if (allowance.compact) { allowance.compact = false; await execute(task, true, context); }
        else unresolved(task, 'Output truncated after finite recovery');
        return;
      }
      if (generated.finishReason !== 'STOP') { unresolved(task, `Unsuccessful generation: ${generated.finishReason}`); return; }
      let response;
      try { response = decode(generated.text, task); }
      catch (error) {
        if (allowance.invalid) { allowance.invalid = false; await execute(task, compact, context); }
        else unresolved(task, `Invalid response after replacement: ${message(error)}`);
        return;
      }
      if (response.kind === 'context_request') {
        if (!allowance.lookup) { unresolved(task, 'Repeated required context request; lineage lookup round exhausted'); return; }
        allowance.lookup = false;
        const results: LookupResult[] = [];
        const additions = new Map<string, (LookupResult['evidence'])[number]>();
        for (const lookupRequest of response.requests) {
          const result = await bounded(options.lookup(lookupRequest, epoch.signal), epoch.signal);
          if (!open()) return;
          results.push(result);
          for (const item of result.evidence) additions.set(item.id, item);
        }
        // Count lookup payload with the same canonical provider counter. No token estimator.
        const lookupRequest = { ...req, contents: [{ role: 'user' as const, parts: [{ text: JSON.stringify(results) }] }] };
        const emptyRequest = { ...lookupRequest, contents: [{ role: 'user' as const, parts: [{ text: '' }] }] };
        const additionalCount = Math.max(0, await count(lookupRequest) - await count(emptyRequest));
        if (!open()) return;
        if (additionalCount > 8000 || results.some(r => !r.evidence.length)) { unresolved(task, 'Required context missing or exceeds 8,000 additional tokens'); return; }
        for (const item of additions.values()) inventory.evidence.set(item.id, item);
        const expanded = { ...task, evidenceIds: unique([...task.evidenceIds, ...additions.keys()]) };
        await execute(expanded, compact, results); return;
      }
      if (!open()) return;
      const validated = validateFindings(response.findings, task, inventory);
      for (const finding of validated.accepted) {
        const id = findingId(finding);
        if (!seen.has(id)) { seen.add(id); run.findings.push(finding); }
      }
      run.diagnostics.push(...validated.diagnostics);
      const state = task.kind === 'review' ? run.atoms : run.relations;
      for (const item of response.items) state[item.id] = { status: item.status, reason: item.reason };
    } catch (error) {
      if (!open()) return;
      if (error instanceof ProviderError && error.retryable && allowance.transport) {
        allowance.transport = false;
        try { await delay(Math.max(250, Math.min(30000, error.retryAfterMs)), epoch.signal); }
        catch { return; }
        if (open()) await execute(task, compact, context);
      } else unresolved(task, message(error));
    }
  }
  try {
    for (const atom of inventory.atoms) run.atoms[atom.id] = { status: 'pending', reason: 'Not scheduled' };
    const overheadTask: Task = { kind: 'review', id: 'overhead', lineageId: 'overhead', atomIds: [], evidenceIds: [] };
    if (inventory.atoms.length && open()) {
      const overhead = await planningCount(request(overheadTask));
      if (!open()) return finalize();
      if (!fits(overhead, limits.input)) {
        for (const id of Object.keys(run.atoms)) run.atoms[id] = { status: 'unresolved', reason: 'Shared instruction/rule overhead exceeds request ceiling' };
        return finalize();
      }
      queue = await plan(inventory, task => planningCount(request(task)), limits.input);
      if (!open()) return finalize();
      run.atoms = Object.fromEntries(inventory.atoms.map(a => [a.id, { status: 'pending' as const, reason: 'Not scheduled' }]));
      for (const task of queue) if (task.kind === 'integration') for (const id of task.relationIds) run.relations[id] = { status: 'pending', reason: 'Not scheduled' };
      const worker = async () => { while (open()) { const task = queue.shift(); if (!task) return; const saved = continuation.get(task.id); await execute(task, saved?.compact, saved?.context); } };
      await Promise.all(Array.from({ length: limits.concurrency }, worker));
    }
  } catch (error) { if (open()) run.diagnostics.push({ reason: `Planning failed: ${message(error)}` }); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', close); close(); }
  return finalize();

  function finalize(): Analysis {
    close();
    // Use current atoms if planning refined a range before cancellation.
    const validAtomIds = new Set(inventory.atoms.map(a => a.id));
    for (const id of Object.keys(run.atoms)) if (!validAtomIds.has(id)) delete run.atoms[id];
    for (const atom of inventory.atoms) run.atoms[atom.id] ??= { status: 'pending', reason: 'Generation cutoff, cancellation, or scheduling incomplete' };
    run.status = deriveReviewStatus(run);
    run.analysisStatus = deriveReviewStatus({ ...run, superseded: false }) as Analysis['analysisStatus'];
    run.usage = ledger.snapshot();
    // Consumers receive a detached final value. Closed continuations cannot mutate it.
    return structuredClone(run);
  }
}
