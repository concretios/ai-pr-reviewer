# v2 architecture and contracts

## Flow

```mermaid
flowchart TD
  A[Authorize invocation] --> B[Capture immutable Git objects]
  B --> C[Read base configuration and Markdown rules]
  C --> D[Inventory all eligible changed text ranges]
  D --> E[Count complete requests and plan tasks]
  E --> F[Two bounded workers and shared admission ledger]
  F --> G[Validate completion IDs and source evidence]
  G --> H[Close execution epoch and finalize analysis]
  H --> I[Freshness checks and reconciled publication]
  I --> J[Persist report and outputs, derive exit code]
```

The provider boundary uses native REST fetch and has no SDK retries. Counting and generation share the canonical request. The generated wire schema projects Zod into Gemini-compatible constraints: omit `maxItems` and encode `const` literals as single-value enums. The strict local Zod schema retains all original validation limits. See the [incident guide](gemini-troubleshooting.md). The wire schema comes from Zod and is embedded with both prompts and all runtime dependencies in `dist/index.js`.

## Source identity

The source manifest captures repository/PR identity, base branch, base SHA, the unique merge base, head SHA, source-bundle revision hash, model identifier, configuration/prompt/schema/rule hashes, and consumed blob IDs. The bundle's source hash is deterministic across rebuilds and avoids embedding the commit that contains the bundle itself. Use a pinned action SHA externally to identify the installation.

The engine uses an isolated temporary bare Git repository. It fetches commit objects, never checks out PR files, and disables hooks, external diff/text-conversion execution, ambient global Git config, credential helpers, replacement objects, and interactive prompting. Source access requires tracked regular blobs. Symlinks and submodules are not followed. Git name records are NUL-delimited and paths use literal pathspecs.

The comparison is merge-base to head. Zero or multiple best merge bases are unsupported. Renames, deletions, binary files, and metadata-only changes have distinct accounting. Text hunks are initially split into contiguous groups of at most 40 changed lines with nearby raw source; oversized multiline atoms are refined before ownership is assigned. Each LEFT/RIGHT changed range has a stable ID. A modified line contributes removed and added source obligations. Coverage is a count of these declared ranges, not files or tokens.

Binary/non-UTF-8 blobs, regular blobs above 64 MiB, unsupported modes, metadata-only changes, and exact/prefix exclusions are listed separately. Generated text and lockfiles remain eligible. `complete` applies to eligible declared scope and does not hide these source limitations.

## Planning and lookup

One review task is used when the assembled scope fits. Otherwise tasks are packed deterministically, prioritizing security, persistence/migrations, and interfaces. Same-file hunks stay adjacent. Literal one-hop JavaScript/TypeScript imports and nearby conventional test filenames supply explicit relationships; this is intentionally not a generalized dependency graph. Both raw endpoints must accompany an integration question. Relations wholly covered within a review batch do not create separate cross-batch obligations.

Every active review task owns a disjoint set of changed-range IDs. Integration tasks own explicit relation IDs and do not increase changed-code coverage. Split children reduce both obligations and counted input. A result must contain exactly the expected IDs. A context request completes nothing.

Each original lineage gets at most four lookup requests in one round. Each returned range is at most 200 lines, and the round admits at most 8,000 additional counted tokens. Literal search scans at most 2,000 pinned tracked paths and returns at most four ranges per request. Result-limit metadata is supplied to the model. There is no regex execution, network access, shell access, or recursive lookup. Missing essential evidence stays unresolved.

## Completion, recovery, and accounting

A valid application result requires STOP, complete JSON, the wire schema, exact task IDs, and source/anchor validation. STOP alone is insufficient. Local validation confirms structural/source constraints, not the truth of a causal claim. Exact duplicates are deduplicated; invalid candidates are terminal diagnostics. No mandatory praise, starter rules, or merge verdicts exist in v2 prompts.

The ledger synchronously reserves the input ceiling plus output limit before each generation. Reported totalTokenCount settles the reservation once, without separately adding thoughtsTokenCount. Unknown usage retains the reservation. All retries and split descendants share generation-attempt/token budgets. Count calls, source reads, backoff, and publication share the wall-clock deadline.

The separate [usage report](usage-and-cost.md) aggregates reported generation tokens and estimates standard text API cost per attempt. It includes retries and invalid responses, preserves unknown usage, and never prices ledger reservations or double counts thinking.

Generation is bounded to 120 seconds and ends before the finalization reserve. Closure aborts the execution epoch and settles outstanding reservations conservatively. Every continuation checks epoch state before processing results, accepting context, scheduling work, or mutating state. Final reports are detached from worker state, so providers that ignore cancellation cannot reopen finalized reports.

Nonsplitting allowances are shared by a task lineage: one schema/JSON replacement, one retryable transport retry, one compact singleton retry with 8,192 thinking tokens, and one lookup round. Authentication/permanent errors and blocked generations fail the affected obligation explicitly. Partial completion remains useful; no completed obligations means unavailable.

## Publication

Every accepted concern appears in required detail pages, irrespective of inline threshold or anchor availability. Pages remain below 50,000 UTF-8 bytes including markers. A required summary presents coverage, captured SHA, concerns, usage, source limitations, and delivery limitations. Requested inline reviews are best effort and always specify COMMENT and the captured commit_id.

Operations have deterministic IDs, intended-content hashes, finding IDs, required/best-effort flags, and pending/confirmed/failed/unconfirmed states. Reconciliation trusts both marker and author database ID. Identical writes are skipped. An ambiguous write gets one list-and-match reconciliation; inconclusive results remain unconfirmed and are never blindly recreated. Previous advisory reviews are not dismissed.

Freshness is checked before publication, before stages, and before each subsequent page/review. Changed head, closed PR, or retargeted base stops new writes. Ordinary base advancement is accepted only if the merge base, governing rule/configuration identity, and consumed captured-base blobs remain equivalent. Confirmed earlier writes are retained in the ledger if a later gate fails. Every required page and summary is in the final operation set, including writes that were never issued.

### Publication ordering

When available, workflow creation time, numeric run ID, and attempt number determine result order. Queue order is not treated as workflow creation order. Older/partial attempts cannot overwrite a newer completed result. The summary separates last completed result, latest attempt, and an older or unordered current attempt. An analysis with failed detail delivery does not replace the completed-result section.

**Minimum-permission fallback:** GitHub's workflow-run metadata endpoint can require `actions: read`, while the planned consumer permissions deliberately omit it. The engine attempts the read without requiring extra permissions. If creation time is unavailable, different-run ordering is unconfirmed and existing records are conservatively preserved. Same-run attempts still order by attempt number. This is an explicit implementation adjustment to the plan's otherwise incompatible timestamp/minimum-permission requirements. Consumers that already grant metadata access get full timestamp ordering. The fallback is covered by deterministic tests.

Cross-workflow consumers must use the same repository/PR publication concurrency group, as in both examples. Read/merge/update is not a distributed compare-and-swap primitive and cannot protect arbitrary consumers that bypass the shared concurrency contract.

## Finalization and exit

| Condition | Publication | Exit absent another failure |
| --- | --- | ---: |
| Dry-run, excluded, superseded before publication starts | not_requested | 0 |
| Required and requested inline writes confirmed | published | 0 |
| Required writes confirmed, inline incomplete | partial | 0 |
| Required writes confirmed and failed | partial | 1 |
| Required delivery failed without confirmed required result | failed | 1 |
| Any required write remains unconfirmed | uncertain | 1 |

Configuration/internal errors and unavailable analysis also fail. Findings do not. Supersession is preserved separately from analysisStatus. Outputs/report files are written before ordinary failure exits. Abrupt runner termination, filesystem failure, or process kill cannot guarantee local artifact finalization.

## Verification and official contracts

- [Git merge-base behavior](https://git-scm.com/docs/git-merge-base)
- [Gemini countTokens and generateContentRequest](https://ai.google.dev/api/tokens)
- [Gemini thinking budget](https://ai.google.dev/gemini-api/docs/generate-content/thinking)
- [GitHub action metadata and Node 24](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)
- [GitHub review API and commit_id](https://docs.github.com/en/rest/pulls/reviews)
- [GitHub concurrency and queue: max](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

Official metadata, token-count, review, concurrency, and v7 action release references were checked on 2026-09-15. Paid provider response compatibility and real GitHub runner execution remain release gates; mocked contract checks do not substitute for them.
