# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately via [GitHub Security Advisories](https://github.com/concretios/ai-pr-reviewer/security/advisories/new) or email security@concret.io.

Do not open a public issue for security vulnerabilities.

## Data Flow

This action sends code from your repository to the Google Gemini API for analysis. Here is what gets sent, depending on your `context_depth` setting:

| Context Level | What is sent |
|---------------|-------------|
| `diff-only` | Only the PR diff (changed lines with surrounding context) |
| `changed-files` | Full contents of files modified in the PR |
| `related` | Changed files plus files that import or are imported by them |

Additional context sent with every review:
- Repository file tree (names only, no contents)
- Detected tech stack information
- Contents of any coding standards files (e.g., `CLAUDE.md`, `review-rules.md`)

## What stays local

- Your `GEMINI_API_KEY` is masked in GitHub Actions logs via `::add-mask::`
- The `GITHUB_TOKEN` is never sent to Gemini
- No data is stored by this action between runs

## Recommendations

- Use `diff-only` or `changed-files` for repositories containing sensitive code
- Review the [Gemini API Terms of Service](https://ai.google.dev/gemini-api/terms) for Google's data handling policies
- Store your `GEMINI_API_KEY` as a GitHub Actions secret, never hardcode it
