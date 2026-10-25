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
