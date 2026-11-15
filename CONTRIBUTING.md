# Contributing

I maintain o8 by myself, with a lot of coding agents doing the typing. So this is the honest version of how to get something merged here.

Small, focused changes get reviewed. A big patch nobody asked for usually sits, because I can't review it well enough to trust it.

## How fast this moves

`main` changes all day. Agents write most of the code, a different agent or a person reviews every change, and approved work lands through a merge queue.

These are the numbers from November 12, 2026. Run the command yourself before you repeat one, because they go stale fast.

| What | Number | Command |
| --- | --- | --- |
| Pull requests merged in the last 7 days | 299 | `gh pr list --repo o8-run/o8 --state merged --search "merged:>=2026-11-05" --limit 500 --json number --jq length` |
| Pull requests merged on November 12 | 65 | same command with `merged:>=2026-11-12` |
| Open issues you can claim | 23 | `gh issue list --repo o8-run/o8 --label claimable --limit 100 --json number --jq length` |
| CI on one pull request | about 20 minutes | the Actions tab |

What that pace means if you want to help:

- **Claim it before you start.** An open issue can get picked up and fixed within hours here. See [Claiming work](#claiming-work).
- **Keep it small.** One concern per pull request. If it takes you a week to write, it will conflict with `main` a few times before it's ready.
- **Update from `main` before you ask for review.** If review takes more than a day, you'll probably have to do it again.
- **A red check means it isn't ready,** even when the failure looks like it has nothing to do with you. Check if it fails on `main` too. If it does, say so and link the run.
- **Merged doesn't mean released.** A change is on `main` first, then in a beta build, then in a stable release. [`ROADMAP.md`](./ROADMAP.md) keeps those apart.

## What I'll take

- Bug fixes with a clear way to reproduce the bug.
- Reliability and performance work that comes with evidence.
- A new runtime adapter that follows the six-file recipe in [`docs/internals/runtime-adapter-contract.md`](./docs/internals/runtime-adapter-contract.md).

[`ROADMAP.md`](./ROADMAP.md) is the map of what's open and what each piece has to do to be finished. If it's on there, it has already been scoped and accepted.

## What I won't take

- Large refactors we didn't agree on first.
- Features nobody asked for or talked about.
- Style-only churn, dependency shuffling, or rewrites that don't change behavior.

Open an issue before you start anything non-trivial. An issue isn't a promise that I'll merge the pull request, but it keeps both of us from spending time on something that doesn't fit.

How issues, pull requests and merges run here is written down in [docs/operations/github-operating-standard.md](./docs/operations/github-operating-standard.md).

## Claiming work

Where help does the most right now:

- **Issues labeled [`claimable`](https://github.com/o8-run/o8/issues?q=is%3Aissue+is%3Aopen+label%3Aclaimable).** A lot of them are test failures and flaky tests with the failing test named right in the issue, so they're a good first change.
- **Runtime adapters** for a coding tool o8 doesn't support yet. The six-file recipe is linked above.
- **Platform reports.** macOS opens the native app in [`native/o8-next/`](./native/o8-next/). Linux and Windows still open the web window. A bug you can reproduce on a platform I don't run every day is worth a lot to me.
- **Command-line and MCP gaps.** If a command's help doesn't tell you how to use it, or a tool hands an agent an error it can't act on, file it with the exact command and output.

Security-sensitive areas (worker sandboxing, credentials, authentication, network binding) belong to the security maintainers. If you find a problem there, report it through [`SECURITY.md`](./SECURITY.md) and don't open a pull request for it.

To pick something up, start from [`ROADMAP.md`](./ROADMAP.md). Each open arc links to one tracking issue, and that issue's checklist lists its children. Pick an unchecked child labeled `claimable`. Those have a brief that's complete enough to start from.

Comment "claiming" on the child issue. A maintainer flips the label to `claimed`. The claim expires seven days after your comment if no pull request links to the issue, so nothing sits reserved by someone who moved on. Reclaiming it later is fine.

Branch from `main` in your fork, one branch per issue. Your pull request needs an "Evidence" section with the commit you tested and the exact commands you ran, with their results. Someone other than the author verifies the change, and a maintainer merges it. Pull requests with the `needs-review` label are the ones waiting on that independent review.

## Pull requests

One concern per pull request. Tell me the problem, why the change belongs in o8, and how you checked it. For anything visible, include before and after images. If there's a test or gate you couldn't run, say that too.

Pull requests from forks wait for a maintainer to approve them before CI reports show up. After approval, the review bot writes its report to the workflow run summary and doesn't comment on the pull request, because fork workflow tokens are read-only.

Before you submit code, run:

```bash
npm run typecheck:fast          # must be clean
# Falls back to tsc 5.8 on Intel Macs and Windows.
# Slower TypeScript 5.8.2 cross-check: npm run typecheck:tsc
npm test                  # judge by the final summary, not by stderr
npx eslint <files you changed>
```

Rust changes also need the matching Cargo check or test: from `native/o8-next/` for the native app, or from `src-tauri/` for the installer and host. Documentation-only changes check their links and whatever checks apply to that documentation.

### Test lanes

`npm test` is the hermetic unit gate. It is not the full suite. Its [unit configuration](./config/vitest/vitest.unit.config.ts) leaves out the resource-owning tests listed in [`tests/test-classification.json`](./tests/test-classification.json). Use the same configuration for one focused unit test:

```bash
npm test
npx vitest run --config config/vitest/vitest.unit.config.ts src/lib/agents/codename.test.ts
```

Tests that own real processes, Git repositories, network listeners or native resources live in the integration lane. `npm run test:integration -- <file>` picks the matching resource-owning test files and runs them one at a time with the [integration configuration](./config/vitest/vitest.integration.config.ts). For example:

```bash
npm run test:integration -- tests/test-classification.test.ts
```

A filter that matches no resource-owning test fails. It does not quietly fall back to the unit lane. With no file filter, `npm run test:integration` runs the whole integration lane, and `npm run test:all` runs both gates.

When you add or change tests, use the classifier. Don't edit the manifest by hand. It works out resource ownership from [path and source markers](./scripts/lib/test-classification.mjs), and tests without those markers stay in the unit lane. Regenerate the manifest when the markers change, read its diff, and check it before you submit:

```bash
npm run test:classify
npm run test:classification:check
```

The check fails when the manifest doesn't match the current test sources. Leave the classification rules and the integration failure baselines alone. Don't weaken them to get a test to pass.

Three things about these gates that will cost you time if nobody tells you:

- **The suite prints scary output on purpose.** Negative-path tests write things like `LOCKOUT BREACH`, authorization failures and timeouts to stderr while they pass. The Vitest summary and the exit code are the verdict.
- **Repo-wide lint is a ratchet.** `npm run lint` allows the current warning count, and that ceiling only goes down. Keep lint fixes focused. When your pull request clears warnings, lower `--max-warnings` in `package.json` in the same pull request.
- **Integration tests can touch shared app state.** Some reach global paths outside `CORTEX_IDE_DATA_DIR`. Use isolated test state and quit the installed desktop app before you run them. This applies to the integration lane (and its part of `npm run test:all`), not to the default `npm test`.

Use one of the commit prefixes we already use: `feat:`, `fix:`, `chore:`, `docs:`, `perf:` or `refactor:`. Files have an 800-line ceiling unless an existing waiver covers them. New TSX styling uses inline style objects, not new CSS classes.

Anything that crosses a process boundary, writes to storage, changes authorization or changes tool arguments has to be tested through the real production entry point. A unit test on a helper doesn't prove a caller can reach the behavior. [`CLAUDE.md`](./CLAUDE.md) and [`AGENTS.md`](./AGENTS.md) are the full contracts for architecture, reachability testing, verification and repository rules.

## AI-assisted contributions

AI-assisted pull requests are welcome. Most of this repository is written that way. But you're the one submitting it, so you need to understand the whole diff, check it for scope and security, and run the verification you say you ran. I close pull requests that are unreviewed agent output, that come with an explanation that doesn't match the code, or that the author can't explain.

## What to expect from review

I'm one person, so review can take time. Opening a pull request doesn't start a clock and doesn't guarantee a merge. A focused fix with a reproduction and complete verification gets looked at before anything broad or speculative.

When your pull request ships, the release notes and the public changelog thank you by your GitHub handle.

## Repository layout

- [`.agents/`](./.agents/): repository-local agent skills.
- [`.claude/`](./.claude/): Claude runtime settings, agents, hooks, and workflows.
- [`.codex/`](./.codex/): Codex runtime settings and agent profiles.
- [`.github/`](./.github/): CI workflows and GitHub contribution templates.
- [`assets/`](./assets/): README and product media.
- [`brand/`](./brand/): logo and application icon sources.
- [`cli/`](./cli/): the `o8` command-line client.
- [`config/`](./config/): checked-in tool configuration and release examples.
- [`dist/`](./dist/): compiled hook scripts consumed by agent runtimes.
- [`docs/`](./docs/): user guides, design references, internals, and operations runbooks.
- [`drizzle/`](./drizzle/): database migration assets.
- [`examples/`](./examples/): example directives and configuration patterns.
- [`licenses/`](./licenses/): third-party license texts.
- [`native/`](./native/): the native macOS app (`native/o8-next/`, Rust and GPUI).
- [`patches/`](./patches/): package-manager patches applied during install.
- [`protocol/`](./protocol/): realtime protocol contracts and generated bindings.
- [`public/`](./public/): static assets served by Next.js.
- [`scripts/`](./scripts/): development, verification, build, and release tooling.
- [`src/`](./src/): the Next.js application and shared TypeScript domain logic.
- [`src-tauri/`](./src-tauri/): the Tauri shell and native Rust code.
- [`tauri-plugin-mcp/`](./tauri-plugin-mcp/): the bundled Tauri MCP plugin.
- [`tests/`](./tests/): cross-cutting Vitest suites, fixtures, and Playwright specs.
