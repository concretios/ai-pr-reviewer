import * as core from '@actions/core';
import { readFile, writeFile, mkdtemp, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSettings, limits, checkLegacy, type Inputs } from './config.js';
import { authorize, maintainers, type Invocation } from './github/authorize.js';
import { GitHub } from './github/client.js';
import { freshnessGate } from './github/freshness.js';
import { publish } from './github/publish.js';
import { Snapshot } from './source/snapshot.js';
import { readRules } from './source/rules.js';
import { inventory } from './source/diff.js';
import { addRelationships, lookup } from './source/context.js';
import { Gemini } from './providers/gemini.js';
import { emptyAnalysis, runReview } from './runtime/runner.js';
import { actionExitCode, renderReport } from './reporting/render.js';
import { summarizeUsage } from './reporting/usage.js';
import { ConfigurationError, Superseded, UnsupportedSnapshot, hash, message } from './util.js';
import { reviewPrompt, integrationPrompt } from './prompts.js';
import { wireSchema } from './review/schema.js';
import type { FinalizedRun, RunOrder } from './contracts.js';

declare const __ACTION_SOURCE_HASH__: string | undefined;
export const actionRevision = typeof __ACTION_SOURCE_HASH__ === 'string' ? `sha256:${__ACTION_SOURCE_HASH__}` : 'development';
export const inputNames = ['gemini_api_key', 'github_token', 'pr_number', 'config_path', 'review_mode', 'publish', 'model',
  'post_inline_comments', 'comment_severity_threshold', 'bot_name', 'rules_paths', 'max_files', 'max_diff_size', 'context_depth', 'submit_review_verdict'] as const;

export async function main(): Promise<void> {
  const startedAt = Date.now();
  const run: FinalizedRun = { analysis: emptyAnalysis(), publication: { started: false, status: 'not_requested', operations: [], superseded: false }, omissions: [], notices: [] };
  let snapshot: Snapshot | undefined;
  let directory = '';
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), 1200000);
  const cancel = () => controller.abort(new Error('Action cancelled'));
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  const inputs: Inputs = Object.fromEntries(inputNames.map(name => [name, core.getInput(name)]));
  const token = inputs.github_token || process.env.GITHUB_TOKEN || '';
  if (inputs.gemini_api_key) core.setSecret(inputs.gemini_api_key);
  if (token) core.setSecret(token);
  try {
    directory = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'ai-review-report-'));
    if (!process.env.GITHUB_EVENT_PATH) throw new ConfigurationError('Run this action in GitHub Actions. Use npm run replay for pinned diagnostics.');
    const invocation: Invocation = {
      eventName: process.env.GITHUB_EVENT_NAME ?? '', event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')),
      repository: process.env.GITHUB_REPOSITORY ?? '', actor: process.env.GITHUB_ACTOR ?? '',
      triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR || process.env.GITHUB_ACTOR || '', ref: process.env.GITHUB_REF ?? '', inputs,
    };
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(invocation.repository)) throw new ConfigurationError('Invalid GITHUB_REPOSITORY');
    if (!token) throw new ConfigurationError('github_token is required; pass github.token in the workflow');
    const api = new GitHub(token, controller.signal, process.env.GITHUB_API_URL || 'https://api.github.com');
    const admission = await authorize(api, invocation);
    if (admission.skipped) { run.notices.push(admission.skipped); return; }
    checkLegacy(inputs);
    const budget = limits(admission.mode);
    clearTimeout(timer); timer = setTimeout(cancel, Math.max(0, startedAt + budget.durationMs - Date.now()));
    const pr = admission.pr!;
    const remote = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${invocation.repository}.git`;
    snapshot = await Snapshot.capture({ repository: invocation.repository, repositoryId: pr.base.repo!.id, prNumber: pr.number,
      baseRef: pr.base.ref, baseSha: pr.base.sha, headSha: pr.head.sha }, remote, controller.signal, token);
    const configPath = inputs.config_path?.trim() || '.ai-review.yml';
    if (configPath.startsWith('/') || configPath.split('/').includes('..')) throw new ConfigurationError('config_path must be repository-relative');
    const configEntry = (await snapshot.tree(pr.base.sha)).get(configPath);
    const configuration = await snapshot.read(pr.base.sha, configPath);
    if (configEntry && !configuration) throw new ConfigurationError('Base configuration must be a regular UTF-8 file');
    const settings = resolveSettings(configuration?.text, inputs);
    if (admission.commandBot && admission.commandBot !== settings.bot_name) { run.notices.push('Command does not match the captured base reviewer identity'); return; }
    const rules = await readRules(snapshot, settings);
    run.notices.push(...rules.notices);
    run.manifest = { ...snapshot.identity, mergeBaseSha: snapshot.mergeBaseSha, actionRevision, model: settings.model,
      configurationHash: hash(settings), promptHash: hash([reviewPrompt, integrationPrompt]), schemaHash: hash(wireSchema), ruleHash: rules.hash, evidenceBlobs: {} };
    const fresh = freshnessGate(api, snapshot, pr, remote, settings, rules, configPath, configEntry?.oid);
    if (!await fresh()) throw new Superseded('PR snapshot changed before generation');
    const source = await inventory(snapshot, settings.exclude_paths);
    run.omissions = source.omissions;
    await addRelationships(snapshot, source);
    if (source.atoms.length && !inputs.gemini_api_key) throw new ConfigurationError('gemini_api_key is required for eligible review work');
    if (!await fresh()) throw new Superseded('PR snapshot changed during planning');
    run.analysis = await runReview({ inventory: source, rules, provider: new Gemini(inputs.gemini_api_key ?? ''), model: settings.model,
      limits: budget, startedAt, signal: controller.signal,
      lookup: (request, signal) => lookup(snapshot!, request, signal), onProgress: core.info });
    run.manifest.evidenceBlobs = Object.fromEntries(snapshot.consumed);
    await writeFile(join(directory, 'evidence.json'), JSON.stringify([...source.evidence.values()], null, 2));
    await writeFile(join(directory, 'inventory.json'), JSON.stringify({ ...source, evidence: [...source.evidence.keys()] }, null, 2));
    if (admission.publish) {
      if (admission.manual) await maintainers(api, invocation.repository, [invocation.actor, invocation.triggeringActor]);
      let authorId: number;
      try { authorId = (await api.get<{ id: number }>('/user')).id; }
      catch { authorId = (await api.get<{ id: number }>('/users/github-actions%5Bbot%5D')).id; }
      const order: RunOrder = { createdAt: '', runId: process.env.GITHUB_RUN_ID ?? '0', attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? '1') };
      // Optional metadata. Minimum-permission consumers need not grant actions:read.
      try { order.createdAt = (await api.get<{ created_at: string }>(`/repos/${invocation.repository}/actions/runs/${order.runId}`)).created_at; }
      catch { run.notices.push('Workflow creation time unavailable with this token. Existing completed/latest records are retained when run order cannot be established.'); }
      run.publication = await publish({ api, manifest: run.manifest, analysis: run.analysis, settings, order, authorId, fresh, inventory: source,
        notices: [...run.notices, `${run.omissions.length} source exclusions/limitations; see the report artifact.`] });
      if (run.publication.superseded) { run.analysis.superseded = true; run.analysis.status = 'superseded'; }
    }
    if (run.analysis.status === 'partial') core.warning('Partial review. See unresolved coverage in the report.');
  } catch (error) {
    if (error instanceof Superseded) { run.analysis.superseded = true; run.analysis.status = 'superseded'; run.notices.push(error.message); }
    else if (error instanceof ConfigurationError) run.configurationError = error.message;
    else if (error instanceof UnsupportedSnapshot) { run.analysis.status = 'unavailable'; run.analysis.analysisStatus = 'unavailable'; run.notices.push(error.message); }
    else run.internalError = message(error);
  } finally {
    clearTimeout(timer); process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
    if (snapshot && run.manifest) run.manifest.evidenceBlobs = Object.fromEntries(snapshot.consumed);
    run.usageReport = summarizeUsage(run.analysis, run.manifest?.model);
    const report = renderReport(run);
    if (directory) {
      await writeFile(join(directory, 'report.json'), JSON.stringify(run, null, 2));
      await writeFile(join(directory, 'report.md'), report);
      if (run.manifest) await writeFile(join(directory, 'manifest.json'), JSON.stringify(run.manifest, null, 2));
    }
    core.setOutput('review_status', run.analysis.status);
    core.setOutput('publication_status', run.publication.status);
    core.setOutput('reviewed_sha', run.manifest?.headSha ?? snapshot?.identity.headSha ?? '');
    core.setOutput('report_directory', directory);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
    await snapshot?.dispose();
    if (actionExitCode(run)) core.setFailed(run.configurationError || run.internalError || 'Review unavailable or required publication incomplete. Report retained.');
  }
}
