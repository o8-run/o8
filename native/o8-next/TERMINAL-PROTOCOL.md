# Existing terminal protocol

Derived from `src/ws-server.ts` (`handleTerminalAttach`, `handleTerminalInput`,
`handleTerminalResize`, `handleTerminalVisibility`, `sendTerminalResync`,
`registerTerminalAttachment`), `src/lib/ws-server/channels.ts`,
`src/components/desktop/hooks/DesktopWebSocketContext.tsx`, and the WebKit client
`src/components/desktop/workspace-terminal/XtermPanel.tsx` plus
`terminal-output-writer.ts`. These are the source of truth. This experiment adds
no server route or wire message type.

## Connection and attachment

1. GET `/api/panel/ws-info` on the explicit numeric loopback HTTP origin. The
   existing middleware requires the operator bearer. Response fields are
   `wsPort` and `wsToken`. Neither credential is logged or discovered from disk.
2. Connect to `ws://<same numeric loopback host>:<wsPort>/ws?token=<wsToken>`.
   This is the server's existing authenticated multiplexed WebSocket. The native
   client does not follow redirects, use environment proxies, or subscribe to
   provider inventories. The normal system acknowledgement is
   `{channel:"system",event:"connected",data:{...}}`.
3. Send `{type:"terminal-attach",sessionName,cols,rows}` for an existing session.
   The pane itself never sends `terminal-create`, `/terminal-spawn` or kill. The
   Terminal surface opens the workspace's own shell the way the desktop does: one
   `{type:"terminal-create",cols,rows,requestId,cwd,ownerKey}` on a short-lived
   connection, with the stable owner key `o8-next:<workspace>:terminal`. The
   server adopts the surviving session for that key, or reserves a new one in the
   workspace, and replies `{channel:"terminal",event:"created",data:{sessionName,requestId}}`.
   The pane then attaches to that name as below.
   Attach can materialize an existing pending dashboard reservation server-side.
   `readOnly:true` is the observer variant: it cannot write or resize, and the
   server returns source dimensions. The separate `control:true` CLI lease is
   restricted to operator dashboard shells; the native pane does not request it.
4. The server replies
   `{channel:"terminal",event:"attached",data:{sessionName,cols,rows,...}}`.
   Existing dashboard attachments may immediately replay retained bytes in a
   `data` event with `historical:true`. Ordinary tmux attachment repaints its
   current screen. Attach acknowledgement alone does not establish a complete
   historical checkpoint.

Every terminal payload is under `data`. Always filter both `channel` and
`data.sessionName`; unrelated sessions and channels share this transport.
Terminal frames have no realtime stream sequence, boot-id or `since` cursor.

## Output, historical replay and visibility

Output is `{channel:"terminal",event:"data",data:{sessionName,data,historical?}}`.
The inner `data` is **base64 bytes**, not a Unicode string. Feed decoded bytes
into one persistent ANSI/UTF-8 parser, including across network chunk boundaries.
The production server currently batches output at 16 ms. Its retained byte ring
is 512 KiB; that is separate from the native emulator's 10,000-line scrollback.
The wire protocol cannot recover history older than the server's retained ring
or available tmux capture.

The WebKit client uses a visibility barrier to avoid mixing old and live output:

```js
{type:"terminal-visibility",sessionName,visible:true,
 epoch:1,needsResync:true,cols,rows}
```

`epoch` is monotonic within one server-side client view. Stale epochs are ignored.
While resync is pending, the server hides this view and settles its input/output
barrier before capturing tmux or the direct PTY's retained ring. It sends:

```js
{channel:"terminal",event:"resync",data:{sessionName,data,epoch,
 source:"tmux" /* or "scrollback" */,historyTruncated:false}}
```

For a matching epoch, reset the emulator **and ANSI parser**, apply this snapshot
as historical bytes, then accept subsequent live data. Drop pre-checkpoint live
data to prevent duplication. Historical parser answers (DA, DSR, OSC color and
size queries) must never be sent back into the PTY. Suppressing only user input
does not suppress emulator-generated replies. The native client also ignores
clipboard/URL/OS requests in terminal output.

For a reveal without resync, buffered bytes precede `visibility-ready` with the
same epoch. `visible:false` buffers hidden output in a bounded 64 KiB buffer and
batches every 250 ms. Overflow diagnostics mark the need for a fresh snapshot;
`historyTruncated` and fallback markers make lost history explicit. The native
pane stays visible and requests one fresh checkpoint on each connection.

`data` is deliberately **lossy** when the server socket exceeds its 64 KiB
backpressure threshold. Other terminal control events are queued with the
existing durable-message limit. There is no acknowledgement or lossless replay
guarantee for visible output. A native bounded queue cannot change that server
contract. Flood tests check exact received byte counts so loss cannot masquerade
as a successful benchmark.

## Input, resize, lifecycle

* Input: `{type:"terminal-input",sessionName,data:"..."}`; this `data` is a text
  string, **not base64**. The server writes it to the attached PTY. The emulator
  supplies mode-aware cursor keys, control keys and live protocol replies;
  committed platform text and bracketed paste use the same path.
* Resize: `{type:"terminal-resize",sessionName,cols,rows}`. Writable attached
  clients may resize; duplicate dimensions are elided. `dimensions` events with
  `{sessionName,cols,rows}` inform read-only observers. The native GPUI canvas
  computes columns/rows from its viewport and fixed cell geometry.
* Keepalive: `{type:"ping"}` every 20 seconds; the server sends channel `pong`.
* Exit: terminal `exited` contains `sessionName`, `exitCode` and
  `exitCodeSource`. A tmux transport exit is not proof of the workload's exit.
  Errors arrive as terminal `error` with `sessionName` and `error`/`code`.
  The pane disables input and shows a local failure/exit status.
* Close: `{type:"terminal-detach",sessionName}` or socket close removes this
  client. The native pane sends no kill request, but **last-viewer lifecycle is
  server-defined**: persistent dashboard shells stay warm; nonpersistent
  dashboard shells get the existing 30-minute grace period. Other attachment
  PTYs are destroyed when their last client leaves. An independent tmux session
  may survive its attach-client PTY; a direct managed-process PTY does not.
  Transient setup PTYs terminate on disconnect (or after the detach grace).
* Reconnect: fetch fresh ws-info, open a new socket, reattach, request a fresh
  resync (epoch 1 in the new client view). Retain the last painted screen until
  the replacement arrives. Disable input until ready and discard queued old
  keystrokes; never replay input after reconnect. Backoff is bounded and dropping
  the pane cancels its transport. Reconnection cannot restore a direct PTY the
  server has already removed under its last-viewer policy.

## Disposable verification

`scripts/next/dev-server.ts --terminal` extends the existing fixture-host pattern.
It owns a temporary store and fixture repository, launches **src/ws-server.ts**
with those paths, then uses the existing internal `/terminal-spawn` endpoint to
start `fixtures/terminal.py`. Only the fixture setup creates a PTY. The native
pane attaches to the published `terminalSession` using the production ws-info
handler and middleware. Shutdown reaps the child server and PTY before removing
the store. No operator machine, account, Tauri app or tmux installation is used.

`tests/next-terminal-real-path.test.ts` verifies that server boundary, including
kernel PTY dimensions. `src/terminal_tests.rs` takes the same path through GPUI
TestAppContext, platform text input, the Alacritty grid and actual paint callbacks.
It checks ANSI colors, combining/wide characters, alternate screen, cursor,
viewport resize, 10,000-line retention, scroll navigation and exact 50 MB delivery.
