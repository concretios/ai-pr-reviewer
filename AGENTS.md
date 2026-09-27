# AI PR Reviewer: development rules

This is the canonical guide for coding agents working on this repository. Read
[README.md](README.md) and [architecture.md](docs/architecture.md) before runtime changes.
The frozen Bash action in `eval/baseline-v1/` is comparison material, not production.

## Read before editing

| Area | Required context |
| --- | --- |
| Gemini, prompts, schema, generation or model selection | [Gemini incident and regression guide](docs/gemini-troubleshooting.md) |
| Usage, budget, pricing or reporting | [Usage and cost contract](docs/usage-and-cost.md) |
| Action inputs or consumer workflows | [Migration guide](docs/migration-v2.md) |
| Releases, tags or consumer action pins | [Release and pin policy](docs/releases.md) |
| Evaluation or claims of review quality | [Evaluation protocol](eval/README.md), [validation evidence](docs/validation-v2.md) |

## Preserve these contracts

- Never execute or check out reviewed PR code. Capture immutable Git objects and read governing configuration/rules from the captured base.
- Provider projection must exactly reconstruct each supplied evidence view. Preserve original evidence intervals, LEFT/RIGHT identity and internal stable IDs. Never infer source coverage from omitted text.
- Decode short aliases only through the exact request binding. Reviewed and unresolved IDs must partition expected obligations; completion metadata is not model reasoning.
- Count complete requests. Counting and generation must use the same canonical payload.
- The provider wire schema is a compatible projection of the strict local schema. Keep array caps in local validation, omit wire `maxItems`, and encode literals as single-value `enum`. Do not export raw Zod JSON Schema without these adaptations.
- HTTP 200 and STOP are insufficient. Require valid response kind, exact task/result IDs, and valid evidence/anchors. Input kinds `review`/`integration` differ from output kinds `result`/`context_request`.
- Preserve finite lineage retries, bounded lookups, conservative unknown usage and the execution epoch. Late results must not alter finalized state.
- Keep PR cost presentation compact and separate from diagnostic artifacts. Show incomplete-usage warnings only when needed; never put admission reservations in the PR footer.
- Record usage before validating model output. Failed validation, truncation, context requests and retries still consume tokens. Never double count thinking or price admission reservations.
- Every accepted concern must persist in the required main comment or linked overflow pages. Inline delivery is best effort. Analysis and publication statuses are separate; findings never decide exit code or a merge verdict.
- Keep Dr. Concret.io personality in presentation, without extra model calls. Require a supported new failure, not an improvement described as a defect. Wire candidates must be explicitly classified; only introduced_failure is publishable. Other classifications become diagnostics, never extra paid critique calls.
- Deduplicate inline findings individually on the captured commit. Required main-comment preparation and finalization must be reconciled; no blind recreate after uncertain writes.
- Preserve trusted-author markers, ambiguous-write reconciliation and freshness checks between publication stages.
- Never discard all provider error detail or expose credentials/raw error envelopes. Keep diagnostics bounded and redacted.
- Use full SHAs for pilots. Stable production consumers use the exact immutable release SHA with a same-line semantic-version comment. Floating major tags are opt-in and forbidden for high-trust workflows such as `pull_request_target`.

## Verification and delivery

Use Node 24+. Run `npm run check`, `npm test`, and `npm run build`; use `npm ci` when dependencies change. Commit `dist/`, generated schema and any lockfile changes with their source. CI checks for bundle/schema drift.

Do not publish or move release tags from a feature branch. Follow the release gate in
[docs/releases.md](docs/releases.md), including immutable-release verification and
consumer rollback records.

Mocks establish our behavior, not Gemini compatibility. For schema, provider, prompt or model changes, also run `npm run smoke:gemini -- --model <target-model>` with an authorized key, then a representative authorized pilot. The smoke makes paid requests and never publishes. If live validation cannot run, state that limit; never call mocked success a live pass. A different model or key is not proof for the target model/key.

Inspect report artifacts on a pilot, even if the job passes: coverage, unresolved scope, usage and required delivery. Keep partial coverage explicit. A successful run is not evidence that every finding is correct.

After a production failure, record the observed error, isolated cause, fix, regression test and live evidence in the incident guide. Preserve historical results and distinguish confirmed facts from hypotheses. Do not commit private Trace source, logs, credentials or generated local reports; `eval-results/` is ignored.
