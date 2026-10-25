# Projects and repositories (#4548)

The opt-in shell has a Projects entry in its header and command palette, including
when no repository or session exists. It reuses the shared theme, GPUI text editor,
session sidebar and retained session/grid views. The installed app and launcher
defaults are unchanged. No dependencies, manifests or release files changed.

The native client uses the desktop project store, project ledger, membership and
repository routes with the existing operator bearer. Project mutations use stable
project IDs, with duplicate display names rejected before native saves. Removing a repository keeps
its local folder, clears removed native views only after confirmation, and retains
the server's runtime-stop refusal. Registration reconciles an unconfirmed write
by canonical path and preserves an existing membership role.

Review correction 1 removes display-name identity resolution and resolves Open
targets by repository ID from fresh inventory. Its separate red/green receipts
and results are in [correction-1](correction-1/verification.md). The timing samples
below record the initial implementation.

Review correction 2 adds the shared live-runtime refusal to project deletion,
resolves legacy ledger/SQLite ID pairs, and prevents rename/delete from recreating
a project or retaining its exclusive repository under another ID. See
[correction-2](correction-2/verification.md) for the strengthened regressions and
current verification results.

## Desktop parity

| Desktop control | Native counterpart | Status |
| --- | --- | --- |
| Open Projects / close page | Header or palette / Back to workspace | Ported |
| New project | New project, name and optional slug fields | Ported |
| Description | Shared editor in create/edit form | Ported |
| Save / Cancel form | Save project / Cancel | Ported |
| Search projects / no matches | Search editor / no-match state | Ported |
| Details / All projects | Details / All projects | Ported |
| Edit name and description | Edit form | Ported |
| Delete / confirm / cancel | Confirmation using the panel project DELETE | Ported |
| Active project picker | Switch project, including projects without sessions | Ported |
| Open workspace | Active-project POST, then existing native repository view | Ported |
| Repository membership checkboxes | Details: Add to project / Remove from project | Ported through Details |
| Repository role picker | Details: cycle the same curated roles and no role | Ported |
| Main repository choice | Details: Set main / Main repository | Ported |
| Add an unassigned repository to a project | Details: Add to project | Ported |
| Enter an existing Git folder | Add repository path editor | Ported |
| Validate folder | Validate folder through the production registry POST | Ported |
| Register folder | Add repository; Details supplies the target project | Ported |
| Retry an unconfirmed registration / project link | Reconcile canonical path and reuse registration | Ported |
| Reconnect a registered repository | Reuse entry and preserve existing role | Ported |
| Remove repository / confirm / cancel | Same registry DELETE and runtime-stop refusal | Ported |
| Missing folder state | Missing-folder notice; Open repository disabled | Ported |
| Repository focus / saved chats | Existing shell workspace and session sidebar | Ported using existing views |
| Loading / busy / errors / retry | Loading, Saving, error and Refresh states | Ported |
| Empty projects / empty repositories | First-run messages with create/add controls | Ported |
| Browse folder | Typed local path is available; no OS picker | Missing |
| Start from scratch / initialize a repository | No native initialization flow | Missing |
| Choose target project inside Add Repository | Open project Details before adding | Missing direct picker |
| Validation branch / remote / readiness details | Validation currently displays repository name | Missing details |
| Locate a moved repository | No native Locate action | Missing |
| Expand detailed repository cards | Simple native repository rows | Missing detailed cards |
| Open GitHub / remote connection flows | No native external-account flow | Missing |
| Project color picker | No color control | Missing |
| Move repository / drag onto project | Membership can be edited separately | Missing direct move |
| Repository setup commands / install-on-create | No settings form | Missing |
| Workspace isolation Auto / Instant macOS / Git worktree | No isolation selector | Missing |
| Environment files and Copy / Symlink / Skip | No environment settings | Missing |
| New workspace, name and base branch | No repository workspace-creation form | Missing |
| Launch agent, runtime, task name and prompt | Existing saved sessions can be opened | Missing launch form |
| Branch checkout, stash and force confirmations | No branch actions | Missing |
| Branch/worktree delete and cleanup | No branch/worktree actions | Missing |
| Open workspace in file manager / terminal | No external-open actions | Missing |
| Repository PR / review / CI status controls | No repository PR or CI controls | Missing |
| Per-repository agent rows / dismiss agent | Existing session sidebar only | Missing repository controls |
| Project Tasks / repository Control tab | No native task/control-room page | Missing |
| Project/repository context, instructions, spec and mission | No native detail tabs | Missing |
| Active context / stale locks / Archive lock | No native lock controls | Missing |
| Organization suggestion Group / Dismiss (settings) | No suggestion strip | Missing |

Full desktop parity remains open. The PR uses Refs rather than closing the issue.

## Real-entry verification

`projects_tests.rs` opens the production shell window under GPUI TestAppContext,
dispatches pointer, keyboard and text-input events, and checks persisted responses
from production routes behind production middleware. Fixture modes own their data,
Git folders and discovery records. They refuse account discovery and paths outside
their root. No operator machine, desktop app or real account is used.

The seven project tests cover first-run CRUD, membership/main/roles, search,
workspace focus, auth read/write refusal, retry, loading, cancellation, activation
and restart, duplicate/unconfirmed registration, role preservation, runtime-stop
refusal, and navigation alongside Inbox without losing saved composer focus.
Path assertions canonicalize both operands for macOS temporary-directory aliases.

Red receipts are retained beside this file. The initial shell entry tests failed
with `missing native control: shell-projects` (0 passed, 2 failed). Subsequent red
cases caught the missing active-project/palette controls, stale repository context
after switching/restarting, overwritten membership roles, and hidden composer
focus. The registration/removal workflow verifies persisted counts 0 -> 1 -> 0.

Reproduce with Node 22, Rust stable and the GPUI platform linker prerequisites:

```sh
cargo build --locked --manifest-path crates/o8d/Cargo.toml --features experimental-http
cargo test --locked --manifest-path native/o8-next/Cargo.toml -- --test-threads=1
cargo test --locked --manifest-path native/o8-next/Cargo.toml projects_ -- --nocapture --test-threads=1
npx vitest run tests/o8-next-shell-real-path.test.ts tests/next-history-real-path.test.ts
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit
NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:fast
npx eslint scripts/next/dev-server.ts scripts/next/projects-fixture.ts
npm run rule-check -- --base=origin/main
npm run test:classify
npm test
```

The existing o8d compatibility test requires the experimental-http build above.
The dependency audit ran for Linux and macOS: 472 and 455 declared packages,
respectively, with zero GPL or excluded application crates. The dependency graph
is unchanged by this PR.

## Final check results

- `projects_tests.rs`: 7 passing tests; `shell_tests.rs` including those tests: 10 passing.
- Full native suite: 43 unit tests and 7 CLI tests passed; 3 existing opt-in measurement tests ignored.
- `tests/o8-next-shell-real-path.test.ts` and `tests/next-history-real-path.test.ts`: 9 passed across 2 files.
- Full `npm test`: 1,233 files passed, 3 skipped; 8,896 tests passed, 5 skipped.
- TypeScript 5.8 `npx tsc --noEmit` and `typecheck:fast` passed with the 8 GiB heap setting.
- ESLint passed on both touched TypeScript files; rustfmt passed on the touched Rust files.
- Rule check passed against `origin/main`, scanning both touched TypeScript files with zero violations.
- Test classification: 1,229 hermetic and 878 resource-owning files; no manifest diff.

The shell was rebased onto the Inbox change on main and the full suites above ran
on that combined source. The navigation regression first failed when Projects
captured the hidden session's focus; the green case exercises the real Projects
and Inbox routes together. Compact/wide OS-rendered visual tuning remains pending;
this change uses the existing native theme and editor rather than claiming pixel
parity with desktop controls.

## Measurement endpoint

The samples measure dispatch of an actual control through fixture HTTP completion
to its first acknowledged GPUI CPU scene paint. They assert the corresponding
scene revision and settled action state. Projects-open and workspace-open each
have one sample per run; active-project switching has 20 per run. The build is
debug on Linux with GPUI's test text system. These are CPU scene measurements;
they do not establish font shaping, GPU presentation or physical input latency.
Raw samples are in run-1.json through run-3.json. Before this change the Projects
control did not exist, so there is no comparable before-latency value.

| Run | Projects open to first frame | Workspace open to frame | Active switch p50 | Active switch p95 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 14.56 ms | 20.62 ms | 21.80 ms | 29.72 ms |
| 2 | 14.73 ms | 18.07 ms | 22.12 ms | 28.93 ms |
| 3 | 14.75 ms | 21.57 ms | 20.82 ms | 24.84 ms |

Across 60 active-project switches: p50 21.56 ms, p95 28.93 ms.
