# Focus-aware native keymap

Issue #4710, shell work; Refs #4548. The keymap uses the published Apache-2.0
GPUI crate already in the dependency graph. The pattern binds actions to context
predicates and dispatches along the focused view path. No external application
implementation or new dependency was used.

The production `keymap.rs` registers actions once per GPUI app. Views attach
contexts to their tracked focus nodes and handle actions during bubbling. The
palette uses the existing Composer input contract. `TextInput`, `Terminal`,
`List`, individual surface contexts and `Button` scope the bindings. Settings and
Customize mark their overlay context `Modal`. The shortcuts panel reads the same
binding rows that are installed into GPUI.

The shell retains a focus handle per workspace/surface in memory; explicit New
message still selects the composer. Saved restart focus continues to use the
existing state schema. Hidden rename inputs leave the active dispatch path when
their view is detached. Reconnect tests observe the owned replay peer's actual
socket interruption and successful reconnect, as well as the shell Retry action.

Current review corrections and updated counts are in [round 2](round2/verification.md);
[round 1](round1/verification.md) preserves its earlier receipts.
The measurements below preserve the initial verification snapshot.

## Measurements and entry points

- Files attaching raw key listeners: **13 before, 1 after** across native source.
  Surface files specifically: **13 before, 0 after**. The remaining attachment
  is the shared `keymap.rs` VT adapter for Alt-modified Unicode text. This
  unbounded platform-text input becomes a terminal action; every named binding
  is in the keymap. Ordinary text and IME use `EntityInputHandler`.
- Native test registration: **133 before, 143 after**. Ten focused keymap tests
  cover **776 rows including the test-only probe** (775 production rows), four
  focus paths, both isolated and complete-map dispatch: **6,208 cases**.
- Primary failures: **2 failures / 0 passes -> 0 failures / 10 passes**.
  Surface return also reproduced **1 failure -> 1 pass**. Canonical duplicate
  and full-map precedence each reproduced **1 failure -> 1 pass**.
- Real PTY input checks require exact echoed bytes for Ctrl+K, Ctrl+W, `?`, paste,
  and Alt-modified Unicode. Shell actions remain uninvoked, and focus stays on
  the terminal. Existing grid tests cover reserved pane chords and retained PTYs.

Tests use `cargo test --locked --manifest-path native/o8-next/Cargo.toml`,
headless GPUI, and the existing `scripts/next/dev-server.ts` fixture host with
production routes and owned disposable state. Fixture directories use the shared
canonicalized fixture helper. No new native packaging or platform staging path
was introduced. macOS desktop/GPU presentation and real accounts were unavailable.

Test files:

- `src/keymap_tests.rs`: each row's isolated and installed dispatch, canonical
  uniqueness, generated reference, terminal/field precedence.
- `src/shell_tests.rs`: field protection, exact modifiers, generated panel,
  surface return, HTTP Retry and actual WebSocket reconnect.
- `src/projects_review_tests.rs`: cancelled hidden rename and persisted name.
- `src/terminal_tests.rs`: exact PTY bytes, paste, Unicode and retained focus.
- `src/surfaces/pull_requests/shell_tests.rs`: a focused review field cannot close
  its tab; closing from the surface context retains the draft.

## Hostile review

1. An ancestor handles a shell shortcut before a child field or PTY. Covered by
   `keymap_text_focus_keeps_palette_and_close_out`,
   `keymap_nested_terminal_and_text_take_precedence`, and
   `keymap_terminal_control_keys_reach_real_pty_before_shell`.
2. Modifiers, canonical aliases, or a deeper terminal binding select the wrong
   action. Covered by `keymap_modified_palette_chord_does_not_open_palette`,
   `keymap_reference_has_exactly_the_registered_rows`, and the complete-map pass
   of `keymap_every_binding_dispatches_only_on_its_focus_path`. The canonical
   test caught generated uppercase aliases overriding Ctrl+Shift+V; full-map
   dispatch caught terminal encoding overriding Ctrl+Alt+1.
3. A detached editor or asynchronous return leaves focus on the wrong view.
   Covered by `keymap_hidden_rename_returns_focus_to_projects`,
   `keymap_composer_focus_survives_surface_switch_and_reconnect`, and
   `keymap_composer_keeps_focus_through_real_socket_reconnect`.

Red receipts are preserved beside this file. `baseline-activity.txt` reproduces
the unrelated Activity command-order assertion tracked in #4717 on untouched main: the assertion
expects Diff immediately after Activity, but Pull requests now occupies that
position. The final native run excludes only that known baseline assertion;
its keyboard-control test remains included. No Activity ordering fix is included.

Completion results are recorded in the pull request and `green.txt`.
