# Evaluation and release evidence

Model quality is measured separately from deterministic harness reliability. A passing mocked run is not evidence of precision, recall, model availability, or reduced cost.

## Frozen source and corpus

`baseline-v1/` preserves the v1 Bash scripts, prompt, schema, action metadata, and mocked test from revision `510a61aad69d2c82319057d8db510dae35a54848`. v2 never calls that runtime in a consumer job. `baseline.ts` reconstructs its prompt/REST request from pinned regular blobs for safe evaluation; v1's response schema, temperature, 16,384 output limit, safety settings, 20-file context limit, and three transient-attempt limit remain explicit.

`fixtures/` contains thirty small labeled source pairs: ten clean/non-bugs, ten local regressions, and ten context-dependent regressions. Ten are development cases and twenty are held out. Each pair has fixed base/head commit SHAs, deterministic commit metadata, source contents, and gold triggers/consequences. `materialize` checks the pinned hashes and does not execute fixture code. These authored fixtures need human benchmark review before claiming real-world representativeness.

The historical Trace replay is a reliability case, not a fully labeled defect benchmark. Its original comparison has 67 files, base/merge base `af74f1269483ce00ac8266a32179042b8a363a17`, head `fd1e44149a5a52687dc0e31f44485e316a947d39`, and historical checkout `aa20a2d2b642629ff9039dfe5a096eb8abfb1a01`. `npm run replay` reads those exact objects, retains a source manifest, and makes zero model calls. The frozen failure record is 1,042,368 prompt characters. The diagnostic reconstruction records its own measured size separately because original PR metadata and filesystem ordering affect exact bytes.

## Run

```sh
# Deterministic harness and pinned-source tests, no credentials:
npm test

# Reconstruct the original Trace snapshot, no model calls/publication:
npm run replay

# Mock provider smoke run to check report/provenance plumbing:
npm run evaluate -- --suite smoke --publish=false --dry-run

# Deliberate paid run using GEMINI_API_KEY:
npm run evaluate -- --suite smoke --publish=false
npm run evaluate -- --suite release --publish=false
```

Smoke runs ten development fixtures once per variant. Release runs twenty held-out fixtures three times per variant. Paired order is deterministic and alternates variants. Every trial keeps its source manifest, selected model, action/configuration/prompt/schema/rule hashes, raw output, usage, coverage where supported, duration, and unsuccessful outcome. Diagnostic evaluation has no GitHub publication capability.

Each fixture/variant has a five-minute wall-clock budget. v2 uses automatic call/token limits within that budget. The baseline has up to three transient retries and a 500,000-token fixture admission limit. The suite imposes additional limits:

| Suite | Generation attempts | Admission tokens | Deadline |
| --- | ---: | ---: | ---: |
| Smoke | 120 | 2,000,000 | 30 minutes |
| Release | 720 | 12,000,000 | 110 minutes |

Unstarted/failed trials remain incomplete in the suite index. Unknown usage retains reservations; cancellation cannot guarantee provider cancellation. Mock results are stored under `eval-results/mock` and cannot be scored as model quality.

## Blind assessment

1. Give reviewers `blind/<trial-id>.json` and the relevant pinned source. The packets omit variant labels. Keep the suite index and raw variant outputs separate until adjudication.
2. Label each delivered concern as valid or invalid, whether its severity is correct, and which gold IDs it detects. Valid novel findings may have no gold IDs; do not automatically mark them false.
3. Use a second assessor for disputes. Keep disagreements unassessed until resolved.
4. Save a JSON array of labels:

```json
[
  {
    "trialId": "opaque trial id",
    "findingIndex": 0,
    "valid": true,
    "severityCorrect": true,
    "matchedGoldIds": ["gold-id"],
    "assessor": "reviewer-1",
    "disputed": false
  }
]
```

For disputed findings add `secondAssessor` and `resolved: true` after adjudication. A second assessor must differ from the first.

```sh
npm run score -- --directory eval-results --assessments assessments.json
```

Metrics include all-delivered precision with copied concerns deduplicated by the harness, severity correctness, high/critical precision and counts, known-defect recall with failed/omitted trials retained, clean false alarms, coverage, usage, and median/p95 latency overall and by PR size. Unassessed concerns make quality metrics inconclusive. Zero findings gives null precision, never 100%.

v1 has no auditable changed-range completion contract, so the scoring tool does not invent one or claim a cost reduction from reduced coverage. Before comparing cost, manually identify paired successful cases with comparable coverage. Report newly reviewable large changes separately.

## Release gates still require human evidence

- All deterministic checks pass, including a clean reproducible bundle.
- Paid API contract smoke passes for the selected model and the intended GitHub runner.
- Held-out assessment shows no observed overall recall or all-severity precision regression, and improvement on context/batching cases.
- Observed high/critical precision is at least 90%, with counts and sample sufficiency reviewed. Insufficient samples are inconclusive.
- Perform an advisory Trace pilot with the audited candidate SHA, then publish release evidence and a pinned v2 release.

No paid trials, human labels, Trace installation, or v2 release are implied by the authored corpus or mocked reports.

## Archived test caveat

The unmodified `baseline-v1/test/mock-review.sh` has a pre-existing transport-mock mismatch: it returns `{ "id": 1 }` for a review-list GET that expects an array, causing a jq error. It is preserved as historical source. The maintained `test/baseline.test.ts` uses a contract-correct mock against the frozen publication script and reproduces the loss of persistent concern detail when inline delivery fails. `npm test` runs that regression; it needs Bash and jq in addition to Git and Node (available on the documented Ubuntu CI runner).
