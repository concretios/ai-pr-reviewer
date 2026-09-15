# AI PR Reviewer

This repository implements a bundled TypeScript GitHub action for advisory Gemini PR reviews.

Read README.md, docs/architecture.md, and docs/migration-v2.md for current contracts. The frozen Bash action under eval/baseline-v1 is evaluation material only.

## Development

Use Node 24 or newer. Run `npm ci`, `npm run check`, `npm test`, and `npm run build`. Commit the reproducible dist bundle and generated schema with source changes. Tests use mocked providers and GitHub transport. Paid evaluation is deliberately manual and cannot publish.

## Invariants

- Never execute or check out reviewed PR code in the production action.
- Read immutable Git source and governing rules/configuration from the captured base.
- Count complete requests and preserve honest coverage, finite retries, and conservative unknown usage.
- Check execution epoch after asynchronous work; late results cannot change finalized state.
- Persist every accepted concern in required detail pages and summary. Inline delivery is best effort.
- Derive analysis and publication statuses separately. Findings never determine exit status or a merge verdict.
- Use stable trusted-author markers, reconcile ambiguous writes, and recheck freshness between publication stages.
