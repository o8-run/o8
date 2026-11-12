# Contributing

o8 is maintained by one person, and review capacity is limited. Small, focused changes have a realistic path to review; large unsolicited patches usually do not.

## How fast this moves

`main` changes many times a day. Most of the code is written by coding agents, every change gets an independent review by a different agent or a person, and approved pull requests land through a merge queue.

Measured on 2026-11-12 (recompute before you quote these):

| Measure | Value | Command |
| --- | --- | --- |
| Pull requests merged in the last 7 days | 299 | `gh pr list --repo o8-run/o8 --state merged --search "merged:>=2026-11-05" --limit 500 --json number --jq length` |
| Pull requests merged on 2026-11-12 | 65 | same command with `merged:>=2026-11-12` |
| Open issues labeled `claimable` | 23 | `gh issue list --repo o8-run/o8 --label claimable --limit 100 --json number --jq length` |
| CI on a pull request | about 20 minutes | the Actions tab |

What that means for you:

- **Claim before you start.** An unclaimed issue can be picked up and fixed within hours. See [Claiming work](#claiming-work).
- **Keep it small.** One concern per pull request. A change that takes a week to write will conflict with `main` several times before it is ready.
- **Rebase or merge `main` before you ask for review,** and expect to do it again if review takes more than a day.
- **A red check is not ready,** even when the failure looks unrelated. Check whether it also fails on `main`; if it does, say so with the run link.
- **Merged is not released.** A change is on `main` first, then in a beta build, then in a stable release. [`ROADMAP.md`](./ROADMAP.md) keeps those states apart.

## What we accept

- Bug fixes with a clear reproduction.
- Reliability and performance improvements with evidence.
- New runtime adapters that follow the six-file recipe in [`docs/internals/runtime-adapter-contract.md`](./docs/internals/runtime-adapter-contract.md).

[`ROADMAP.md`](./ROADMAP.md) is the map of what is open and what each arc has to satisfy to be finished. Work that appears there has already been scoped and accepted.

## What we do not accept

- Large refactors without prior agreement.
- Features that were not requested or discussed.
- Style-only churn, dependency reshuffling, or rewrites that do not change behavior.

Open an issue before starting any non-trivial change. An issue is not a promise that a pull request will be accepted, but it can prevent both sides from spending time on work that does not fit the project.

The way we run issues, pull requests, and merges is written down in [docs/operations/github-operating-standard.md](./docs/operations/github-operating-standard.md).

## Claiming work

Where help is most useful right now:

- **Issues labeled [`claimable`](https://github.com/o8-run/o8/issues?q=is%3Aissue+is%3Aopen+label%3Aclaimable).** Many are test failures and flaky tests with the failing test named in the issue, which makes them good first changes.
- **Runtime adapters** for a coding tool o8 does not support yet, following the six-file recipe linked above.
- **Platform reports.** macOS opens the native app in [`native/o8-next/`](./native/o8-next/); Linux and Windows still open the web window. A reproduction on a platform the maintainer does not run every day is worth a lot.
- **Command-line and MCP gaps.** If a command's help does not tell you how to use it, or a tool returns an error an agent cannot act on, file it with the exact command and output.

Security-sensitive areas (worker sandboxing, credentials, authentication, network binding) are handled by the security maintainers. Report a problem there through [`SECURITY.md`](./SECURITY.md) instead of opening a pull request.

Find work through [`ROADMAP.md`](./ROADMAP.md). Each open arc there links to one tracking issue, and that issue's checklist lists its children. Pick an unchecked child labeled `claimable`: those have a brief that is complete enough to start from.

Comment "claiming" on the child issue. A maintainer flips the label to `claimed`, which expires seven days after the claim comment if no pull request links to the issue. That keeps an issue from sitting reserved by someone who moved on, and reclaiming it later is fine.

Branch from `main` in your fork, one branch per issue. Your pull request body needs an "Evidence" section that names the commit you tested and the exact commands you ran, with their results. A reviewer other than the author verifies the change, and a maintainer merges it. Pull requests carrying the `needs-review` label are the ones waiting on that independent review.

## Pull requests

Keep each pull request to one concern. Explain the problem, why the change belongs in o8, and how you verified it. Include before-and-after images for visible UI changes and call out any test or gate you could not run.

Pull requests from forks wait for maintainer approval before CI reports appear. After approval, the review bot writes its report to the workflow run summary instead of posting a pull request comment because fork workflow tokens are read-only.

Before submitting code changes, run:

```bash
npm run typecheck:fast          # must be clean
# Falls back to tsc 5.8 on Intel Macs and Windows.
# Slower TypeScript 5.8.2 cross-check: npm run typecheck:tsc
npm test                  # judge by the final summary, not by stderr
npx eslint <files you changed>
```

Rust changes also need the relevant Cargo check or test: from `native/o8-next/` for the native app, or from `src-tauri/` for the installer and host.
Documentation-only changes validate links and the checks relevant to the affected documentation.

### Test lanes

`npm test` is the hermetic unit completion gate, not the full suite. Its
[unit configuration](./config/vitest/vitest.unit.config.ts) excludes the resource-owning tests listed in
[`tests/test-classification.json`](./tests/test-classification.json). Use the same configuration for a focused unit test:

```bash
npm test
npx vitest run --config config/vitest/vitest.unit.config.ts src/lib/agents/codename.test.ts
```

Tests that own real processes, Git repositories, network listeners, or native resources belong to the explicit integration lane.
`npm run test:integration -- <file>` selects matching resource-owning test files and runs them serially with the
[integration configuration](./config/vitest/vitest.integration.config.ts). For example:

```bash
npm run test:integration -- tests/test-classification.test.ts
```

A filter matching no resource-owning test fails instead of silently running the unit lane. With no file filter,
`npm run test:integration` runs the integration lane; `npm run test:all` explicitly runs both unit and integration gates.

When adding or changing tests, use the existing classifier rather than maintaining the manifest by hand. It derives
resource ownership from [path and source markers](./scripts/lib/test-classification.mjs); tests without those markers stay in the unit lane.
Regenerate the manifest when those markers change, review its diff, and check it before submitting:

```bash
npm run test:classify
npm run test:classification:check
```

The check fails when the manifest does not match the current test sources. Keep the classification rules and integration
failure baselines intact; do not weaken them to make a test pass.

Three things about those gates that will otherwise waste your time:

- **The suite prints alarming output on purpose.** Negative-path tests emit things like `LOCKOUT BREACH`, authorization failures, and timeouts to stderr while passing. The Vitest summary and exit code are the verdict.
- **Treat repo-wide lint as a ratchet.** `npm run lint` permits the current warning baseline, and that ceiling only goes down. Keep lint fixes focused: when a pull request clears warnings, lower `--max-warnings` in `package.json` in the same pull request instead of leaving unused headroom.
- **Resource-owning integration tests can affect shared app state.** Some reach global paths outside `CORTEX_IDE_DATA_DIR`. Use isolated test state and quit the installed desktop app before running those tests. This caveat applies to the integration lane (including its part of `npm run test:all`), not the default hermetic `npm test` gate.

Use one of the established commit prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `perf:`, or `refactor:`. Files have an 800-line ceiling unless an existing waiver applies. New TSX styling uses inline style objects rather than new CSS classes.

Cross-process seams, persistence paths, authorization changes, and tool arguments must be tested through the real production entry point. A helper-only unit test does not prove that callers can reach the behavior. [`CLAUDE.md`](./CLAUDE.md) and [`AGENTS.md`](./AGENTS.md) are the full contributor contracts for architecture, reachability testing, verification, and repository rules.

## AI-assisted contributions

AI-assisted pull requests are welcome. The person submitting the pull request is responsible for understanding the entire diff, reviewing it for scope and security, and running the stated verification. Unreviewed agent output, generated explanations that do not match the code, and pull requests whose author cannot explain the change will be closed.

## Review expectations

Review may take time because o8 has a solo maintainer. Opening a pull request does not create a review deadline or guarantee acceptance. Focused fixes with a reproduction and complete verification will be reviewed before speculative or broad changes.

When your pull request ships, the release notes and the public changelog thank you by your GitHub handle.

## Repository layout

- [`.agents/`](./.agents/) — repository-local agent skills.
- [`.claude/`](./.claude/) — Claude runtime settings, agents, hooks, and workflows.
- [`.codex/`](./.codex/) — Codex runtime settings and agent profiles.
- [`.github/`](./.github/) — CI workflows and GitHub contribution templates.
- [`assets/`](./assets/) — README and product media.
- [`brand/`](./brand/) — logo and application icon sources.
- [`cli/`](./cli/) — the `o8` command-line client.
- [`config/`](./config/) — checked-in tool configuration and release examples.
- [`dist/`](./dist/) — compiled hook scripts consumed by agent runtimes.
- [`docs/`](./docs/) — user guides, design references, internals, and operations runbooks.
- [`drizzle/`](./drizzle/) — database migration assets.
- [`examples/`](./examples/) — example directives and configuration patterns.
- [`licenses/`](./licenses/) — third-party license texts.
- [`patches/`](./patches/) — package-manager patches applied during install.
- [`protocol/`](./protocol/) — realtime protocol contracts and generated bindings.
- [`public/`](./public/) — static assets served by Next.js.
- [`scripts/`](./scripts/) — development, verification, build, and release tooling.
- [`src/`](./src/) — the Next.js application and shared TypeScript domain logic.
- [`src-tauri/`](./src-tauri/) — the Tauri shell and native Rust code.
- [`tauri-plugin-mcp/`](./tauri-plugin-mcp/) — the bundled Tauri MCP plugin.
- [`tests/`](./tests/) — cross-cutting Vitest suites, fixtures, and Playwright specs.
