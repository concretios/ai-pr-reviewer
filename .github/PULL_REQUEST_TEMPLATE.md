## Demo Video

> **Required for any behavior-changing PR** (scripts, prompt, schema, action inputs). Record a short Loom, Google Drive (public), or any publicly hosted video (2-5 min) showing:
> 1. What you changed and why
> 2. A live review run triggered against a real PR
> 3. The output: summary comment + inline comments rendered on GitHub
>
> Docs-only or refactor-only PRs may skip the video. All others will not be reviewed without one.

**Video link:** <!-- paste Loom / Drive / YouTube link here -->

---

## Summary

**What:** <!-- What does this PR do? -->

**Why:** <!-- What problem does it fix or improve? Link any related issue. -->

## Type of change

- [ ] Bug fix
- [ ] New feature / enhancement
- [ ] Prompt or review logic change (`prompts/code-review.md`)
- [ ] Schema change (`schemas/review-output.json`)
- [ ] Script change (`scripts/`)
- [ ] `action.yml` input/output change
- [ ] Docs only
- [ ] Refactor (no behavior change)

---

## Testing checklist

- [ ] Ran against a real PR end-to-end

  Link: <!-- paste PR URL here -->

- [ ] `shellcheck` passes on all changed scripts
- [ ] No `pipefail`-related failures (tested error paths, not just happy path)
- [ ] Gemini response parsed cleanly by `jq` (no parse errors in logs)
- [ ] Summary comment posted correctly to GitHub
- [ ] Inline comments posted at the correct line numbers
- [ ] Gemini model string unchanged (or document new model + cost impact below)
- [ ] Tested with `context_depth: diff-only`, `changed-files`, and/or `related` as applicable

---

## action.yml changes

<!-- Fill out only if you changed action.yml inputs or outputs. -->

- [ ] No `action.yml` inputs or outputs were added, removed, or renamed
- [ ] Yes, changed: <!-- list each changed input/output and confirm README + consumer-workflow.yml are updated -->

**Consumer upgrade required?** <!-- Does the consumer workflow YAML need changes? Does a new secret need to be added? -->

---

## Prompt / schema changes

<!-- Fill out only if you changed prompts/code-review.md or schemas/review-output.json. -->

**What review behavior changes?**
<!-- Better findings? Different severity calibration? New categories? -->

**Fields added or removed from JSON output?**
<!-- List any schema additions/removals and confirm post-review.sh handles them -->

**Estimated cost delta:**
<!-- ~X tokens, ~$Y per review vs. before this change -->

**Before / after excerpt:**
<!-- Paste a short before/after snippet of a real review finding to show the quality delta -->

---

## Breaking changes for consumers

- [ ] No breaking changes (`@v1` consumers unaffected)
- [ ] Yes, breaking

  **What breaks:** <!-- describe the impact -->

  **Upgrade path:** <!-- where is this documented? README section / new docs file? -->

---

## Notes for reviewer

<!-- Open questions, tricky areas, or where you want focused feedback. -->
<!-- Common focus areas for this repo: inline comment line-number accuracy, Gemini parse failures, @v1 consumer impact. -->
