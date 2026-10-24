# Native terminal inset (#4549)

The desktop [terminal panel](../../../src/components/desktop/workspace-terminal/WorkspaceTerminalPanels.tsx)
sets 12 px of padding on every side. Its [xterm container](../../../src/components/desktop/workspace-terminal/XtermPanel.tsx)
adds 2 px at the top and left. The native canvas therefore receives 14 px
top/left and 12 px bottom/right, below its existing 26 px status strip.

The [production PTY test](../src/terminal_tests.rs) first failed with painted
origin `(0, 26)` instead of `(14, 40)`. With the inset it passed these checks:

| Viewport (px) | Painted origin (px) | Content size (px) | Kernel PTY columns x rows |
| --- | --- | --- | --- |
| 768 x 584 | 14, 40 | 742 x 532 | 92 x 29 |
| 793 x 607 | 14, 40 | 767 x 555 | 95 x 30 |

Both sizes assert that the PTY dimensions equal the visible canvas divided by
the unchanged 8 x 18 px cell dimensions, rounded down. The fixture reads the
kernel PTY size after native GPUI resize and input pass through the production
WebSocket server. The existing replay, input, alternate-screen, scrollback and
50 MB flood assertions also passed.

This is a release-profile GPUI TestAppContext scene/layout check on macOS with
a disposable fixture server and PTY. It opens no OS window and uses no OS input
or screenshots. It does not establish compositor or display presentation.

```sh
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml \
  --bin o8-next terminal::tests::production_pty_to_gpui_terminal \
  -- --exact --nocapture --test-threads=1
```
