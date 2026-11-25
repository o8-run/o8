# Start o8 from a clean state, then restore

This page lists every place the macOS desktop app writes, so a tester can move
them aside, run o8 as a new install, and put the original state back. The list
was taken from the launcher, the native window, the Rust daemon and the server
code. Nothing here deletes data.

## What o8 writes

| Location | What it holds | Notes |
| --- | --- | --- |
| `~/.o8` | The data directory: the database (`cortex-ide.db`), `settings.toml`, `operator-defaults.json`, `logs/`, the launcher socket, worktrees under `worktrees/`, worker and orchestrator homes, the compile cache, and the master key file on systems without a keychain. | `O8_DATA_DIR` in the app's environment moves it. `CORTEX_IDE_DATA_DIR` is the older name. `O8_WORKTREE_ROOT` moves only the worktrees. |
| `~/.o8/next*` | Native window state: appearance, the snapshot hotkey, composer modes, visualization views, thumbnails and snapshots. | Always under `~/.o8`, even when `O8_DATA_DIR` points elsewhere. |
| `~/.cortex-ide` | Data from the app's earlier name. | If this exists and `~/.o8` is missing or empty, o8 copies it into `~/.o8` on start unless `O8_DATA_DIR` is set. Move it aside too. |
| `~/Library/Application Support/ai.o8.desktop/update-ping.json` | Update channel choice and a random install id. | Read by the launcher's update check. |
| `~/Library/LaunchAgents/o8.plist` | Open at login. | Only present when Open at login is on. |
| Keychain item `ai.o8.master-key` (account `default`) | The key that encrypts saved secrets in the database. | Leave it in place. A restored data directory needs the same key. A fresh data directory reuses it. |
| Keychain items `ai.o8.chatgpt-plan` | A ChatGPT plan sign-in, if one was added. | Leave in place. |
| `~/.cache/o8/cargo-targets` | Shared Rust build output for worktrees of Rust repositories. | Safe to move aside. |
| `/opt/homebrew/bin/o8`, `/usr/local/bin/o8`, `~/.local/bin/o8` | Links to the bundled `o8` command. | Recreated on every launch. Leave them. |
| `.o8.app.update` next to the installed app | A downloaded update waiting to install. | Present only while an update is staged. |

Outside these, o8 changes your repositories only through the work you give
it: branches and worktrees that its agents create. Each worktree is also
registered in the repository's own `.git/worktrees`. o8 reads the home folders
of agent tools such as `~/.claude` and `~/.codex`. It writes to their settings
only when you connect one in Setup or run `o8 mcp install`.

## Move the state aside

Quit o8 from its menu, then check that no o8 process is left:

```sh
pgrep -lx 'o8|o8-next|o8d'
```

No output means it has stopped. Then move everything aside in one step:

```sh
aside="$HOME/o8-aside-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$aside"
for item in "$HOME/.o8" "$HOME/.cortex-ide" "$HOME/.cache/o8" \
  "$HOME/Library/Application Support/ai.o8.desktop" \
  "$HOME/Library/LaunchAgents/o8.plist"; do
  [ -e "$item" ] && mv "$item" "$aside/"
done
echo "$aside"
```

Open o8. It starts as a new install with first-run setup. To start without
the setup screens or with a prepared profile, put a copy of a prepared data
directory at `~/.o8` before opening o8.

## Restore

Quit o8 and confirm it has stopped as above. Move the test run's state out of
the way, then move the originals back. Replace the `aside` value with the
folder printed when you moved the state aside.

```sh
aside="$HOME/o8-aside-YYYYMMDD-HHMMSS"
run="$HOME/o8-test-run-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$run"
for item in "$HOME/.o8" "$HOME/.cache/o8" \
  "$HOME/Library/Application Support/ai.o8.desktop" \
  "$HOME/Library/LaunchAgents/o8.plist"; do
  [ -e "$item" ] && mv "$item" "$run/"
done
mkdir -p "$HOME/.cache" "$HOME/Library/Application Support" "$HOME/Library/LaunchAgents"
[ -e "$aside/.o8" ] && mv "$aside/.o8" "$HOME/.o8"
[ -e "$aside/.cortex-ide" ] && mv "$aside/.cortex-ide" "$HOME/.cortex-ide"
[ -e "$aside/o8" ] && mv "$aside/o8" "$HOME/.cache/o8"
[ -e "$aside/ai.o8.desktop" ] && mv "$aside/ai.o8.desktop" "$HOME/Library/Application Support/ai.o8.desktop"
[ -e "$aside/o8.plist" ] && mv "$aside/o8.plist" "$HOME/Library/LaunchAgents/o8.plist"
```

Worktrees from the test run were inside the moved data directory. In each
repository the run used, `git worktree prune` removes their stale
registrations. Branches the run created stay until you delete them.

## Keep the installed profile untouched instead

To give a test run its own profile without moving anything, set a separate
data directory for the app before opening it:

```sh
launchctl setenv O8_DATA_DIR "$HOME/o8-test-profile"
```

Quit and reopen o8 for it to apply, and run `launchctl unsetenv O8_DATA_DIR`
afterwards. The native window state under `~/.o8/next*`, the update settings
in Application Support, the cache and the keychain items stay shared with the
normal profile in this mode.

To turn off update checks and the phone relay for the run, set `O8_NO_PHONE_HOME=1`.
