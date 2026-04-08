# AI PR Reviewer

Lightweight, reusable GitHub Action for automated AI-powered code review on pull requests using Google Gemini Flash.

## Quick Start

1. Get a free Gemini API key at https://aistudio.google.com/apikey
2. Add it as a repository secret named `GEMINI_API_KEY`
3. Copy the workflow below into `.github/workflows/ai-review.yml`
4. Open a PR

```yaml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: concretios/ai-pr-reviewer@v1
        with:
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
```

See `examples/consumer-workflow.yml` for the full example with @mention trigger and all inputs documented.

## How It Works

```
PR opened/updated
  -> gather-context.sh  (diff, changed files, related files, tech stack, project tree)
  -> review.sh          (load rules, assemble prompt via jq, call Gemini API)
  -> post-review.sh     (summary comment + inline review comments)
```

The action auto-discovers coding standards from common locations in the repo. No extra config needed if the client already has `CLAUDE.md`, `AGENTS.md`, or `vibe-coding-rules/`.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `gemini_api_key` | Yes | - | Gemini API key (free from aistudio.google.com) |
| `github_token` | No | `github.token` | Override with PAT for cross-repo access |
| `rules_paths` | No | `review-rules.md,CLAUDE.md,AGENTS.md,GEMINI.md,vibe-coding-rules/,.cursor/rules/` | Comma-separated paths to coding standards files or directories |
| `context_depth` | No | `changed-files` | `diff-only`, `changed-files`, or `related` |
| `model` | No | `gemini-2.5-flash` | Gemini model to use |
| `post_inline_comments` | No | `true` | Post inline comments on specific diff lines |
| `comment_severity_threshold` | No | `low` | Minimum severity for inline comments: `critical`, `high`, `medium`, `low` |
| `submit_review_verdict` | No | `false` | Map AI verdict to GitHub APPROVE/REQUEST_CHANGES (blocks merging) |
| `max_files` | No | `20` | Skip review if PR touches more files than this |
| `max_diff_size` | No | `10000` | Max diff lines before "large PR" guidance |
| `bot_name` | No | `dr-concretio` | Name for @mention trigger and comment identification |

## Cost

| Context Level | Typical Tokens | Cost per Review |
|---------------|----------------|-----------------|
| `diff-only` | 2-5K | ~$0.002 |
| `changed-files` | 10-30K | ~$0.005-0.015 |
| `related` | 30-80K | ~$0.015-0.035 |

Based on Gemini 2.5 Flash Standard tier: $0.30/M input, $2.50/M output (incl. thinking tokens).

## Coding Standards Auto-Discovery

The action scans for these files automatically. No configuration needed if they exist:

| File/Directory | Used by |
|----------------|---------|
| `review-rules.md` | General review rules |
| `CLAUDE.md` | Claude Code users |
| `AGENTS.md` | Agent configuration |
| `GEMINI.md` | Gemini-specific rules |
| `vibe-coding-rules/` | Directory of `.md` rule files |
| `.cursor/rules/` | Cursor users |

If none are found, the AI suggests creating them with starter content for the detected tech stack.

## @Mention Trigger

Add the `issue_comment` trigger to allow on-demand reviews:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]
```

Then comment `@dr-concretio review` on any PR. Only OWNER, MEMBER, and COLLABORATOR can trigger this.

## Running Tests Locally

```bash
bash test/mock-review.sh
```

Runs the full pipeline with mocked `gh` and `curl`. No API keys needed.

## File Structure

```
ai-pr-reviewer/
├── action.yml                     # Composite action entry point
├── scripts/
│   ├── lib.sh                     # Shared utilities (logging, retry, validation)
│   ├── gather-context.sh          # PR metadata, diff, changed files, tech stack
│   ├── review.sh                  # Rules loading, prompt assembly, Gemini API call
│   └── post-review.sh             # Summary comment + inline review comments
├── prompts/
│   └── code-review.md             # Prompt template (the "brain" of the system)
├── schemas/
│   └── review-output.json         # JSON schema for Gemini structured output
├── examples/
│   └── consumer-workflow.yml      # Full example workflow for consumer repos
├── test/
│   └── mock-review.sh             # Local integration test with mocked commands
└── .github/workflows/
    └── ci.yml                     # ShellCheck, YAML lint, JSON validation, integration test
```
