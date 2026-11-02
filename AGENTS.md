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
Read only matching skills before the relevant work:

- [Code](.agents/skills/o8-code/SKILL.md), [UI/TSX](.agents/skills/o8-ui/SKILL.md), [checks](.agents/skills/o8-checks/SKILL.md).
- [Issues/PRs/commits](.agents/skills/o8-contribute/SKILL.md).
- [Agents/high-risk review/CLI](.agents/skills/o8-delegate/SKILL.md), [release](.agents/skills/o8-release/SKILL.md).
