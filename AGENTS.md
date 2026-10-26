# o8 Repository Rules

These are the canonical operating rules for agents working in this repository. Read the sections
that apply to the current task once. Load scoped references only when their trigger applies.

## Outcome ownership and authority

- Turn the request into an observable outcome. Separate symptoms, established facts, hypotheses,
  and root cause. Choose the smallest complete remedy inside the requested scope.
- Read-only or diagnostic work stays non-mutating. A change request includes implementation,
  proportionate verification, a focused commit, push, and pull request. An operator or lead agent may
  merge a reviewed CI-green pull request under standing authorization; implementation workers and
  packets never self-approve or merge. Version bumps, releases, production changes, public posts,
  destructive actions, spending, credentials, and another person's machine remain operator gates
  unless the current task explicitly authorizes them.
- Preserve dirty worktrees and unrelated edits. Inspect status before editing, use explicit
  pathspecs, and never discard, stash, reset, or rewrite work you do not own.
- A plan, test, commit, merge, or delivered message is evidence, not automatic proof. Verify through
  the real entry point and report Outcome, Evidence, Residual, and Decision.
- If blocked, preserve state and report the exact blocker, evidence, and shortest safe unblock.

## Verification and skills

For code changes, run `npm run typecheck:fast` and the required completion gates; use focused checks while iterating.
Run `npm run verify:ci` before pushing to execute the local CI checks. Use Node 22,
the npm version in `packageManager`, installed dependencies, and `bash` and `cargo-audit` on `PATH`
(install with `cargo install cargo-audit --locked`). Public dependency audits need network
access but no account credentials.

The command reads `.github/workflows/ci.yml` for Type Check, Lint, Test Classification,
all Hermetic Unit Tests shards, Server Bundle Size, Integration Tests (changed files),
Governance Smoke, and Security Audit. Fetch `origin/main` before running. Changed
integration files use CI's merge-base selector, including staged, unstaged and untracked
classified tests locally, and the same integration configuration and baseline as CI.
Install `ripgrep` and the system secure-shell tools for resource-owning tests.
When the routing ownership test is selected, the command also runs CI's conditional
browser installation before the integration command.
It sets `CI=true`, uses the CI test configuration and environment, gives type checking
an 8192 MiB heap, and runs the smoke in a fresh temporary data directory with its CI
timeout. Each check prints PASS or FAIL under its CI name; any failed command makes
the final exit status non-zero. Audit failures also block CI.

Dependency changes use the same credential-free lockfile audit in CI and locally:
added package versions fail at low severity, while unchanged baseline findings remain
the responsibility of the full audits. Nested package and native lockfiles are included.
Hosted reporting, native target builds and weekly integration lanes remain hosted
checks. The CI coverage guard rejects an unclassified
job or an unsupported action in a local check. Update the local implementation or its
explicit hosted classification whenever CI changes; unknown checks never silently pass.

Read only matching skills before the relevant work:

- [Code](.agents/skills/o8-code/SKILL.md), [UI/TSX](.agents/skills/o8-ui/SKILL.md), [checks](.agents/skills/o8-checks/SKILL.md).
- [Issues/PRs/commits](.agents/skills/o8-contribute/SKILL.md).
- [Agents/high-risk review/CLI](.agents/skills/o8-delegate/SKILL.md), [release](.agents/skills/o8-release/SKILL.md).
