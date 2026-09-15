# Dr. Concret.io: lower review costs and clearer PR feedback

Approved implementation contract, 2026-09-15. Supersedes the separate publication
and cost-experiment proposals. Implementation and live verification are tracked
in the Gemini incident guide; no savings percentage or quality improvement is assumed.

## Agreed defaults

Deliver one combined change. Keep Gemini 2.5 Flash, adaptive thinking, existing
execution budgets, bounded retrieval, and advisory COMMENT reviews. Use local
regression checks, small functional API checks and one normal Trace review.
No A/B campaign, 120-run suite, thinking-budget experiments, extra critic model,
explicit caching, cheaper-model routing, incremental review reuse, Flex or Batch.
The frozen v1 evaluator remains comparison material.

## Token consumption

- Project provider requests without changing internal source inventory or report IDs.
  Merge only compatible overlapping/adjacent source windows and preserve exact
  evidence intervals. Never bridge gaps, normalize source, or merge different
  paths, revisions, blobs or sides. Conflicting/ambiguous windows remain separate.
- Omit atom text only when included evidence reconstructs it exactly. Lookup source
  appears in the same source table, with metadata referencing evidence IDs.
- Use versioned, request-bound short aliases and explicit reviewedIds plus unresolved
  reasons. Their disjoint union must equal the expected obligations. Translate every
  reference before existing validation and publication; reject stale/foreign IDs.
- Retain local schema caps and Gemini wire compatibility adaptations. Record usage
  before decode. Give the existing one invalid replacement bounded structured error
  feedback, counted in the replacement request, without raw provider output.
- Put ordered base rules before task-specific content to improve automatic prefix
  caching opportunities. Keep rules below the system protocol's trust boundary.
- Reuse existing token/cost arithmetic. Record cache metadata, attempt purpose/outcome,
  thinking setting, protocol version and request hash. Unknown usage is not zero;
  admission reservations are not billed tokens. Cost remains before cache discounts,
  with cached input shown separately. Do not add thinking/cache tokens again.

## Useful comments

- One reusable main summary with the stable bot marker: Dr. Concret.io branding,
  deterministic diagnosis, severity counts, SHA, coverage, this-run tokens/cost,
  and workflow/report links. Partial coverage never receives an all-clear message.
- Full accepted findings, usage details, limitations and distinct previous results
  are collapsed. Required linked overflow pages are allowed only for size limits;
  full UTF-8 content remains below the safe comment limit without silent truncation.
- Establish durable finding delivery before best-effort line/file discussions, then
  finalize delivery information in the same main comment. Track both required writes.
- Inline findings use a title and concise causal explanation. Hidden markers carry
  machine identity; evidence links are collapsed. Single-file unanchored findings
  use file comments when a validated current changed file exists. Other findings
  remain in the main fallback.
- Deduplicate individual same-commit finding IDs and anchors, independent of batch
  order. Only trust matching bot authors and markers. Recognize legacy IDs through
  trusted parent reviews; retain discussions and resolved threads. Different wording
  can create different IDs; semantic deduplication is not promised.
- Preserve bounded uncertain-write reconciliation and freshness gates. Parse old
  summary state, including current; backfill missing timestamps when available.
  Recommend actions: read, but retain an honestly labeled ordering fallback.
- Check causal direction in the existing model generation: before/after behavior,
  concrete trigger, guards/callers/tests, and actual new consequence. Reject speculative
  visual regressions, generic missing tests, preferences and improvements described
  as bugs. Require an explicit candidate classification in the same generation;
  only introduced failures reach publication, while other classifications become
  diagnostics. Structural validation does not prove a model's causal claim.

## Verification and rollout

Run check, tests and build. Cover source reconstruction, alias/request isolation,
complete count/generate identity, finite recovery, usage unknowns, per-finding
publication deduplication, ambiguous writes, legacy state, overflow and branding.
Use synthetic fixtures and ignored local Trace artifacts; commit no private source.
Preview the saved PR #32 report locally, run result/context protocol smoke on the
actual target model/key, and inspect one normal Trace review's findings, coverage,
usage and delivery. No benchmark campaign is part of this work.

Commit generated artifacts with source and document incident protections. Deploy
an audited SHA through normal consumer branch/PR workflows, first Trace and then
other discovered consumers. Preserve previous pins for rollback. Minimize obsolete
PR #32 bot comments only after retaining their information and confirming the main
comment; cleanup failure is nonfatal. Never delete discussions or dismiss reviews.
Roll back on source loss, identity errors, broken publication, unexplained accounting
or confirmed quality regressions. Normal-run consumption is observational evidence,
not a causal savings comparison between unmatched PRs.

## Research basis

- [Gemini structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)
- [Gemini automatic caching](https://ai.google.dev/gemini-api/docs/generate-content/caching)
- [Usage metadata](https://ai.google.dev/api/generate-content#UsageMetadata)
- [Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Google review guidance](https://google.github.io/eng-practices/review/reviewer/comments.html)
- [GitHub line/file comments](https://docs.github.com/en/rest/pulls/comments)
