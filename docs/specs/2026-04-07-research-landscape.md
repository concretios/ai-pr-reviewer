# AI PR Review: Research Landscape

**Date:** 2026-04-07
**Purpose:** Reference document capturing the competitive landscape, existing tools, and architectural patterns discovered during research.

## Official Google Solutions

### Gemini Code Assist (GitHub App)
- **URL:** https://github.com/marketplace/gemini-code-assist
- **Cost:** Free tier (180K completions/month, 240 chats/day). Standard: $19/user/mo.
- **Custom rules:** `.gemini/styleguide.md` + `config.yaml` in `.gemini/` folder
- **Config options:** severity threshold, max comments, file ignore patterns, memory
- **How it works:** Install as GitHub App. Auto-assigned as reviewer on PR creation.
- **Verdict:** Zero effort but limited customization. Good baseline.

### google-github-actions/run-gemini-cli (1.9k stars)
- **URL:** https://github.com/google-github-actions/run-gemini-cli
- **Cost:** API costs only (free tier available)
- **Custom rules:** `GEMINI.md` at repo root + prompt input
- **How it works:** GitHub Action that invokes full Gemini CLI with MCP servers, Docker, GitHub App auth
- **Verdict:** Over-engineered for our needs. Requires GCP project, GitHub App, Docker.

### gemini-cli-extensions/code-review (~412 stars)
- **URL:** https://github.com/gemini-cli-extensions/code-review
- **How it works:** Extension for Gemini CLI adding `/pr-code-review` command
- **Verdict:** Useful reference for prompt design, but tied to the heavy run-gemini-cli stack.

## Community Gemini Actions

### truongnh1992/gemini-ai-code-reviewer (232 stars)
- **URL:** https://github.com/truongnh1992/gemini-ai-code-reviewer
- **Custom rules:** `.gemini/config.yaml` + `.gemini/styleguide.md`
- **Features:** File filtering, severity-based comments
- **Verdict:** Most popular community option. Clean design. Good reference.

### rubensflinco/gemini-code-review-action (24 stars)
- **URL:** https://github.com/rubensflinco/gemini-code-review-action
- **Custom rules:** `extra_prompt` parameter
- **Features:** Token-aware diff chunking
- **Verdict:** Simple but limited customization.

### sshnaidm/gemini-code-review-action (4 stars)
- **URL:** https://github.com/sshnaidm/gemini-code-review-action
- **Features:** Thinking mode, configurable context lines, model selection
- **Verdict:** Interesting thinking mode support. Small community.

## Multi-Provider Open Source Tools

### qodo-ai/pr-agent (10.5k stars)
- **URL:** https://github.com/qodo-ai/pr-agent
- **Providers:** 100+ via LiteLLM (OpenAI, Claude, Gemini, Deepseek, Ollama)
- **Custom rules:** 5-level config hierarchy via `.pr_agent.toml`, `extra_instructions` per tool
- **Large diff handling:** `large_patch_policy` (clip/skip), `TokenHandler`, auto_extended_mode with chunk-based processing
- **Comment style:** Inline committable suggestions, persistent comment mode, dual publishing
- **Platforms:** GitHub, GitLab, Bitbucket, Azure DevOps, Gitea, Gerrit
- **Verdict:** Most mature OSS option. Excellent reference architecture. Too complex to deploy for our use case.

### Gentleman-Programming/gentleman-guardian-angel
- **URL:** https://github.com/Gentleman-Programming/gentleman-guardian-angel
- **Providers:** Claude, Gemini, Codex, Ollama, LM Studio, GitHub Models
- **Custom rules:** `AGENTS.md` file loaded as review prompt
- **How it works:** Git hook + CI mode (`gga run --ci`)
- **Verdict:** Interesting AGENTS.md pattern. More of a git hook tool than GH Action.

### bobmatnyc/ai-code-review
- **URL:** https://github.com/bobmatnyc/ai-code-review
- **Providers:** Gemini, Claude, OpenAI, OpenRouter
- **Features:** 95% token reduction via TreeSitter-based semantic chunking, 15+ review types
- **Config:** `.ai-code-review.yaml`, env vars, CLI flags
- **Verdict:** Best token optimization approach. CLI tool, not a GitHub Action.

## SaaS Tools (Closed Source)

### CodeRabbit
- **Config:** `.coderabbit.yaml` in repo root
- **Custom rules:** `reviews.instructions` (global), `reviews.path_instructions` (per directory/glob)
- **Features:** Inline + summary comments, interactive chat via @coderabbitai, built-in linter integration
- **Verdict:** Gold standard for rule loading UX. Not open source.

### Kodus (Kody)
- **URL:** https://github.com/kodustech/kodus-ai
- **Key differentiator:** AST + LLM hybrid (deterministic AST feeds structured context to LLM, reduces false positives)
- **Auto-discovery:** Reads `.cursor/rules/`, `CLAUDE.md`, `.windsurf/rules/` automatically
- **Verdict:** Best approach for reducing noise. Worth watching.

### Bito AI
- **Auto-discovery:** `.cursor/rules/*.mdc`, `.windsurf/rules/*.md`, `CLAUDE.md`, `GEMINI.md`, `AGENTS.md`
- **Feedback loop:** 3 negative feedback instances auto-generate a suppression rule
- **Citations:** Every comment links to the specific guideline that triggered it
- **Verdict:** Best multi-source rule loading pattern. Proprietary.

## Key Architectural Patterns

### Context Strategies (from Graphite's analysis)

| Strategy | Coverage | Cost | Best For |
|----------|----------|------|----------|
| Diff-only | Local issues only | Minimal | Style/lint checks |
| Diff + changed files | Good local + file-level | Moderate | Default reviews |
| Diff + related files (imports, callers) | 80-90% of needed context | Moderate | Architecture-sensitive changes |
| Full repo / indexed graph | Maximum but noisy | High | Critical systems |

**Recommendation:** Diff + related files is the sweet spot.

### Comment Posting (GitHub API)

```
POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
{
  "commit_id": "sha",
  "body": "Overall review summary",
  "event": "REQUEST_CHANGES|APPROVE|COMMENT",
  "comments": [
    {
      "path": "src/api/handler.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "This function lacks error handling."
    }
  ]
}
```

The `line`/`side` approach uses actual line numbers. Multi-line comments use `start_line`/`start_side`.

### Gemini Structured Output

Gemini 2.5+ supports `response_json_schema` for guaranteed JSON output matching a schema. Works with Pydantic (Python) and Zod (TypeScript). Keys follow schema order. Guarantees syntactically valid JSON.

### Rules Loading Patterns

| Pattern | Used By |
|---------|---------|
| Repo-root config file | PR-Agent (.pr_agent.toml), CodeRabbit (.coderabbit.yaml), Bito (.bito.yaml) |
| Auto-discover AI rule files | Bito, Kodus (CLAUDE.md, .cursor/rules/, AGENTS.md) |
| System prompt injection from file | AI Code Review Action (review_rules_file) |
| TOML extra_instructions | PR-Agent (plain-English rules per tool section) |
| Path-scoped rules | CodeRabbit, Sourcery (different rules for different directories) |
| Feedback-driven rule generation | Bito, Kodus (negative feedback auto-creates rules) |

## Cost Comparison (per review, ~5K input + 2K output tokens)

| Model | Cost |
|-------|------|
| Gemini 2.5 Flash | ~$0.002 |
| Gemini 2.5 Flash-Lite | ~$0.001 |
| GPT-5 mini | ~$0.005 |
| Claude Haiku 4.5 | ~$0.015 |
| Claude Sonnet 4.6 | ~$0.045 |

## Key Sources

- Graphite: https://graphite.com/guides/ai-code-review-context-full-repo-vs-diff
- Beyond the Diff (Vanna.ai case study): https://dev.to/jet_xu/beyond-the-diff-how-deep-context-analysis-caught-a-critical-bug-in-a-20k-star-open-source-project-5hce
- Gemini Structured Output: https://ai.google.dev/gemini-api/docs/structured-output
- GitHub PR Reviews API: https://docs.github.com/en/rest/pulls/reviews
- Composite vs Reusable Workflows: https://dev.to/n3wt0n/composite-actions-vs-reusable-workflows-what-is-the-difference-github-actions-11kd
- Google Codelabs (code review with Gemini): https://codelabs.developers.google.com/genai-for-dev-github-code-review
- Gemini Code Assist customization: https://developers.google.com/gemini-code-assist/docs/customize-gemini-behavior-github
