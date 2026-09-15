import { it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
it('captures the frozen v1 loss of persistent concern details when inline delivery fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baseline-regression-'));
  try {
    await mkdir(join(directory, 'bin'));
    await writeFile(join(directory, 'bin/gh'), `#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==='api'&&args.includes('--paginate'))console.log('[]');else if(args.includes('POST')){console.error('mock inline rejection');process.exitCode=1;}else console.log('{}');`, { mode: 0o755 });
    await writeFile(join(directory, 'diff.txt'), 'diff --git a/a.ts b/a.ts\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+bad();\n');
    const concern = 'A concrete trigger causes the private value to be disclosed.';
    await writeFile(join(directory, 'review.json'), JSON.stringify({ summary: 'One concern reported', verdict: 'comment', findings: [{ file: 'a.ts', line: 1, severity: 'high', category: 'security', title: 'Private value disclosure', comment: concern }] }));
    const env = { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`, WORK_DIR: directory, PR_NUMBER: '29', GITHUB_WORKFLOW: 'fixture', BOT_NAME: 'dr-concretio',
      SUBMIT_REVIEW_VERDICT: 'false', SEVERITY_THRESHOLD: 'low', GITHUB_STEP_SUMMARY: join(directory, 'summary') };
    const script = new URL('../eval/baseline-v1/scripts/post-review.sh', import.meta.url).pathname;
    await writeFile(join(directory, 'commit_sha.txt'), 'b'.repeat(40));
    await exec('bash', [script], { env: { ...env, POST_INLINE: 'true' } });
    expect(readFileSync(join(directory, 'summary_comment.md'), 'utf8')).not.toContain(concern);
    await exec('bash', [script], { env: { ...env, POST_INLINE: 'false' } });
    expect(readFileSync(join(directory, 'summary_comment.md'), 'utf8')).toContain(concern);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
