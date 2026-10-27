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
Independent checks run concurrently; governance waits for Type Check. Test commands
share one local execution queue so their module caches and worker pools do not collide.

Dependency changes use the same credential-free lockfile audit in CI and locally:
added package versions fail at low severity, while unchanged baseline findings remain
the responsibility of the full audits. Nested package and native lockfiles are included.
The o8 next Native Tests (Linux) check also runs on Linux x64, using CI's locked
Cargo build for the HTTP fixture daemon and all four headless suite shards. CI runs
the shards on separate jobs; local verification runs them serially against one Cargo
target cache, retaining every discovered test exactly once. Native
build/cache outputs are excluded from lint and type checking; source fixtures remain checked. Install
the system prerequisites listed in `.github/actions/next-linux-setup/action.yml` and
the stable Rust toolchain. Its selector compares against `origin/main` and includes
committed, staged, unstaged and untracked native inputs. A TS-only change prints SKIP
and runs no native build. Other platforms print HOSTED with the Linux x64 requirement.
Hosted reporting, other native target builds and weekly integration lanes remain hosted
checks. The CI coverage guard rejects an unclassified
job or an unsupported action in a local check. Update the local implementation or its
explicit hosted classification whenever CI changes; unknown checks never silently pass.

Read only matching skills before the relevant work:

- [Code](.agents/skills/o8-code/SKILL.md), [UI/TSX](.agents/skills/o8-ui/SKILL.md), [checks](.agents/skills/o8-checks/SKILL.md).
- [Issues/PRs/commits](.agents/skills/o8-contribute/SKILL.md).
- [Agents/high-risk review/CLI](.agents/skills/o8-delegate/SKILL.md), [release](.agents/skills/o8-release/SKILL.md).
