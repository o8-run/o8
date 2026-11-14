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
- `o8 terminal observe` also accepts the terminal of a running worker. A worker's terminal can only be read; `control` stays limited to dashboard shells.
- `o8 terminal panes` opens one pane per live terminal in the Rex session you run it from, in a tab named `o8 terminals`. It shows the terminals of running workers first, each labeled with the title o8 shows for that worker, then your dashboard shells. Each pane runs `o8 terminal observe`, so it is read-only, and closing a pane never stops the terminal. A pane closes on its own when its terminal ends. Run the command again to add panes for new terminals; terminals that already have a pane are left alone, and only panes this command opened are counted or split. It keeps at most 8 panes unless you pass `--limit` (up to 16). `--machine <label-or-id>` shows the dashboard shells of a saved SSH machine; worker terminals on a remote machine are not listed yet. The pane reads the operator credential from the o8 data directory, so a credential supplied only through an environment variable does not reach it. If a pane cannot attach it closes at once, and the command reports that terminal as `closed`. If the list of workers cannot be read, the command still shows your shells and reports a warning.
- `o8 doctor` checks the local control plane when tabs do not reconnect.

If a restored tab has no live tmux session, o8 treats it as dead and starts a fresh shell only through the normal restore path. It never represents a missing session as recovered.
