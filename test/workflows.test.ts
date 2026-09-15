import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { readFile, writeFile, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { Lexer, Parser, Evaluator, data } from '@actions/expressions';
import { fixtures, materialize } from '../eval/fixtures.js';
import type { FinalizedRun } from '../src/contracts.js';
const exec = promisify(execFile);
const repo = { id: 1, full_name: 'owner/repo', default_branch: 'main' };
const consumer = parse(await readFile(new URL('../examples/consumer-workflow.yml', import.meta.url), 'utf8'));
const comment = parse(await readFile(new URL('../examples/comment-workflow.yml', import.meta.url), 'utf8'));
const action = parse(await readFile(new URL('../action.yml', import.meta.url), 'utf8'));
function convert(value: unknown): data.ExpressionData {
  if (typeof value === 'string') return new data.StringData(value);
  if (typeof value === 'number') return new data.NumberData(value);
  if (typeof value === 'boolean') return new data.BooleanData(value);
  if (Array.isArray(value)) return new data.Array(...value.map(convert));
  if (value && typeof value === 'object') return new data.Dictionary(...Object.entries(value).map(([key, value]) => ({ key, value: convert(value) })));
  return new data.Null();
}
function evaluate(expression: string, contexts: Record<string, unknown>): string {
  const lexer = new Lexer(expression); const parser = new Parser(lexer.lex().tokens, Object.keys(contexts), []);
  return new Evaluator(parser.parse(), convert(contexts) as data.Dictionary).evaluate().coerceString();
}
function expand(value: string, contexts: Record<string, unknown>): string {
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr: string) => evaluate(expr, contexts));
}
let fixture: Awaited<ReturnType<typeof materialize>>; let server = '';
beforeAll(async () => {
  fixture = await materialize((await fixtures())[0]!); server = await mkdtemp(join(tmpdir(), 'review-smoke-'));
  await mkdir(join(server, 'owner')); await symlink(fixture.directory, join(server, 'owner/repo.git'));
  // Build the exact consumer entry point. No dependencies are loaded by the child from node_modules.
  await exec(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/build.ts']);
}, 30000);
afterAll(async () => { await fixture?.dispose(); if (server) await rm(server, { recursive: true, force: true }); });
describe('representative consumer workflows and bundled entry point', () => {
  it('metadata keeps configurable defaults in the engine and uses Node 24', () => {
    expect(action.runs).toEqual({ using: 'node24', main: 'dist/index.js' });
    for (const name of ['model', 'bot_name', 'rules_paths', 'post_inline_comments', 'comment_severity_threshold', 'max_files', 'context_depth']) expect(action.inputs[name].default).toBeUndefined();
    expect(consumer.jobs.review.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
    expect(consumer.jobs.review.concurrency.queue).toBe('max'); expect(consumer.jobs.review.concurrency['cancel-in-progress']).toBe(false);
    expect(consumer.jobs.review.steps[0].uses).toBe('concretios/ai-pr-reviewer@v2');
  });
  it.each(['automatic', 'manual-dry', 'manual-publish', 'comment', 'excluded', 'publication-failure', 'configuration-failure'])('exercises %s inputs, side effects, outputs, and report retention', async mode => {
    const pr = { number: 29, state: 'open', user: { login: 'dev' }, base: { repo, sha: fixture.baseSha, ref: 'main' }, head: { repo, sha: fixture.headSha, ref: 'feature' } };
    const manual = mode.startsWith('manual'); const isComment = mode === 'comment';
    const eventName = manual ? 'workflow_dispatch' : isComment ? 'issue_comment' : 'pull_request';
    const event = { action: isComment ? 'created' : 'opened', repository: repo, pull_request: pr, issue: { number: 29, pull_request: {} }, comment: { body: '@dr-concretio extend', user: { login: 'maintainer' } } };
    if (mode === 'excluded') pr.head.repo = { ...repo, id: 2, full_name: 'fork/repo' };
    const contexts = { github: { event_name: eventName, event, repository: repo.full_name, repository_id: 1, actor: 'maintainer', ref: manual || isComment ? 'refs/heads/main' : 'refs/pull/29/merge', run_id: '123', token: 'mock-github-token' },
      inputs: manual ? { pr_number: '29', review_mode: 'extended', publish: mode === 'manual-publish' } : {}, secrets: { GEMINI_API_KEY: 'mock-key' } };
    const job = isComment ? comment.jobs.review : consumer.jobs.review;
    const admitted = evaluate(job.if, contexts);
    if (mode === 'excluded') { expect(admitted).toBe('false'); expect(evaluate(consumer.jobs['skipped-event'].if, contexts)).toBe('true'); }
    else expect(admitted).toBe('true');
    const mapped = Object.fromEntries(Object.entries(job.steps[0].with as Record<string, string>).map(([name, value]) => ['INPUT_' + name.toUpperCase(), expand(value, contexts)]));
    const concurrency = expand(job.concurrency.group, contexts).replace(/\s+/g, '');
    expect(concurrency).toBe(mode === 'manual-dry' ? 'ai-review-1-29-pilot-123' : 'ai-review-1-29-publish');
    if (mode === 'configuration-failure') mapped.INPUT_MAX_FILES = '20';
    const dir = await mkdtemp(join(tmpdir(), 'review-output-'));
    try {
      const eventPath = join(dir, 'event.json'); await writeFile(eventPath, JSON.stringify(event));
      for (const path of ['output', 'summary']) await writeFile(join(dir, path), '');
      const preload = join(dir, 'mock.cjs');
      await writeFile(preload, `const fs=require('node:fs'); const event=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')); const calls=[];const comments=[];process.on('exit',()=>fs.writeFileSync(process.env.AUDIT_PATH,JSON.stringify(calls)));global.fetch=async(url,init={})=>{const u=new URL(url);const body=init.body?JSON.parse(init.body):{};calls.push({url,method:init.method,body});let value={};let status=200;if(u.hostname==='generativelanguage.googleapis.com'){if(u.pathname.endsWith(':countTokens'))value={totalTokens:1000};else {const input=JSON.parse(body.contents[0].parts[0].text);value={usageMetadata:{totalTokenCount:1200},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({kind:'result',taskId:input.taskId,items:input.expectedIds.map(id=>({id,status:'reviewed',reason:'Mock review completed'})),findings:[]})}]}}]};}}else if(u.pathname.endsWith('/permission'))value={permission:'write'};else if(u.pathname.endsWith('/pulls/29'))value=event.pull_request;else if(u.pathname.includes('/actions/runs/'))value={created_at:'2026-09-15T00:00:00Z'};else if(u.pathname==='/user')value={id:1};else if(u.pathname.includes('/comments')){if(init.method==='POST'||init.method==='PATCH'){if(process.env.FAIL_PUBLICATION==='true'){status=403;value={};}else{value={id:comments.length+1,body:body.body,user:{id:1}};comments.push(value);}}else value=comments;}else value=event.repository;return new Response(JSON.stringify(value),{status});};`);
      let code = 0;
      try {
        await exec(process.execPath, ['--require', preload, join(process.cwd(), 'dist/index.js')], { cwd: dir,
          env: { ...process.env, ...mapped, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: eventName, GITHUB_REPOSITORY: repo.full_name,
            GITHUB_ACTOR: 'maintainer', GITHUB_TRIGGERING_ACTOR: 'maintainer', GITHUB_REF: contexts.github.ref, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
            GITHUB_SERVER_URL: server, GITHUB_API_URL: 'https://api.github.test', GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary'), RUNNER_TEMP: dir,
            AUDIT_PATH: join(dir, 'audit.json'), FAIL_PUBLICATION: String(mode === 'publication-failure') } });
      } catch (error) { code = Number((error as { code: number }).code); }
      const output = await readFile(join(dir, 'output'), 'utf8'); const path = output.match(/report_directory<<[^\n]+\n([^\n]+)/)![1]!;
      const report: FinalizedRun = JSON.parse(await readFile(join(path, 'report.json'), 'utf8'));
      const calls: Array<{ url: string; method: string }> = JSON.parse(await readFile(join(dir, 'audit.json'), 'utf8'));
      expect(code).toBe(mode.endsWith('failure') ? 1 : 0); expect(output).toContain('review_status'); expect(await readFile(join(dir, 'summary'), 'utf8')).toContain('AI PR reviewer report');
      if (mode === 'excluded' || mode === 'configuration-failure') { expect(calls.some(c => c.url.includes('googleapis'))).toBe(false); }
      else { expect(report.analysis.status).toBe('complete'); expect(report.manifest!.headSha).toBe(fixture.headSha); }
      if (mode === 'manual-dry' || mode === 'excluded') { expect(report.publication.status).toBe('not_requested'); expect(calls.some(c => c.method === 'POST' && c.url.includes('github.test'))).toBe(false); }
      else if (mode === 'publication-failure') expect(report.publication.status).toBe('failed');
      else if (mode !== 'configuration-failure') expect(report.publication.status).toBe('published');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
