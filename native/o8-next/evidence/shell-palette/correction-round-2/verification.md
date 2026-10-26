# Palette correction round 2

Base: `0eeb65889` from current main. The rebase preserves both Setup and Palette
registrations and incorporates #4705's trusted boundary checker/workflow from
main. Those policy files and shared `src/client.rs` are unchanged by this PR.

## Boundary red and green

Before the fix, live PR metadata contained only `size/XL`. The trusted checker's
real entry point rejected the actual PR delta, naming each shared path and line
count. Representative red tail (the complete output is in `boundary-red.txt`):

```text
native/o8-next/src/shell.rs: 37 changed lines (+31/-6)
native/o8-next/src/shell_view.rs: 56 changed lines (+34/-22)
native/o8-next/src/surface_registry.rs: 58 changed lines (+58/-0)
only one added registration line is allowed; use label shell-work for shared work
```

The PR now has `shell-work` and a one-line reason for shared dispatch. Repeating
the same checker against the rebased head with live label metadata is green:

```text
o8 next surface boundary: exempt (label shell-work)
```

Before/after: **1 boundary failure -> 0**; explicit shell-work authority **absent
-> present**. The checker and workflow were **absent -> present** through rebase,
with no PR-owned policy edits. The palette depends on the shared ShellExtension
and KeyResult protocol, so this is declared shell work and uses whole-shell
compilation. No isolated surface-only compilation result is claimed.

## Rebase integration regression

The rebased Setup lifecycle test exposed palette dispatch bypassing its registered
busy guard. This was reproduced before changing the palette. The test was expanded
to Ctrl+K, Cmd+K, Ctrl+Shift+P and Cmd+Shift+P, plus idle global navigation.

```text
onboarding_module_owns_busy_navigation_and_does_not_reopen_after_close
busy setup must block palette navigation: ctrl-k
test result: FAILED. 0 passed; 1 failed
```

The focused green run is **1 passed, 0 failed**. Palette navigation now consults
registered key handlers after its focused-control propagation check. The editor
and PTY ownership condition is preserved. Only the existing lifecycle test's
palette assertions changed; no Setup production code or public test setter was
added.

The three likeliest macOS/race failures have coverage:

1. A focused editor or PTY loses Ctrl/Cmd+K: the retained real-window probes verify
   editor draft/focus and actual PTY Ctrl+K acknowledgement. The review independently
   replayed old capture red and confirmed the current guard green.
2. Inventory or focus changes while a command is pending: existing canonical-path,
   stale-restore, workspace-switch and mouse-down/up target-identity cases remain.
3. A new main registration or busy view loses its policy: the rebase preserves
   Setup; the expanded real GPUI lifecycle test blocks all four palette chords
   while busy and permits global navigation after release. The trusted boundary
   CLI is exercised using actual before/after PR-label events.

## Reviewer measurements

Latest reviewer-provided macOS CPU-scene p50 values, in milliseconds:

| Run | Palette open | Workspace switch |
| --- | ---: | ---: |
| Independent | 38.4 | 63.1 |
| Paired old | 34.1 | 62.6 |
| Paired head | 44.1 | 42.7 |

The independent and paired figures are separate runs. No macOS p95 or raw arrays
were supplied. The **26 ms open target remains unconfirmed**. Earlier Linux
headless debug CPU samples stay explicitly labeled Linux in round 1; they do not
establish the macOS target. The latest values are retained in `reviewer-macos.json`.

Remaining for #4548: confirm the 26 ms palette-open target and obtain complete
native-process startup/standalone idle-memory measurements on a supported display.
The server-link and window-state work remains separate. This PR keeps Refs #4548.

## Completion receipts

```text
Focused palette/target/Setup guard run: 12 passed; 0 failed
  Palette: 7 passed (including real PTY Ctrl+K and editor draft/focus)
  Target identity/restoration: 4 passed
  Expanded Setup busy lifecycle: 1 passed
Server real-path tests: 3 passed
Boundary CLI tests: 19 passed
Classifier completed: 1238 hermetic, 911 resource-owning
Full npm: 1242 files passed; 3 skipped
Tests: 9074 passed; 5 skipped
Duration: 419.32 s
```

The broader native compatibility sweep reported **105 passed, 1 failed**: the
unchanged Issues mouse-down/frame/mouse-up case waited for `issue-view-17` to
paint. Its isolated real-entry-point rerun passed **1 test** (2.65 s). That file
and its helpers remain unchanged; both results are retained in local receipts.
The focused 12-test green run includes every changed behavior and both confirmed
shortcut probes. No extra Issues work is included.

The 8192 MiB `tsc --noEmit`, `typecheck:fast`, eligible TypeScript ESLint,
touched-file rule-check, palette-module formatting and diff checks pass. ESLint
was also invoked on changed Rust files with ignored-file warnings suppressed.
The classifier completed all its probes. The server suite initially timed out
starting its disposable terminal host under concurrent verification; the final
three-server-test run passes. The boundary suite's pinned bootstrap commit was
fetched read-only before its final **19 passed** run. No policy or timeout was
weakened.

Native files: `src/surfaces/palette_tests.rs`,
`src/surfaces/palette_target.rs`, `src/surfaces/setup/view_lifecycle_tests.rs`.
Server/policy files: `tests/next-diff-review-real-path.test.ts`,
`tests/next-terminal-real-path.test.ts`,
`tests/next-surface-registration-real-path.test.ts`,
`tests/next-surface-boundary-real-path.test.ts`.

Before/after: busy navigation regression **1 failed -> 1 passed**, preserving
editor/PTY ownership; boundary classification **failed -> declared exemption**.
No release, version, deploy, publishing or trusted policy files changed.
