# Keyboard shortcuts

The reference, modal, bindings and input ownership live in
`src/surfaces/shortcuts.rs` and its `shortcuts/` child modules. The shell adds one
registration line. Composer, terminal, registry, shared shell dispatch/view/state
and tests match main. Original parity and receipts remain in
[shortcuts/verification.md](shortcuts/verification.md).

The input observer uses GPUI's public entity-creation API to track weak focus
handles for ordinary editors, credential fields and terminals. It reads no input
contents. Closed inputs are released and removed from the tracker. The first
frame and restored-field paths are covered.

Focused text fields retain typing, help, close, numbered-tab and directional-tab
keys, including Cmd/Ctrl+K. Main's global Cmd/Ctrl+Shift+P palette chord,
Settings and the existing Ctrl+Tab/Shift+Tab chords pass through every text
field. Focused PTYs retain Cmd/Ctrl+K and Settings chords. The module delivers
Ctrl+K/W and Tab/BackTab bytes through the existing terminal input API when
the shell capture handler would otherwise claim them.
Grid's Ctrl+Alt+Left/Right pane navigation remains intact.

The owned raw PTY fixture reports actual bytes received at stdin. Tests verify
`0b`, `17`, `09` and `1b5b5a` through the production WebSocket server and PTYs.
The Settings credential-field matrix covers each guarded binding and each
permitted global chord. Credential contents remain masked and unread by the
observer.

The local field matrix uses disposable batches within the fixture host's
two-minute lifetime. PTY fixtures keep the host and native workspace paths
canonical on macOS, so inventory lookup does not mix `/var` aliases with
their resolved paths. Fixture navigation uses main's global palette chord.

The module-only registration probe archives main, copies only this module's
files and adds its single inventory line, then compiles the real binary entry.
Its red run reproduced `E0560: pass_key`; its green run needs no shared hooks or
editor tags. See [correction round 2](shortcuts/correction-2/verification.md).

The prior Grid guards, modal focus/dismissal and retained list scroll remain
covered. Earlier registration receipts under `shortcuts/registration/` describe
the previous shared-hook implementation; correction round 2 supersedes it.
All main and previous shortcut test function names remain present.

`shortcuts/binding_tests.rs` expands the exact rendered rows into 16 chords and
dispatches each through the real shell in its non-editing focus context. It
checks each named outcome, persisted tab selection and removal, and Escape in
both the reference and command palette. Changing the displayed palette chord
to an unbound key must fail this matrix without changing a handler.

See [final local verification](shortcuts/final-local.md) for the displayed-row
negative control, both registration builds, and the remaining native gate failures.

Refs #4548
