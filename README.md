# AI PR Reviewer v2

Advisory pull-request reviews using Gemini 2.5 Flash. The action captures committed source, batches work within explicit budgets, and persists every accepted concern in one main PR comment with linked overflow when necessary.

**v2 is under development.** The example `@v2` reference is illustrative until release. Use an audited commit SHA for a pilot. Model quality and release acceptance still require the manual evaluation described below.

## Install

Add a `GEMINI_API_KEY` repository secret, then copy [the consumer workflow](examples/consumer-workflow.yml). No checkout or package installation is needed in the consumer job.

```yaml
- uses: concretios/ai-pr-reviewer@v2 # Replace with an audited release SHA.
  id: review
  with:
    github_token: ${{ github.token }}
    gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
```

The job requires `contents: read` and `pull-requests: write`; the examples also grant `actions: read` for result ordering. The example includes authorization gates, publication concurrency, manual dry runs, and seven-day artifact retention. An [optional comment workflow](examples/comment-workflow.yml) supports exact `@dr-concretio review` and `@dr-concretio extend` commands.

Fork and Dependabot PRs are excluded. Manual dispatch must use the default branch and a current repository maintainer. Rerun actors are also checked. Extended mode starts a fresh invocation with a larger budget.

## What the result means

- `complete`: All mandatory work in the declared scope finished. This is not a guarantee that every bug was found.
- `partial`: Some work finished, with unreviewed or unresolved obligations explicitly listed.
- `unavailable`: No mandatory work could be completed. The action fails and retains its report.
- `skipped`: No eligible work or an excluded event.
- `superseded`: The PR identity changed. Subsequent live writes stop.

Findings are model-reported concerns, not verified defects. Only advisory `COMMENT` reviews are posted. Finding severity and count never determine the exit code.

Every accepted concern, including low-severity and unanchored concerns, is retained in the required main comment or linked overflow pages. Inline posting is best effort. Missing or uncertain required delivery fails the action independently of analysis completion.

## Inputs

Settings resolve from engine defaults, then `.ai-review.yml` at the captured base, then explicitly supplied action inputs.

| Input | Default | Meaning |
| --- | --- | --- |
| `gemini_api_key` | Required for model work | Gemini API credential |
| `github_token` | `github.token` | GitHub repository and PR access |
| `pr_number` | Event PR | Required for manual dispatch |
| `config_path` | `.ai-review.yml` | Base-revision configuration path |
| `review_mode` | `auto` | `auto` or maintainer-authorized `extended` |
| `publish` | `true` | Set `false` for a diagnostic run |
| `model` | `gemini-2.5-flash` | Gemini model identifier |
| `post_inline_comments` | `true` | Publish eligible inline concerns |
| `comment_severity_threshold` | `low` | Minimum inline severity |
| `bot_name` | `dr-concretio` | Stable reviewer identity across triggers |
| `rules_paths` | Four root Markdown files | Ordered comma-separated Markdown files/directories |
| `submit_review_verdict` | Unset | `false` accepted for migration; `true` rejected |

`max_files`, `max_diff_size`, and `context_depth` produce explicit migration errors. See [migration guidance](docs/migration-v2.md).

Configuration example:

```yaml
model: gemini-2.5-flash
post_inline_comments: true
comment_severity_threshold: medium
bot_name: dr-concretio
rules_paths:
  - review-rules.md
  - AGENTS.md
  - standards/
exclude_paths:
  - fixtures/vendor/
```

Exclusions match an exact path or directory prefix. There are no implicit generated-code or lockfile exclusions. Rule Markdown applies globally in supplied order. Automatic discovery covers `review-rules.md`, `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`. Unsupported configured formats such as MDC are reported. PR edits to rules or configuration are review material and do not govern their own review.

Repository configuration cannot set publication or authorize extended mode. If a comment workflow uses a custom bot name, update its exact command conditions and the `bot_name` input together.

## Outputs and reports

`review_status`, `publication_status`, `reviewed_sha`, and `report_directory` are finalized before ordinary failure exits. Upload `report_directory` with `if: always()` as in the consumer workflow.

Reports include the source manifest, findings, coverage obligations, omissions, provider usage, recovery diagnostics, and every required/best-effort delivery operation. `report.md` is readable; `report.json`, `manifest.json`, `inventory.json`, and `evidence.json` support diagnosis. Early admission failures may not have a source manifest or inventory. Reports can contain private source and should use repository-appropriate artifact access.

## Token usage and cost

The PR summary and Actions report show total known generation tokens, input,
output including thinking, unknown-usage attempts, and estimated USD cost for
**this run**, including retries and invalid model responses. The estimate uses dated
standard paid-tier rates; missing usage is excluded and marked incomplete. It is
not an invoice. Admission reservations are shown separately and are never priced.

Verified rates are bundled for Gemini 2.5 Flash, Flash-Lite and Pro. Other model
names show usage with an unavailable cost estimate. See [usage and cost](docs/usage-and-cost.md)
for rates, formulas, exclusions and the structured `report.json` fields.

## Budgets

| Limit | Automatic | Extended |
| --- | ---: | ---: |
| Request input ceiling, including 5% headroom | 32,000 | 32,000 |
| Output limit, including thinking | 32,768 | 32,768 |
| Generation attempts, including recovery | 12 | 24 |
| Admission-token budget | 500,000 | 1,000,000 |
| Action deadline | 10 minutes | 20 minutes |
| Concurrent generations | 2 | 2 |
| Finalization reserve | 60 seconds | 60 seconds |

Each original task lineage gets one bounded lookup round, one malformed-response replacement, one transport retry, and one compact singleton-truncation retry. Splitting cannot replenish these allowances. Unknown usage keeps the full reservation. The ledger controls admission; it does not guarantee an invoice ceiling or server cancellation.

## Development and evaluation

Read [AGENTS.md](AGENTS.md) and the [Gemini regression guide](docs/gemini-troubleshooting.md). Use Node 24 or newer.

```sh
npm ci
npm run check
npm test
npm run build
npm run replay
npm run evaluate -- --suite smoke --publish=false --dry-run
```

`replay` reads the pinned historical Trace PR #29 comparison. It never calls a model or publishes. It uses `GITHUB_TOKEN`, an authenticated `gh` installation, or public Git access.

For schema/provider/prompt/model changes, run the explicit paid contract check with `GEMINI_API_KEY` set: `npm run smoke:gemini -- --model gemini-2.5-flash`. It uses synthetic source and never publishes; mocks alone cannot establish API compatibility.

A deliberate paid run uses the manual [evaluation workflow](.github/workflows/evaluate.yml) or omits `--dry-run` locally with `GEMINI_API_KEY` set. The smoke suite uses ten development cases. The release suite uses twenty held-out cases with three paired trials each. Human assessment is required before drawing model-quality conclusions. See [evaluation protocol](eval/README.md) and [architecture](docs/architecture.md).

## Compatibility and limitations

The action runs on Node 24. Self-hosted runners must support the Node 24 JavaScript action runtime and have Git installed. Verify runner and release compatibility before installation. The workflow examples use the current `v7` action families; pin their reviewed SHAs for production.

GitHub workflow creation time may be unavailable without `actions: read`. The main comment labels an unordered result as this attempt and collapses distinct historical records. Existing completed results are preserved; old timestamps are recovered when permissions permit. See [publication ordering](docs/architecture.md#publication-ordering).

No PR code, tests, hooks, text-conversion filters, submodules, or arbitrary commands are executed. Context selection is bounded and one-hop; unsupported source and missing evidence remain visible. v1 is frozen under `eval/baseline-v1` for comparison and existing v1 releases remain usable.

## License

Copyright 2026 [Concret.io](https://concret.io). [Apache License 2.0](LICENSE).

## Lower-overhead review and publication

Provider requests carry source blocks once, exact evidence references and request-bound short IDs. Compact completion lists replace repetitive success explanations; substantive findings and unresolved reasons remain. Repair feedback uses the existing finite allowance. Adaptive thinking and execution budgets are unchanged. Cache hits are recorded separately; savings are not guaranteed.

Dr. Concret.io updates one main diagnosis with coverage and this-run cost. Full findings and limitations are collapsed; oversized reports use linked overflow pages. Line/file comments are best effort and deduplicated per finding on the same commit. See the [combined implementation contract](docs/pr-comment-publication-plan.md).
