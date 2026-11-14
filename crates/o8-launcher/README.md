# Opt-in macOS launcher

Part of #6130. Nothing in packaging or the shipped app selects this binary.
The separate crate keeps application launch ownership separate from the Linux
batch supervisor documented in `../o8d/SUPERVISOR.md`. Shared shell mechanics
are imported from `o8-launch-core` rather than depending on Tauri.

The experimental entry point is `o8-launcher --config <absolute-json-file>`.
Configuration requires absolute `data_dir`, `server_dir`, `node`, and `window`
paths plus `version`. Omitted ports use the shell's default ranges; zero selects
free ports. Always supply zero ports and a temporary data directory for fixtures.
Optional executable injections `dialog`, `probe`, and `focus`, and
`native_lifecycle: false`, allow headless tests without displaying windows.
The production bundle is not wired to this entry point.

## Lifecycle

The launcher uses the shared login-shell probe, PATH augmentation, runtime
preflight, port/identity files, explicit child environment, restart policy, and
authenticated server-owned GPUI request. Node continues to create its credential
files and owns the window arguments and optional o8d bridge. Server logs rotate
once per boot at `logs/next-server.log` and `logs/ws-server.log`.

A private instance lock and Unix socket serialize launches. Reopen requests are
coalesced even while preflight is pending. AppKit supplies Dock reopen and quit
events without a web view. Focus requires the configured executable to be a
direct child of this launcher's API server; otherwise the server reopens it.

Shutdown stops the API before WS. Each leader receives TERM before its process
group: closing producer pipes lets GPUI and o8d drain. The launcher reaps children
and verifies released ports before reporting successful shutdown. Surviving
descendants receive bounded escalation.

### Bounded shutdown

Every exit path (native Quit, logout, restart or shutdown; TERM, INT or HUP; an
admitted restart; a startup error) runs the same coordinator in `src/shutdown.rs`.
The whole cleanup is bounded to **10 seconds**, half of launchd's default
20-second exit timeout. Servers stop within 9 seconds of the request: each group
drains for up to 7 seconds (o8d's 5.25-second drain plus the Node leader's
one-second TERM budget), shortened so that group SIGKILL still happens at least
one second before that 9-second deadline. The coordinator stops waiting at 9.5
seconds even if an inspection hangs, then releases the instance lock, removes
`launcher.sock`, and ends and reaps any injected failure-dialog child within the
last 0.5 seconds.

On a native termination request the launcher answers "terminate later" and starts
the coordinator on its own thread, because AppKit then waits inside `terminate:`
and runs no more launcher code on the main thread. The coordinator replies
`replyToApplicationShouldTerminate:YES` exactly once through the main dispatch
queue, which AppKit still drains during that wait, after the lock and socket are
released, including when stopping fails, overruns or panics: the release
and the reply run from a guard that also runs while unwinding, and launcher log
lines ignore write errors, so a closed terminal cannot stop them. AppKit exits right after the
reply; `applicationWillTerminate:` exits with status 1 instead of 0 when stopping
failed. The headless path runs the same coordinator inline and returns status 1
on a failed stop. A failed server start also stops what did start through the
coordinator, under the same single bound. Restart backoff after a server crash
is a timestamp checked by the main loop, so Quit is handled during the delay.

### Ownership records

Before each server starts, the launcher creates a private hold file
(`launcher-api.hold`, `launcher-ws.hold`) containing a random UUIDv4 token (122
random bits). It then writes a pending record (`launcher-*.pending.json`) with
that token, the hold file's device and inode, the data directory, the install,
the port, the configured runtime's device and inode, and a birth-clock reading
taken just before the fork. The child receives the token as `O8_LAUNCH_TOKEN`
and the descriptor number as `O8_LAUNCH_HOLD_FD`, and inherits the hold file as
that open descriptor. The launcher's own copy is close-on-exec and closed right
after spawn. Once the PID and kernel birth identity are known, the full receipt
(`launcher-*.json`, which also carries the hold, runtime and spawn time)
replaces the pending record.

Every record and receipt is written to a temporary file in the same directory,
flushed, renamed over the target, and the directory is flushed, so a crash
leaves the old record or the new one, never a truncated file. A record that is
empty or does not parse is removed with a log line and nothing is signalled.

**What stays inheritable.** The server must keep the descriptor open, and the
launcher cannot mark it close-on-exec for processes the server starts later. Any
descendant may therefore hold it: a child agent, a daemonized helper, a GUI app.
`O8_LAUNCH_HOLD_FD` lets the server close that leak itself, but nothing here
depends on it. An advisory lock would not help, because it is inherited across
fork too.

**The single-holder proof.** Holding the descriptor only makes a process a
candidate. Among this user's processes that hold the recorded inode (the hold
file must still exist with that inode and token, so a recycled inode never
counts), exactly one is accepted: the earliest-born process that

- was born at or after the recorded spawn time (for a pending record, also
  within two seconds of it), and
- runs the recorded runtime executable, compared by device and inode so a moved
  install still matches.

Every other holder is logged and never signalled. Descendants are born after the
server, so the server is always the earliest; a descendant can only be chosen if
the server is gone and the descendant runs the same runtime. Process birth comes
from `proc_pidinfo(PROC_PIDTBSDINFO)` on macOS and `/proc/<pid>/stat` with
`CLOCK_BOOTTIME` ticks on Linux. Executable identity comes from `proc_pidpath`
then `stat` on macOS and `/proc/<pid>/exe` on Linux.

Reading another process's environment on macOS (`KERN_PROCARGS2`) returns the
exec-time copy, which the process can overwrite and which is not a documented
interface, so the token in the environment is never used as proof. Open
descriptors are kernel state: the launcher lists them with
`proc_pidinfo(PROC_PIDLISTFDS)` and `proc_pidfdinfo` on macOS and
`/proc/<pid>/fd` on Linux.

At start, before choosing ports:

- A full receipt is honoured only for a live process with the recorded birth
  identity, data directory and process group, an orphan parent, and (same install)
  the server working directory. If the receipt's install differs, the executable
  path cannot prove anything, because the kernel reports the moved location; the
  single proven holder must instead be the receipt's process. A moved install's
  servers are then stopped and started again from the new location. A
  moved-install receipt without that proof is removed and logged as left running.
- A leftover pending record means a crash between spawn and receipt. The proven
  holder is stopped if it leads its process group and its parent has exited,
  with its birth identity re-checked before every signal. A proven holder whose
  parent is alive refuses the start. Holders that are not proven never block the
  start. A pending record with no proven holder, or whose hold file is gone, is
  removed and logged without signalling.
- A recorded process that cannot be inspected (gone, recycled, or owned by
  another user so its identity cannot be read) is never signalled. Its receipt is
  removed with a log line and start continues; if that process still holds a
  recorded port, the new servers use other ports or startup reports the conflict.

Nothing is ever signalled on PID, name or port alone. Other unresolved live
ownership, such as a recorded server whose parent is still alive, is refused.

The original orphan failure came from comparing mutable command text across
interpreter exec. A stable kernel birth identity replaces that comparison. The
original port-release assertion remains in the real-entry test.

## Restart handoff for step 4

`launcher.sock` accepts newline-terminated JSON followed by write-side EOF:
`{"op":"prepare-restart"}`, `{"op":"cancel-restart","reservation":"…"}`,
and `{"op":"restart","reservation":"…"}`. Preparation returns a reservation.
Restart uses the shared final work inspection and cloud-job drain before stopping
children. An `admitted` response is admission, not a shutdown receipt; an updater
must wait for process exit and port release, then retain ownership and instance
exclusion across its handoff. Feed, signature, download, replacement, and relaunch
logic remain step 4 work.

## Verification and limits

Run `cargo test --locked --manifest-path crates/o8-launcher/Cargo.toml -- --test-threads=1`.
Python 3 and the Rust toolchain's `rustc` must be available. Recovery fixtures
compile a small runtime with `rustc` so the servers' executable is a real binary,
as the bundled Node is; the other fixture services use Python.
The tests spawn this binary with fixture servers and windows in temporary
directories on free ports. They cover health and boot identity, environment,
crash/restart exhaustion, shutdown during retry/preflight, drain ordering and
descendant pipe drain, second launch, ownership refusal and orphan cleanup,
private files, bounded control input, voice-only suppression, injected dialog
reaping, a crash between spawn and receipt (`O8_LAUNCHER_FAULT`, debug builds
only) with daemonized descendants that inherited the hold descriptor, a holder
with a live parent, empty and truncated records, and a really moved install.
Unit tests in `src/shutdown.rs` cover one reply on success, failure, timeout and
panic, a closed standard-error pipe, the cleanup bound, and lock and socket
release before the reply.
`tests/launcher-binary-real-path.test.ts` runs these tests and isolated shared
unit tests in the Linux integration lane.

Dock reopen, unhide/focus, native quit, and native failure-alert appearance need a
live macOS check before a packaging switch. The shell check also needs generated
helpers and frontend assets. Optional helper installation remains shell-owned;
the launcher forwards an existing `O8_CODEBASE_MEMORY_BIN` and bundled helper
paths. This crate does not download helpers or implement updater, voice, menu,
signing, or packaging changes.

Native termination **needs live check** before bundling. It cannot run in CI.
Do this on an isolated macOS test account with no unsaved work, never on a
machine whose o8 is in use:

1. From the repository root, build with `cargo build --locked --manifest-path
   crates/o8-launcher/Cargo.toml`. Generate an isolated fixture configuration:

   ```sh
   python3 - <<'PYFIXTURE'
   import json, pathlib, tempfile
   source = pathlib.Path('crates/o8-launcher/tests/support/mod.rs').read_text()
   script = source.split('let script = r#"', 1)[1].split('"#;', 1)[0]
   root = pathlib.Path(tempfile.mkdtemp(prefix='o8-launch-live-', dir='/tmp'))
   for name in ['node', 'dialog', 'window', 'probe', 'focus']:
       path = root / name
       path.write_text(script)
       path.chmod(0o700)
   for name in ['server.js', 'ws-server.mjs']:
       (root / name).write_text('fixture')
   config = dict(data_dir=str(root), server_dir=str(root), node=str(root/'node'),
                 window=str(root/'window'), dialog=str(root/'dialog'),
                 probe=str(root/'probe'), focus=str(root/'focus'), version='fixture',
                 api_port=0, ws_port=0, native_lifecycle=True)
   (root/'config.json').write_text(json.dumps(config))
   print(root/'config.json')
   PYFIXTURE
   ```

   Start a new session and log to the fixture directory to keep native quit
   checks independent of the terminal:

   ```sh
   python3 - crates/o8-launcher/target/debug/o8-launcher <printed-path> <<'PYLAUNCH'
   import pathlib, subprocess, sys
   binary = pathlib.Path(sys.argv[1]).expanduser().resolve()
   config = pathlib.Path(sys.argv[2]).resolve()
   log_path = config.with_name('launcher-stderr')
   with log_path.open('ab') as log:
       child = subprocess.Popen([str(binary), '--config', str(config)],
           stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
           start_new_session=True)
   print('Launcher PID:', child.pid, 'Log:', log_path)
   PYLAUNCH
   ```

   If using `CARGO_TARGET_DIR`, pass that directory's `debug/o8-launcher` instead.
2. Record the launcher PID, the server PIDs in `api-starts` and `ws-starts`, and
   the ports in `api-port` and `ws-port`. Close the launching terminal.
3. Choose Quit from the Dock icon. Within 10 seconds confirm: the launcher PID is
   gone (`ps -p <pid>`), both server PIDs are gone, both ports can be bound
   (`nc -l 127.0.0.1 <port>` starts), `launcher.sock` is absent, and no Quit had
   to be repeated. `launcher-stderr` has no `Shutdown incomplete` line.
4. Relaunch with a new fixture directory. Choose Log Out from the Apple menu and
   confirm the logout completes without a "cancelled logout" or "not responding"
   notice; after logging back in, repeat the checks from step 3 against the
   recorded PIDs and ports. Repeat separately for Restart and Shut Down.
5. Relaunch with a fresh fixture directory after `touch <dir>/stubborn-child`
   (its WS grandchild ignores TERM). Quit from the Dock. Confirm the launcher
   exits within 10 seconds, the `held-pid` process is gone, and both ports are
   free.
6. Relaunch with a fresh fixture directory, remove only that directory's
   `launcher-api.json`, then Quit from the Dock. Confirm the launcher still exits
   within 10 seconds without a second Quit, `launcher-stderr` contains
   `Shutdown incomplete`, and `ps`/the shell reports the launcher's exit status
   as 1 (start it from a shell with `; echo $?` instead of step 1's detached
   form for this check only). Both ports are released.
7. Move check: make a separate install directory holding a copy of the built
   `o8-launcher`, `server.js` and `ws-server.mjs`; point `server_dir` at it and
   start that copy as in step 1. Kill it with `kill -9`, `mv` the install
   directory, update `server_dir`, and start the moved copy. Confirm the old
   server PIDs exit and `launcher-stderr` says `started from moved install`.
   Repeat with the real app bundle while its servers run once it is bundled.

These steps have not been run here. Headless fixtures and unit tests exercise the
coordinator, the bound and the reply-once rule; they do not exercise AppKit or
authorize switching packaging. Linux subreaper orphan adoption remains follow-up
work in #6143.
