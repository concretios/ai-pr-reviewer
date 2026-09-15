# v2 implementation validation

Verified locally on 2026-09-15. This is implementation/reliability evidence, not a model-quality or release approval.

## Passing checks

- Clean `npm ci`; dependency audit reported zero known vulnerabilities at installation time.
- `npm run check`: TypeScript and ESLint.
- 75 tests across seven suites, including execution on Node 24.21.0.
- Reproducible bundle/schema rebuild; no whitespace errors from `git diff --check`.
- Consumer expression evaluation using GitHub's `@actions/expressions` library.
- Bundled action execution from an independent working directory: automatic, manual dry-run, manual publish, comment-triggered, excluded-event, configuration failure, and mandatory-publication failure paths.
- Mocked evaluation smoke: 20 paired reports from ten development fixtures, with manifest/model/action/configuration/prompt/schema/rule provenance. No paid model calls.

The reliability suite covers immutable snapshots, missing/multiple merge bases, unusual paths, deletions, large files, submodules/symlinks, base-side evidence, bounded lookups, exact completion IDs, finite inherited recovery, concurrent reservations, cancellation/late responses, freshness, trusted-author reconciliation, mandatory versus inline delivery, and source-aware evaluation denominators.

## Trace PR #29 diagnostic

Read the original pinned comparison and historical checkout without executing PR code or publishing:

| Measurement | Result |
| --- | ---: |
| Changed files | 67 |
| Eligible changed ranges | 836 |
| Eligible added/removed lines | 12,927 |
| Source exclusions | 0 |
| Recorded original v1 prompt | 1,042,368 characters |
| Default diagnostic prompt reconstruction | 1,040,879 characters |

The reconstruction uses default metadata/input reconstruction and is not claimed to match the original prompt byte for byte. The archived workflow and failed-run logs corroborate changed-files context, max_files 20, Gemini 2.5 Flash, and the original million-character prompt.

An additional **mocked** v2 execution used an approximate token counter, completed 255/836 ranges in 12 simulated generations, and retained 581 unresolved ranges plus 22 unresolved integration questions. It made 127 simulated count calls and correctly reported partial. These numbers demonstrate budget/coverage accounting, not model quality, real token usage, or a cost saving. Reproduce with `npm run replay -- --mock-analysis`.

## Explicit limitations and pending gates

- Paid Gemini contract/quality evaluation, blind human adjudication, real GitHub-runner execution, advisory Trace installation, and release publication remain pending.
- The 30 authored fixtures are pinned and labeled but require human benchmark review for representativeness. Twenty are held out with three trials per variant in the release workflow.
- Workflow creation timestamps may require permissions excluded by the minimum-permission consumer contract. The implemented conservative ordering fallback is documented in architecture.md.
- The archived v1 standalone mock has a pre-existing review-list response-shape error. It remains frozen; the maintained regression test uses a correct transport mock and reproduces the v1 loss of persistent finding details when inline posting fails.
- `@v2` remains an illustrative consumer reference until a reviewed release exists. No tag, release, or remote deployment was created.

The pre-existing `.concret.io/` expert files and `docs/why-we-built-this.md` were preserved.
