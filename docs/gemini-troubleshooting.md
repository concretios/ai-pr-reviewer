# Gemini failures and regression checks

## 2026-09-15: first Trace v2 pilot

Two independent wire-schema bugs prevented a usable review. All local mocks passed
before the pilot because the fake provider accepted any schema and returned valid JSON.

| Observation | Confirmed cause and fix | Protection |
| --- | --- | --- |
| [Initial run](https://github.com/concretios/trace/actions/runs/34958699420): seven HTTP 400 responses; 0/171 ranges reviewed | Nested `maxItems` constraints made Gemini reject the response schema. Removing only `maxItems` changed a minimal live probe from 400 to 200. Omit it from the wire schema; keep every array cap in Zod validation. | Wire/local schema regression in `test/contracts.test.ts`; live smoke below |
| [First retry](https://github.com/concretios/trace/actions/runs/34959479336): all 12 generations finished with STOP, but response kinds failed validation | Gemini did not enforce `const` discriminators. Convert literals to single-value `enum`; explicitly distinguish input task kinds from output response kinds in the prompt. | Enum regression plus local rejection of `kind: review`; live count/generate/decode smoke |
| Initial errors showed only `Gemini HTTP 400` | Adapter discarded the response body. Preserve operation, HTTP status and bounded provider status/message, with credential redaction. | Error redaction, malformed-body and oversized-body tests |

The final [Trace run](https://github.com/concretios/trace/actions/runs/34959994724)
used action commit `68f646e103c2c45a895648296fcb6632f49fa480` and Gemini 2.5 Flash.
It passed: 149/173 changed ranges reviewed, seven advisory findings published in
detail pages and inline comments, 12 successful generations, 327,330 reported
tokens, no unknown usage. The denominator includes subsequent workflow pin edits;
do not compare 171 and 173 as identical snapshots.

Coverage was still partial: 24 ranges and four cross-file questions remained
unresolved due to mismatched result IDs, exhausted attempts or indivisible input.
Those limitations were reported, not silently counted as reviewed. Finding
correctness was not independently adjudicated.

### What the experiments established

- Minimal schema probes on Gemini 3.6 Flash isolated `maxItems`. Changing only
  `oneOf`, only `const`, or only string bounds did not remove HTTP 400.
- A local key could use Gemini 3.6 Flash but returned a model-access error for
  Gemini 2.5 Flash. Trace's Actions key could use 2.5 Flash. A model listing or a
  different key/model's success does not establish generation compatibility.
- The full Actions pilot verified the fixes on the actual 2.5 Flash configuration.
- [Google's REST reference](https://ai.google.dev/api/generate-content#v1beta.GenerationConfig)
  documents only a subset of JSON Schema. A valid JSON Schema is not necessarily
  accepted or enforced by the model service.

## Before changing schemas, prompts, providers or models

1. Read `src/review/schema.ts`, `src/providers/provider.ts` and the contract tests.
   Preserve wire adaptations and strict local validation separately.
2. Run `npm run check`, `npm test`, and `npm run build`. Confirm generated schema
   and bundle changes match source. Mocked HTTP 200 responses are insufficient.
3. With an authorized `GEMINI_API_KEY` in the environment, run:

   ```sh
   npm run smoke:gemini -- --model gemini-2.5-flash
   ```

   This makes two real count calls and two generations (result and context-request cases) using the production adapter,
   schema, prompts and output settings. It validates STOP, response kind, request binding, exact IDs
   and evidence on synthetic source. It never reads a PR or publishes. A smoke is
   a contract check, not a quality benchmark or large-PR coverage check.
4. Run an authorized representative PR pilot and inspect its artifact, including
   unresolved IDs, cost completeness and required publication operations.
5. Add a regression for each confirmed failure. Do not loosen local validation or
   mark missing IDs reviewed just to make a run pass.

## When a live run fails

Start with the failed step and `report.json`, then classify the boundary:

| Symptom | Inspect next |
| --- | --- |
| HTTP 400 | Provider status/message, wire schema, generation settings. Reproduce on synthetic source and change one variable at a time. |
| 401/403/404 | Key validity, endpoint and actual model access. Do not print keys or silently switch models. |
| 429/5xx | Retry classification, delay, finite allowance and unknown usage. |
| STOP but unavailable | Decode diagnostics, response kind, exact IDs and evidence validation. |
| Partial | Specific unresolved reasons. Extra budget cannot fix indivisible input or an invalid response contract. |
| Publication failure | Required main-comment/overflow operations, permissions, freshness and reconciliation. Preserve valid analysis. |

Re-running an old GitHub job retains its original workflow revision. Update the
action SHA in the PR workflow and trigger a fresh run to test a fix. Manual dispatch
requires the workflow on the repository's default branch; this action also requires
the manual run to use that branch. Closed PRs require diagnostic replay.

Keep private artifacts under ignored `eval-results/`. Record only necessary aggregate
evidence and links in public docs. See [usage and cost](usage-and-cost.md) for accounting.

## 2026-09-15: compact requests and publication consolidation

PR #32 exposed repeated finding text in a separate detail comment, an obsolete v1
error, and an old unavailable result labeled latest when timestamps were missing.
The publisher now reuses one main comment, collapses fallback/history, deduplicates
individual inline findings and backfills timestamps when actions: read becomes
available. Required preparation/finalization and optional inline writes remain
separate. Never hide old details until the replacement has been verified.

Request projection removes duplicate source only after exact reconstruction. A
versioned request-bound compact protocol removes repetitive success explanations.
Structured replacement feedback retains the old single-retry allowance. Tests cover
source gaps/conflicts, Unicode/CRLF, wrong namespaces, stale bindings, finite recovery,
unknown/cache usage, reordered batches, lost writes, file fallback and old state.

The review prompt explicitly checks whether the new code introduces the claimed
problem. Two historical HistoryApp comments described improvements as regressions;
structural evidence validation alone cannot determine that causal truth. Do not
claim automatic semantic verification from prompt instructions or passing mocks.

The first combined [pilot](https://github.com/concretios/trace/actions/runs/34965711430)
passed result/context protocol smoke and publication: all 198 changed ranges and
3/6 cross-file checks, 299,889 tokens, $0.2104475 before cache discounts, 37,790
reported cached input tokens, zero unknown total usage. Both invalid replacements
recovered successfully. The changed scope and adaptive partitioning differ from
older runs; these figures do not establish causal savings.

Manual inspection rejected the quality gate: the model still offered cosmetic
observations and an improvement as findings. Prompt-only checks were insufficient.
The compact-v2 wire contract now requires each candidate to be classified as an
introduced failure, existing issue, improvement, preference or insufficient evidence.
Only introduced failures enter publication; other classifications become diagnostics
without a new model call or retry. Schema field descriptions demand an actual new
failure under a supported trigger. Classification remains model-reported, not an
independent semantic proof. The failed quality gate held wider rollout until repeat
functional review.

The corrected [Trace pilot](https://github.com/concretios/trace/actions/runs/34966583395)
verified action `b2925fc25f964faab9ee0d9a2bcf15276316f96f` on the actual Gemini
2.5 Flash key. Both result/context smoke checks passed. The normal review published
one main diagnosis and one inline concern, with 196/198 changed ranges and all
4 cross-file checks reviewed. Two ranges remained unresolved for missing context;
the diagnosis explicitly says the check-up is incomplete.

All 10 generations reported usage, including one malformed-completion replacement
that recovered: 214,650 input plus 37,859 output equals 252,509 total tokens.
Thinking contributed 35,250 of the output tokens. Reported cached input was 28,267
across five attempts. The estimate was $0.1590425 before cache discounts, with no
unknown total usage. These values exclude the separate synthetic smoke checks.

The earlier cosmetic and improvement comments did not recur. One medium advisory
concern remained about a changed billable default; its business impact still needs
author judgment. This inspection is not independent proof of the finding or a
statistical quality improvement. Changed heads and task partitions preclude a causal
savings claim. No benchmark campaign was run.

After checking the final main comment retained its accepted finding and report
link, three obsolete top-level bot error/detail comments were minimized as outdated.
Their text remains available; line discussions and resolved threads were preserved.
Consumer migration PRs use the same audited action SHA and retain previous pins for
rollback. A complete workflow revert is required for v1 consumers because inputs
and event handling also changed.
