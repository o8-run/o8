# Persistent terminals

Interactive o8 terminals are backed by tmux so their shell process and scrollback can survive a WebSocket-server restart or a full app restart.

## What persists

Terminal tabs store their tmux session identity with the workspace state. When o8 reconnects, it checks that session, reattaches the live shell, and replays captured scrollback into the terminal view. Detaching the UI does not end the shell; explicitly closing the terminal does.

Persistence is enabled by default. Set `O8_PERSISTENT_TERMINALS=0` to use the legacy process-bound terminal behavior.

## Requirements and fallback

tmux must be available on the host for a terminal to survive the owning process. If tmux is missing or a session cannot be created, o8 falls back to a normal shell terminal instead of failing the launch. That terminal works normally but ends with the WebSocket server.

## Recovery checks

- `tmux ls` shows the live terminal sessions independently of the app.
- `o8 run --list` shows long-running commands launched through the managed-run surface.
- `o8 run --last` shows the latest command, start time, durable exit receipt, and retained log path.
- `o8 terminal list` returns the exact IDs of live dashboard shells, including detached sessions.
- `o8 terminal show <id> [--lines N]` reads a bounded text snapshot of that shell. The default is 200 lines and the maximum is 1000.
- `o8 terminal observe <id>` streams that same shell until interrupted. Add `--human` for terminal text instead of JSON events. Observation cannot send input or resize the shell.
- `o8 terminal panes` opens one pane per live shell in the Rex session you run it from. Each pane runs `o8 terminal observe`, so it is read-only, and closing a pane never stops the shell. A pane closes on its own when its shell ends. Run the command again to add panes for new shells; shells that already have a pane are left alone, and only panes this command opened are counted or split. It keeps at most 8 panes unless you pass `--limit` (up to 16), and `--machine <label-or-id>` shows the shells of a saved SSH machine. The pane reads the operator credential from the o8 data directory, so a credential supplied only through an environment variable does not reach it.
- `o8 doctor` checks the local control plane when tabs do not reconnect.

If a restored tab has no live tmux session, o8 treats it as dead and starts a fresh shell only through the normal restore path. It never represents a missing session as recovered.
