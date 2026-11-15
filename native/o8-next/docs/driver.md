# Driving the real window by control name

A development build of o8 next can be driven without the mouse: a program
names a control and the window presses it. This exists so a change can be run
in the real window by a reviewer or a check, and so a press can never land on
whatever moved under an old screen coordinate.

It is compiled only with the `driver` cargo feature. Release builds never
enable it.

## Start

```sh
cargo build --manifest-path native/o8-next/Cargo.toml --features driver --bin o8-next
O8_NEXT_DRIVER_SOCKET="$HOME/.o8/next-driver.sock" <the built binary> ...
```

The window listens on that unix socket. Only the account that started it can
open the socket. There is no network listener. Any program running as that
account can connect, so the refusals below prevent accidents; they are not a
security boundary.

## Requests

One JSON object per line; one JSON answer per line, `{"ok": true, "result": …}`
or `{"ok": false, "error": "…"}`.

```sh
node scripts/next/drive.mjs snapshot activity-
node scripts/next/drive.mjs press activity-refresh
node scripts/next/drive.mjs key "cmd-k"
node scripts/next/drive.mjs type "status"
node scripts/next/drive.mjs scroll activity-list 0 -120
```

| Command | Fields | What it does |
| --- | --- | --- |
| `snapshot` | `prefix` (optional) | Lists the named controls in the current frame with their bounds, and the window size. |
| `press` | `selector` | Presses the centre of that control. An unknown or off-screen name is an error. |
| `scroll` | `selector`, `dx`, `dy` | A wheel movement over that control, in points. |
| `key` | `keys` | Keystrokes separated by spaces, such as `escape` or `cmd-k`. |
| `type` | `text` | Printable text into the focused text input, as text and not as key presses. No line breaks. An error when nothing that takes text has focus. |

Control names are the `debug_selector` names in the source.

## What it refuses

A control whose name says it changes real state (stop, send, merge, confirm,
close, accept, settle, archive, dismiss, suppress, discard, delete and the
like) is refused unless the request lists that exact name in `allow`. The same
holds when such a control is drawn over the point a press would land on.

A press is also refused when it would not reach the named control: the control
is clipped or hidden, something without a name is on top of it, it is a
container with another button at its centre, or its press area belongs to a
larger wrapper (press the wrapper's name instead, for
example `header-right-panel-hit`).

Keys that can confirm, send, run or close something are refused unless named
in `allow`: `key:enter`, `key:space`, `key:ctrl-m`, `key:ctrl-j`, `key:cmd-w`.

`type` is refused while a terminal has focus unless `allow` contains
`type:terminal`: a program in a terminal can act on a single letter.

A request the window could not start within five seconds is dropped, not run
late. If the answer is "the window did not answer", take a snapshot before
trying again.

```sh
node scripts/next/drive.mjs press activity-stop-mission --allow activity-stop-mission
```

Every request is appended to a log beside the socket (`….log`): the time, the
command, the control and whether it was done. Keys and typed text are not
logged. Only its owner can read it.

## Limits

- It reads names and bounds, not text. Use a screenshot to read what a control
  says.
- It presses what is drawn. A control scrolled out of view must be scrolled in
  first.
- When two controls share a name, the one painted last is used.
- The list of guarded words is a judgment about names. A new control that
  changes real state needs a name the list catches, or a new word in the list.
- macOS and Linux only.
