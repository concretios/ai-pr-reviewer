# Releases and consumer pins

Use semantic releases to name audited builds and full commit SHAs to select the
code that production consumers execute. This gives maintainers readable version
information without allowing a tag move to change a consumer's next workflow run.

## Consumer reference policy

| Stage | Reference | Policy |
| --- | --- | --- |
| Development or pilot | `concretios/ai-pr-reviewer@<full-sha>` | Required. Record the tested SHA and retain the previous pin for rollback. |
| Production, default | `concretios/ai-pr-reviewer@<full-release-sha> # v2.0.0` | Required for reproducible consumers. The comment names the immutable release that resolves to the SHA. |
| Automatic compatible updates | `concretios/ai-pr-reviewer@v2` | Opt-in only. The consumer accepts future compatible v2 releases without reviewing a pin change first. |

Never consume `main`, another development branch, an abbreviated SHA, or a
prerelease tag in production. The release comment supplies a readable identity for
the full SHA and lets Dependabot update both values together.

## Publishing a stable release

1. Enable GitHub immutable releases for this repository before publishing v2.
   Confirm the repository endpoint reports `enabled: true`; the organization does
   not currently enforce this setting.
2. Merge the release candidate to `main`. Release only a commit whose CI passed
   checks, tests, build, and generated `dist/` and schema drift verification.
3. Complete the required target-model smoke and representative pilot. Inspect the
   report and record partial coverage or unresolved quality judgment honestly.
4. Create a draft GitHub release from the exact audited `main` commit with a full
   semantic tag such as `v2.0.0`. Review release notes, action metadata, migration
   details and rollback SHA before publishing.
5. Publish the draft. Verify the release is marked immutable and its tag resolves
   to the intended commit. Treat a mismatch as a failed release.
6. Update consumer workflows through normal pull requests. Use the release commit
   SHA plus its version comment, verify the resolved SHA, and retain the previous
   pin in the PR for rollback.

Use a patch release for compatible fixes, a minor release for compatible features,
and a major release for input, output, runtime, permission, event, or behavior
changes that require consumer migration. Never retag or replace an immutable release.

## Upgrade automation

Consumers should enable weekly Dependabot version updates for the `github-actions`
ecosystem at directory `/`. Dependabot can update full-SHA action references and
their same-line semantic-version comments. Keep reviewer upgrades as reviewable
pull requests; do not auto-merge them because prompt, publication, permission and
model behavior can change while the action interface remains compatible.

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Only pin commits associated with published semantic tags. When a pinned action SHA
has no associated tag, Dependabot may advance it to an unreleased commit instead of
the latest stable release.

Dependabot vulnerability alerts for GitHub Actions require semantic-version
references and do not cover SHA-only references. This is a known tradeoff of the
safer execution pin. Track release notes and Dependabot version-update PRs rather
than relying on alerts alone.

## Floating major tag

Maintain `v2` only as a convenience channel after stable v2 releases exist. Move
it to the newest compatible immutable `v2.x.y` release after that release passes
the rollout gate. Because `v2` itself moves, consumers using it accept that their
executed code can change without a workflow commit. Do not use it for high-trust
`pull_request_target` workflows or other workflows that expose secrets to the
referenced action.

GitHub guidance: [immutable action releases](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/using-immutable-releases-and-tags-to-manage-your-actions-releases),
[secure action references](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/find-and-customize-actions),
[Dependabot for actions](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/auto-update-actions),
and [SHA comment updates](https://github.blog/changelog/2022-10-31-dependabot-now-updates-comments-in-github-actions-workflows-referencing-action-versions/).
