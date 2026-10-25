# Shell palette and workspace commands (#4548, item 2)

Baseline: `3b99b20d6` on main, independently of the server-link PR. Node 22,
stable Rust, Linux. No changes to shared `client.rs`, release, version,
deployment or publishing inputs.

The tests were written and run before implementation through the production
shell window factory, GPUI keyboard events and the existing disposable
`dev-server.ts --shell --review --terminal` entry point. The host uses production
middleware, packet state/diff handlers, terminal inventory and the real WebSocket
server/fixture PTY. No accounts or desktop application are involved.

## Red tails

```text
palette_keyboard_opens_all_surfaces_and_switches_workspaces
left: "Session"
right: "Diff"

palette_keyboard_workspace_command_is_filtered_and_cancel_keeps_focus
left: 0
right: 1

test result: FAILED. 0 passed; 2 failed
```

Hostile review added a mouse-down/up race before fixing it:

```text
target_click_keeps_identity_when_inventory_reorders
left: Some("next-review-reject")
right: Some("next-review-approve")
test result: FAILED. 0 passed; 1 failed
```

A further restoration race was reproduced before its fix:

```text
target_reopen_cancels_pending_restore
assertion failed: selected.is_none() && child.is_none()
test result: FAILED. 0 passed; 1 failed
```

## Green verification

```text
Native shell suite: 63 passed; 0 failed
Final target tests: 4 passed; 0 failed
Final palette tests, including PTY input and measurement: 3 passed; 0 failed
TypeScript: Test Files 3 passed (3); Tests 3 passed (3)
```

Native files: `src/shell_palette_tests.rs`, `src/shell_target.rs` (test module),
and the retained `src/shell_tests.rs`. TypeScript files at the repository root:
`tests/next-diff-review-real-path.test.ts`, `tests/next-terminal-real-path.test.ts`,
and `tests/next-surface-registration-real-path.test.ts`.

The primary keyboard flow opens session, grid, packet diff, terminal and message
input, selects an actual packet and existing PTY, receives the PTY's keyboard
echo, then switches workspaces from the filtered command palette. Escape keeps
composer focus. The old unavailable-command assertions now require actual tabs.

The three likeliest macOS/race failures have real-window tests:

1. Canonical paths: inventory uses the canonical fixture path while the selected
   workspace has a `/.` alias. Both packet and terminal choices remain visible.
2. A background target load finishes after switching workspaces. The selected
   workspace and its focused composer remain unchanged.
3. Inventory reorders during a click. The target ID bound at paint is retained;
   it is checked again before attachment. Row identity also uses the target ID,
   so a repaint cancels a moved click safely. Both repaint/no-repaint cases were
   reproduced red before fixing them. A removed ID cannot attach another row.

The additional test cancels a pending saved-target restore before the response
is applied. It stays in the picker instead of reopening the previous target.

The 8192 MiB `tsc --noEmit`, `typecheck:fast`, touched TypeScript ESLint,
rule-check, classification, native formatting and diff checks pass. Full npm
test is reserved for the end of the requested three-item batch.

Before/after: workspace commands **0 -> 2** in the two-workspace fixture;
requested usable palette destinations **3 -> 5**; unavailable diff/terminal
commands **2 -> 0**. Both initial failing regressions now pass.

## Measurements

Three separate, sequential debug test processes after completion checks. Earlier
warm-up samples collected during compilation/parallel checks were kept in local
scratch and are not mixed into these sequential runs. All samples from the
reported runs are retained, including cold workspace switches and outliers.
Nearest-rank percentiles, 30 palette samples and 20 workspace samples per run:

| Run | Palette p50 (ms) | Palette p95 (ms) | Workspace p50 (ms) | Workspace p95 (ms) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 16.898 | 19.917 | 14.011 | 25.401 |
| 2 | 17.665 | 19.012 | 14.155 | 20.095 |
| 3 | 17.823 | 19.014 | 14.451 | 18.880 |
| Median | 17.665 | 19.014 | 14.155 | 20.095 |

Palette timing starts before Ctrl+K/Cmd+K dispatch and ends after two explicit
CPU scene draws acknowledge the shell revision. Workspace timing starts before
Enter on an already filtered workspace command and ends when the selected
content is ready and painted. It includes persistence, event dispatch, first-use
HTTP loading and subsequent retained-view switches. Typing the filter and fixture
startup are excluded. First-use samples are included in the raw arrays.

These are GPUI TestAppContext CPU scenes, with test text and an unoptimized debug
build. They do not establish native-font, GPU/compositor or physical-input timing.
No comparable optimized before-performance baseline is claimed. Raw samples are
in `run-1.json`, `run-2.json`, `run-3.json`; percentiles are in `summary.json`.

Remaining for #4548: tolerant window-state recovery (item 3), complete native
process launch-to-interactive and standalone idle-memory measurement on a
supported display. The server-link PR is separate and must also land.


## Correction round 1

Rebased on `417586b6b`. The new real-window tests were written and run red before
changing dispatch or ownership:

```text
round1_focused_pty_receives_ctrl_k: a focused PTY owns Ctrl+K
round1_focused_text_field_keeps_ctrl_and_cmd_k: a focused text field owns its shortcut
round1_palette_owns_workspace_commands_and_renderer: workspace commands belong to their registered module
test result: FAILED. 0 passed; 3 failed
```

Read-only compatibility was also tested red before its fix for both session and
grid focus. Ctrl/Cmd+K now reaches a focused editor/terminal, including a real
PTY acknowledgement of byte 0x0b. Cmd/Ctrl+Shift+P is the explicit global palette
chord. A keystroke observer after dispatch verifies both Ctrl+K and Cmd+K traverse
the real focused composer without opening the palette or dropping its draft.

`surfaces/palette.rs` owns rendering, dynamic workspace commands, key handling,
filtering and selection. Its target widget and tests are in the same directory.
One registration line loads it. Shared lifecycle/chrome dispatch is an optional
ShellExtension with defaults; there is no Workspace variant or workspace routing
in the shared registry. Session/grid only expose narrow reading-focus queries.
Shared client.rs is unchanged. Palette invocations from focused controls use
the explicit chord; existing reading-focus shortcuts retain Ctrl/Cmd+K.

The rebased native suite exposed an unchanged Activity adjacency assertion:
current main inserts Pull Requests between Activity and Diff, but the assertion
still expects them to be adjacent. That unrelated test is left unchanged. The
final compatibility run excludes this known baseline failure and unrelated
Pull Requests model/registration tests; those model tests passed in the earlier
full native run.

The original timing table above is **Linux** headless debug CPU data from the
original head. macOS review p50 values supplied with the correction request are
**26.1 ms palette** and **43.0 ms workspace switch**; no macOS p95 was supplied.
Current Linux correction samples and the final gate results follow below.


Correction gates: the final scoped shell compatibility run is **84 passed, 0
failed** (112.81 s), including **7 palette tests** and **4 target tests**. Only
four palette invocations across `shell_tests.rs` and `projects_tests.rs` changed
to the global chord; eight other existing test files match the rebased head
byte-for-byte. The optional extension also compiles the unchanged surface probe.
The broader native probe additionally failed to start the absent o8d test binary
for `saved_history_surface_with_only_o8d`; no change to that unrelated test or
its environment is included. Full
`npm test` ran once: **1242 files passed, 3 skipped; 9057 tests passed, 5 skipped**
(767.87 s). The 8192 MiB TypeScript check, fast typecheck, classification,
touched-file ESLint/rule-check and native formatting/diff checks pass.

Three fresh sequential Linux debug CPU runs after verification, with all samples
retained (30 palette and 20 workspace samples per run):

| Platform and endpoint | p50 (ms) | p95 (ms) |
| --- | ---: | ---: |
| Linux palette CPU frame | 18.335 | 21.089 |
| Linux workspace CPU frame | 14.840 | 21.479 |
| macOS review palette (provided) | 26.1 | not supplied |
| macOS review workspace (provided) | 43.0 | not supplied |

Current Linux raw arrays and nearest-rank summaries are in `correction-round-1/`.
The timer boundaries and headless/debug limitations remain as documented above;
the global opening chord is now Cmd/Ctrl+Shift+P.


Final correction green tail:

```text
test result: ok. 84 passed; 0 failed; 0 ignored; 0 measured; 60 filtered out
```

Before/after: **3 review regressions failing -> 0**, plus the session/grid
reading-focus compatibility regression green. Final native test files are
`src/surfaces/palette_tests.rs`, `src/surfaces/palette_target.rs`,
`src/shell_tests.rs` and `src/projects_tests.rs`. The source and test moves
retain existing function names; `npm run test:classify` passes.
