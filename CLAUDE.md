# AI PR Reviewer

## Project Overview

A lightweight, reusable GitHub composite action that provides automated AI-powered code reviews on pull requests using Google Gemini Flash. Designed for teams managing multiple projects with different tech stacks and coding standards.

## Key Design Decisions

- **Gemini Flash** as the LLM: cheapest option (~$0.002-$0.01/review), 1M token context window
- **Composite action** delivery: consumer repos reference `concretios/ai-pr-reviewer@v1` with a ~15-line workflow YAML
- **Prompt-file architecture**: all review intelligence lives in `prompts/code-review.md`, scripts are thin plumbing
- **Three context levels**: `diff-only`, `changed-files`, `related` (includes files that import/are imported by changed files)
- **Structured JSON output**: Gemini's `response_json_schema` enforces the review output shape, no fragile parsing
- **Auto-discovery of rules**: scans for `vibe-coding-rules/`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/`, `review-rules.md`
- **Missing guardrails detection**: if no rules files exist, the review suggests creating them with starter content for the detected tech stack

## Architecture

```
Trigger (PR open or @mention)
  -> gather-context.sh (diff, changed files, related files, project tree)
  -> review.sh (assemble prompt from template + rules + context, call Gemini API)
  -> post-review.sh (post summary comment + inline review comments via GitHub API)
```

## Tech Stack

- Bash scripts (runs on GitHub Actions ubuntu-latest runners)
- `gh` CLI for GitHub API interactions (pre-installed on runners)
- `curl` + `jq` for Gemini API calls and JSON processing
- No Node.js/Python runtime required

## File Structure

```
ai-pr-reviewer/
├── action.yml                    # composite action entry point
├── scripts/
│   ├── gather-context.sh         # collects diff, changed files, related files, tree
│   ├── review.sh                 # orchestrator: assemble prompt, call Gemini, parse response
│   └── post-review.sh            # posts summary comment + inline review comments
├── prompts/
│   └── code-review.md            # prompt template with {{variables}}
├── schemas/
│   └── review-output.json        # JSON schema for Gemini structured output
├── examples/
│   └── consumer-workflow.yml     # example workflow for consumer repos
├── docs/
│   └── specs/                    # research and reference docs
└── README.md
```

## Coding Standards

- Shell scripts: use `set -euo pipefail`, quote all variables, use `shellcheck` conventions
- Keep scripts focused: one script per responsibility
- Prompt template uses `{{variable_name}}` placeholders replaced at runtime with `sed`
- All GitHub API calls go through `gh` CLI, not raw `curl`
- Gemini API calls use `curl` with structured output (`response_json_schema`)

## Consumer Usage

```yaml
- uses: concretios/ai-pr-reviewer@v1
  with:
    gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
    rules_paths: "vibe-coding-rules/,CLAUDE.md"
    context_depth: "related"
```

## Cost Model

Gemini 2.5 Flash Standard tier: $0.30/M input tokens, $2.50/M output tokens (incl. thinking tokens).

| Context Level | Tokens | Cost per Review |
|---------------|--------|-----------------|
| diff-only     | ~2-5K  | ~$0.002         |
| changed-files | ~10-30K| ~$0.005-0.015   |
| related       | ~30-80K| ~$0.015-0.035   |

## Research Context

This project was designed after extensive research of the AI code review landscape (April 2026):
- Google's official `run-gemini-cli` action exists but is over-engineered (MCP servers, Docker, GitHub Apps)
- PR-Agent (Qodo, 10k stars) is the most mature OSS option but complex to self-host
- Gemini Code Assist is free but offers limited custom rules support
- The "diff + related files" context strategy captures 80-90% of needed context (per Graphite's analysis)
- Gemini structured output (`response_json_schema`) guarantees parseable review JSON
