# Window-state recovery (#4548, item 3)

Baseline: `44c5f79e2` on main. This is independent of the server-link and palette
branches. The existing shell already persisted geometry, tabs, workspace and
session/composer focus. The remaining defect was that malformed or incompatible
state aborted the native entry point before creating a window.

## Red receipts

Tests were written and run before changing the loader:

```text
shell_corrupt_or_missing_file_opens_defaults_without_crashing
invalid view state must fall back to defaults:
"Invalid shell state; original file retained"
test result: FAILED. 2 passed; 1 failed

invalid_shell_state_is_retained_through_native_entrypoint
state recovery must reach the normal server validation:
{"error":"Invalid shell state; original file retained"}
test result: FAILED. 1 passed; 1 failed
```

## Green receipts

```text
Window restart/fallback/focus tests: 3 passed; 0 failed
Native shell_cli tests: 2 passed; 0 failed
Existing shell_palette_switch_restart_and_server_down: 1 passed; 0 failed
```

Test files: `native/o8-next/src/shell_window_tests.rs`,
`native/o8-next/tests/shell_cli.rs`, and the existing
`native/o8-next/src/shell_tests.rs`.

The window tests use the production GPUI shell window factory, existing real
fixture-host entry point, actual files and real session/grid surfaces. They close
and reopen against the same state file and check the native window bounds, tabs,
selected workspace and actual editor focus. No accounts, desktop application or
operator machine are involved.

Recovery variants: missing file, partial JSON, invalid UTF-8, invalid geometry,
incompatible version and a file over the existing 1 MiB limit. Each opens defaults,
loads a fixture session, closes normally and reads back the same state file.
The native binary regression demonstrates that invalid state falls through to
normal URL validation without overwriting the original bytes. GPUI tests then
exercise valid fixture origins and full window creation.

Before/after: window suite **2 passed / 1 failed -> 3 passed / 0 failed**;
native CLI suite **1 passed / 1 failed -> 2 passed / 0 failed**; fallback variants
completed before the first failure **1 -> 6**. Existing restart persistence stays
green; no extra geometry or focus implementation was needed.

Hostile review's three likely macOS/race failures have tests:

1. Negative coordinates on another display or temporary-path aliases. Preserve
   negative logical coordinates and canonical fixture roots; the state path also
   uses a `/.` alias. The native CLI fixture canonicalizes its temporary root.
2. Resize immediately followed by quit, before the next explicit draw. Restore
   the final 900 x 700 size together with the original position and two tabs.
3. Quit while the palette holds focus. Restart both transcript-focus and
   composer-focus cases and ensure focus returns to the actual session surface.

The loader still bounds reads to 1 MiB plus one byte and keeps save validation,
atomic replacement, owner-only file mode and I/O errors unchanged. Loading a
fallback does not write; a later normal persistence replaces the unusable file.
Shared client.rs and all release/version/deploy/publishing inputs are unchanged.

Completion checks: 8192 MiB `tsc --noEmit`, `typecheck:fast`, native formatting,
classification and diff checks pass. Touched files are Rust only: ESLint was
invoked with ignored files suppressed and has no applicable files; rule-check
reports zero eligible TypeScript files and zero violations.

End-of-batch verification:

```text
All three patches in an isolated checkout:
test result: ok. 71 passed; 0 failed; 0 ignored

Full npm test (once, on this branch):
Test Files 1242 passed | 3 skipped (1245)
Tests      9057 passed | 5 skipped (9062)
Duration   650.01s
```

The integration checkout applied the three patches without committing or merging
any branch. It exercised connection recovery, all requested palette surfaces,
workspace switching and window recovery together. Its 71 shell tests include all
new regressions and the existing registered-surface tests.

Verification scratch was moved outside the repository before final typechecks,
because the repository's broad TypeScript include also discovered the temporary
combined checkout. No TypeScript configuration change was needed.

Remaining for #4548: complete native-process launch-to-interactive and standalone
idle-memory measurement on a supported display. Palette/workspace CPU frame
percentiles are in the separate palette PR. These measurement gaps keep the
issue open. The separate server-link and palette PRs must also land.
