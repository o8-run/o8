# Native keyboard-shortcuts slice (#4548)

The opt-in shell has a modal shortcuts reference using the shared theme tokens.
It lists six currently implemented desktop binding rows. Unsupported desktop
bindings are omitted from the visible reference, following the source overlay's
rule that a displayed chord must be wired. Full keyboard parity remains open.
No dependencies, installed-app defaults or packaging changed.

| Desktop control / binding | Native counterpart | Status |
| --- | --- | --- |
| Quick settings: Get help | Toolbar Shortcuts | Ported entry |
| Show help: Cmd/Ctrl+/ and non-editing ? | Same keys with composer/palette guards | Ported; terminal editing guard unverified |
| Close button / Escape / backdrop | Same actions with original focus restored | Ported |
| Tab / Shift+Tab in dialog | Close button / scrollable list focus loop | Ported |
| Close button keyboard activation | Enter / Space | Ported; Enter tested |
| List scrolling | Wheel plus arrows, PageUp/PageDown, Home/End | Ported; keyboard scroll cases still need coverage |
| Command palette: Cmd+K | Existing palette, Ctrl alias retained | Ported |
| Orchestrator quick actions: Cmd+Shift+K | None | Missing distinct action |
| Cycle tabs: Cmd+Alt+Left / Right | Previous / next shell surface, wraps | Ported |
| Jump to tab 1–9: Cmd+digit | Nth shell surface; absent index leaves selection | Ported |
| New orchestrator tab: Cmd+T | None | Missing |
| Close active tab: Cmd+W | Close shell surface; editing guard | Ported; Ctrl alias retained |
| Toggle left sidebar: Cmd+B | None | Missing |
| Toggle right panel: Cmd+Alt+B | None | Missing |
| Canvas mode: Cmd+Alt+C | None | Missing |
| Toggle terminal: Cmd+J | None | Missing |
| Send message: Enter | Existing native mode-dependent send | Partial; omitted from reference |
| Steer while running: Cmd+Enter | Existing native mode-dependent send | Missing distinct steer binding; omitted |
| Push-to-talk dictation: hold Ctrl | None | Missing |
| Dictate anywhere: hold Fn | None | Missing |
| Long-form dictation: double Fn | None | Missing |
| Summon o8: Cmd+Shift+Space | None | Missing |
| Speak selected text: Ctrl+Alt+R / Ctrl+Shift+R | None | Missing |
| Paste last dictation: Cmd+Alt+V | None | Missing |
| Settings anywhere: Cmd+Shift+, | None | Missing |
| Open settings: Cmd+, | None | Missing |
| Dismiss / close: Esc | Dismiss help, existing palette dismissal | Ported for existing surfaces |

`shell_tests.rs` launches the actual shell against the repository's existing
`--composer --shell` disposable server. The test dispatches GPUI keyboard events
and clicks. Production session/history/queue routes and existing content views
remain the entry points. No account, desktop app, global OS shortcut, GPU or
operator-machine input is used.

[First red](red-tail.txt): Cmd+/ did not open a native overlay, 0/1 passing.
[A second red](red-close-tail.txt) caught Enter failing to activate the focused
Close button. [Green](green-tail.txt): the new case plus both existing shell
cases pass, 3/3. Coverage includes opening, focus loop, Close/Enter/Escape/backdrop,
inside clicks, blocking commands behind the modal, tab cycling/jumping/closing,
absent tab numbers, and composer typing guards. The test's text system and CPU
paint endpoint are independent of the host's display. Full action coverage and
bindings marked missing or partial remain unmet.

[Timing](run-1.json): one debug Linux headless run, 34.45 ms open-to-first-frame
and 22.86 ms Escape-to-frame, including event dispatch and CPU scene drawing.
Base has no overlay, so before latency is unavailable. No speedup or production
latency target is claimed. GPU/compositor, physical keyboard and macOS display
measurements remain unverified.


## Current main integration

Reconciled with the native Inbox already on main. The final [green run](green-main-tail.txt)
passes **9 shell and Inbox cases**. The [second timing receipt](run-2.json)
records **23.18 ms open-to-first-frame** and **14.96 ms interaction-to-frame**
on the same debug/headless CPU endpoint. Earlier receipts remain in place.
No GPU/compositor or macOS display claim is added.

Refs #4548
