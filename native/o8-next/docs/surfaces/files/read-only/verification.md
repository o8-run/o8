# Read-only split verification

Built from the fetched, closed file-viewer branch at `620565bf5ea29cca50ff8ab0d57a13a3efd00e48`.
The initial red/green runs used main at `3484fb0187910952c852972032dbf5c2343fdf6a`;
the final branch is rebased on main at `915e84126c4e72254befc28bd545267cd6696e56`.
The commit-viewer and inline-diff branches were not changed.

## Red before implementation

Selected failing output, with process identifiers and local paths omitted:

```text
computed credential access must render masked before entering a frame
read-only source must expose no editor or Save control
test result: FAILED. 0 passed; 2 failed; 0 ignored; 0 measured; 188 filtered out; finished in 9.73s
```

Additional real-entry-point probes were written and failed before their fixes:

| Probe | Red result | Green behavior |
| --- | --- | --- |
| Directory browsing over the owned HTTP fixture | expected 404 to be 200; 1 failed | Authenticated root and nested browsing return 200 |
| Native preview above 32 MiB | expected 200 to be 413; 1 failed | 413 before decoding; ordinary desktop read still returns 200 |
| Computed environment receiver spelling | 0 passed; 1 failed; 2.96s | Comments, spacing, index and parenthesized forms mask |
| Escaped environment names | 0 passed; 1 failed; 2.62s | Hexadecimal and Unicode spellings mask |
| JavaScript identity/octal/continuation escapes | 0 passed; 1 failed; 2.88s | Static JavaScript escape semantics mask |
| Environment receivers in type assertions and wrapper calls | 0 passed; 1 failed; 4.43s | Receiver subtrees retain the mask |
| Wide source horizontal scrolling | 0 passed; 1 failed; 2.28s | Horizontal wheel scrolling reaches the source |
| Return to a masked Files tab | 0 passed; 1 failed; 3.78s | Focus returns to the rendered path field; safe path copy works |

## Green

```text
test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 225 filtered out; finished in 155.22s
Test Files  2 passed (2)
     Tests  10 passed (10)
Test Files  1246 passed | 3 skipped (1249)
     Tests  9103 passed | 5 skipped (9108)
```

The focused native run has 11 real-shell GPUI tests and two classifier matrix tests.
The inherited matrix checks 128 secret cells and 29 ordinary-reference controls
through authenticated file reads, rendered source and clipboard actions. The
read-only regressions additionally exercise computed keys, source input refusal,
both platform and control paste/save shortcuts, horizontal scrolling and focus
restoration when returning to masked source.
Browse, Open, Copy, file Refresh, folder Refresh, Up, Retry and close all use the
real shell or HTTP entry points and owned fixture files.

Test sources:

- `src/surfaces/files/tests.rs`
- `src/surfaces/files/readonly_tests.rs`
- `src/surfaces/files/privacy_matrix.rs`
- `tests/o8-next-files-real-path.test.ts`
- `tests/file-save-conflict-real-path.test.ts` (existing desktop route compatibility)

Checks also passed: TypeScript `tsc --noEmit` with an 8 GiB heap,
`typecheck:fast`, touched-file ESLint, touched-TypeScript rule checks, test
classification (1,242 hermetic and 928 resource-owning files), Rust formatting,
and Clippy for all targets with zero diagnostics in the files surface.
`verify-module.mjs` compiled only the surface and its one registration on main;
an attempted `Client::save_file` call failed with E0599.

The first full native run caught a source-audit parser ambiguity in `&raw[...]`.
The guard parameter was renamed without changing its behavior; the audit changed
from one failure to one pass. The final full native result is reported separately
from the focused surface and CLI checks.

The full native run before the final masked-focus correction ended with
227 passed, 5 failed and 6 ignored in 1018.80 seconds. All five failures
reproduce independently on a clean
checkout of main at `915e84126`, without the Files registration or module:

- `activity_empty_local_auth_and_scoped_retention`: missing `workspace-1`.
- `round1_symlink_worker_survives_real_refresh_and_send`: missing `session-refresh`.
- `glass_and_plain_open_through_the_production_shell`: missing expected shell control.
- `placement_shell_tabs_use_compact_rows`: missing expected tab control.
- `shell_chrome_fifteen_workspaces_keeps_one_switcher`: shared sidebar helper text.

The first two clean-main probes each failed 0/1; the shell group returned
8 passed, 3 failed and 2 ignored. The baseline worktree stayed clean; Cargo's
command-line patch configuration pointed to the identical immutable vendored
GPUI and Taffy sources to reuse dependency artifacts. These shared controls are
outside this surface's scope. All 11 Linux CLI tests passed separately.

## Measurements and captures

Two real-shell samples on the rebased branch, measured to a GPUI CPU scene
rather than a GPU or compositor presentation:

| Action | Rebase run (ms) | Final focused run (ms) |
| --- | ---: | ---: |
| Open to first frame | 92.48 | 129.48 |
| Open to loaded source frame | 124.95 | 181.69 |
| Copy to next frame | 67.05 | 93.22 |
| Refresh a 32 MiB file to loading frame | 410.13 | 513.49 |

The large snapshot renders at most 100,000 source characters and 2,049 characters
per painted row. Reads above 33,554,432 bytes are refused. These are samples on a
shared test runner, not latency percentiles or a desktop speed comparison.

`native-read-only.png` and `current-file-view.png` show the same owned TypeScript
file at 1200 by 816. The native capture uses the real X11/Vulkan GPUI window; the
current capture uses the production React FileViewer with bundled Monaco in
headless Chromium. The capture receipt records zero mutation requests. No
operator desktop, account or private file was accessed.

macOS execution, GPU presentation timings, rich Markdown, source selection/find,
AI editing and content/diff switching are not claimed by this read-only split.
The future save PR must independently prove guarded edit, paste and IME paths
and stale-write refusals. This guard is a format/AST policy, not arbitrary
program dataflow analysis.
