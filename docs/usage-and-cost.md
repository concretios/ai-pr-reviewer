# Token usage and estimated API cost

The PR summary and Actions report display usage for **this invocation**, including
all generation retries, context requests, truncated answers and invalid responses.
`report.json` retains individual attempts plus a structured `usageReport`.
It is not a cumulative bill across every run of a PR.

## Three different numbers

- **Known generation tokens:** sum of provider `totalTokenCount` values received
  before finalization. Do not add preflight counts or thinking tokens again.
- **Admission budget:** conservative reservations used to decide whether another
  generation can start. Unknown usage retains a reservation. This is not measured
  consumption and must never be converted into an invoice or displayed as token burn.
- **Estimated API cost:** standard paid-tier text list-price estimate for attempts
  with both reported input and total tokens. It excludes unknown attempts and is
  labelled incomplete when some attempts cannot be priced.

For this text-only action, which uses no provider tools, output including thinking
is `totalTokenCount - promptTokenCount`. `thoughtsTokenCount` is an optional subtotal,
not an additional charge. Input/output totals show how many attempts have a complete
split; thinking shows its own reporting coverage. Older artifacts may lack a thinking
subtotal while still allowing a complete input/output cost estimate.

Missing usage is **unknown**, not zero. HTTP errors/timeouts can leave usage unknown;
provider work may continue after cancellation. All-unknown runs display unavailable
cost, not `$0`. Actual zero-attempt runs report zero usage. Unknown model aliases
show an unavailable estimate rather than inheriting another model's price.

## Rate basis

Rates checked **2026-09-15** against [Google's pricing page](https://ai.google.dev/gemini-api/docs/pricing),
in USD per million tokens, standard paid-tier text generation:

| Exact model | Input | Output including thinking |
| --- | ---: | ---: |
| `gemini-2.5-flash` | $0.30 | $2.50 |
| `gemini-2.5-flash-lite` | $0.10 | $0.40 |
| `gemini-2.5-pro`, prompt <=200,000 | $1.25 | $10.00 |
| `gemini-2.5-pro`, prompt >200,000 | $2.50 | $15.00 |

The Pro threshold applies to each generation's input, not the invocation total.
Other models, including floating aliases, currently have no bundled rate. The
optional `models/` prefix is normalized. Prices are a dated snapshot and are not
fetched during a review.

Calculate each attempt as `(input × inputRate + output × outputRate) / 1,000,000`,
then sum without intermediate rounding. Display four decimal places. The estimate
is before cache discounts, free-tier allowances, credits and taxes; it is not an
actual Google invoice. Preflight token counts are not added as generation usage.
It covers model generation, not GitHub Actions compute or storage.

Example: the successful Trace PR #32 pilot reported 258,407 input tokens plus
68,923 output/thinking tokens, 327,330 total. At Flash rates this is **$0.2498 USD**,
regardless of whether every returned review result passed local validation.

## Changing this code

Read `src/reporting/usage.ts`, `src/runtime/runner.ts`, and `test/usage.test.ts`.
Preserve counting before application validation, per-attempt pricing, unknowns,
and the distinction from the admission ledger. Never double count thinking. The
publication regression checks the same dollar figure in PR and artifact text.

Verify exact model rates and update their source/date when adding or changing them.
If tools, modalities, caching charges, batch, priority or flex service are added,
revisit the calculation before claiming those requests are priced. Never silently
apply text-standard rates to a different billing mode.

## Attempt diagnostics and automatic cache metadata

Reports retain optional cachedContentTokenCount and each attempt's purpose, outcome,
protocol version, request hash and effective thinking budget. Initial work, lookup
continuations, invalid replacements, transport retries and truncation recovery are
distinct. Required lookup continuation is not classified as waste.

Cached tokens are a subset of input, not additional consumption. Missing cache
metadata is unknown; counts exceeding the reported prompt are excluded. The price
formula remains before cache discounts. No explicit cache or storage fee is created.
Ordered base rules form a stable prefix, but automatic cache hits are not guaranteed.

## PR presentation

The main PR comment uses a compact Dr. Concret.io footer with model, total tokens
including thinking, and estimated USD cost to four decimal places. It appears after
the workflow link and before expandable sections. The estimate is before cache
discounts and covers this invocation only.

The expandable Usage breakdown shows input, output including thinking, the thinking
subtotal and cached input. Cached tokens are already included in input. Missing
values say Not reported; partial component values say reported subset. Only missing
total usage or unavailable/incomplete pricing adds a short warning to the footer,
with attempt coverage. Partial totals say reported tokens and costs say Partial
estimate. Zero attempts remain zero; all-unknown usage is unavailable.

Keep admission reservations, detailed attempt coverage and pricing diagnostics in
artifacts. Do not reuse the diagnostic artifact renderer in PR comments. Presentation
changes require local rendering and publication checks, not paid model calls.
