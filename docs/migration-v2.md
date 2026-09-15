# Migrating from v1

v2 replaces the composite Bash runtime with a bundled Node 24 action. Consumers need Git and a runner supporting Node 24 actions, but do not install Node packages or check out the PR. Existing v1 releases remain available; frozen source is in `eval/baseline-v1`.

## Required edits

1. Remove `max_files`, `max_diff_size`, and `context_depth`. They now produce migration errors. v2 inventories eligible text and uses bounded adaptive batches. `max_files` is not a per-batch setting. Use maintainer-requested extended mode for a larger fresh budget.
2. Remove `submit_review_verdict: true`. Only `false` is accepted for migration; v2 always posts advisory COMMENT reviews.
3. Use the new consumer workflow's internal-PR gates, default-branch manual dispatch, normalized publication concurrency, and `always()` artifact upload.
4. Pin an audited v2 release SHA after pilot/evaluation gates pass. The documented `@v2` reference is illustrative until release.

## Intentional behavior changes

- Configuration-controlled action inputs have no metadata defaults. Unspecified values honor `.ai-review.yml` in the captured base revision.
- Rule Markdown comes from the captured base. Root discovery covers `review-rules.md`, `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`. Add other Markdown paths with `rules_paths`. Files/directories apply globally in supplied order. MDC, TXT, and other agent dialects are not interpreted and are reported when configured.
- PR edits to rules/configuration are evidence, not governing instructions. Missing rules no longer generate starter-file suggestions.
- `bot_name`, default `dr-concretio`, is stable across workflow display names. Automatic, manual, and comment triggers share the same publication namespace. Old v1 comments/reviews are not dismissed or silently repurposed.
- All accepted concerns appear in the main comment or required overflow pages, including below-threshold and unanchored findings. In v1, enabling inline comments omitted full concern detail from the summary; a failed inline review could lose it. v2 treats the main comment and any overflow pages as mandatory.
- Findings never block merging or determine action failure. Unavailable analysis, invalid configuration, internal failures, and missing/uncertain required publication do fail, with reports retained. Partial analysis succeeds with explicit coverage limitations.
- Extended mode does not resume old analysis, coverage, charges, or task state.

## Base configuration

```yaml
comment_severity_threshold: high
post_inline_comments: true
rules_paths:
  - CLAUDE.md
  - AGENTS.md
  - vibe-coding-rules/
```

`publish`, `review_mode`, credentials, and authorization are invocation controls. They are rejected as repository settings. A custom comment bot needs matching command conditions and an explicit `bot_name` in that workflow.

## Pilot before release

Run automatic mocks and a manual dry-run first. Inspect coverage, unresolved obligations, source/rule manifest, and delivery ledger. A live Trace installation and paid model comparison have not been performed by the implementation itself. See [evaluation instructions](../eval/README.md).
