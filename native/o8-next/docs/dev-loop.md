# The development loop for the native window

Build a checkout, open one window on it against a running server, look at it,
and press its controls by name. One script does each step:
`scripts/next/dev/dev.sh`.

```sh
export O8_NEXT_DEV_SERVER=http://127.0.0.1:PORT   # a running o8 server
export O8_NEXT_DEV_TOKEN_FILE=/path/to/its/token  # optional; never printed

scripts/next/dev/dev.sh build     # this checkout, with the driver feature
scripts/next/dev/dev.sh keep      # private copy of the binary
scripts/next/dev/dev.sh launch    # the one development window
scripts/next/dev/dev.sh shot      # capture it (macOS); prints the file
scripts/next/dev/dev.sh drive snapshot header-
scripts/next/dev/dev.sh drive press header-sidebar
scripts/next/dev/dev.sh stop
```

## Settings

All are environment variables; `dev.sh env` prints the values in use.

| Variable | Default | What it is |
| --- | --- | --- |
| `O8_NEXT_DEV_SERVER` | none; `launch` refuses without it | The server origin the window attaches to. There is no default so a development build never attaches to a server by accident. |
| `O8_NEXT_DEV_TOKEN_FILE` | none | A file holding that server's token. Read into the window's environment only. |
| `O8_NEXT_DEV_SRC` | the checkout the script is in | The checkout to build. |
| `O8_NEXT_DEV_HOME` | `~/.o8/next-dev` | Where the kept binary, the window's saved state, its log, the capture and the driver socket live. |
| `O8_NEXT_DEV_TARGET` | `$O8_NEXT_DEV_HOME/target` | The cargo build directory. |
| `O8_NEXT_DEV_PROFILE` | `release` | `release` or `debug`. |

## Rules the script holds

- **One window.** `launch` refuses while a development window is open.
- **A private binary.** Cargo writes every checkout's build to the same file
  in a shared build directory, so another checkout's build can replace it.
  The window runs a copy, and `keep` refuses a build that did not come from
  this checkout.
- **A build directory of its own.** Background workers that build on the same
  machine must set `O8_NEXT_DEV_TARGET` (or `CARGO_TARGET_DIR`) to a different
  directory. Cargo locks a build directory for one build at a time, so sharing
  one makes the development build wait behind every worker's.
- **No stale picture.** `shot` deletes the last capture before it takes a new
  one and fails when there is no window, so an old image is never read as new.
- **Presses go by name.** `drive` uses the development driver
  ([driver.md](driver.md)): the press is delivered inside the window to the
  control with that name, so it does not depend on screen coordinates, on the
  window being in front, or on how long a synthetic click is held. Controls
  that change real state are refused unless named in `--allow`.

## Notes

- The window attaches to whatever data the server holds. Point it at a server
  on a scratch data directory unless you mean to try a change on real data.
- `shot` needs the screen recording permission for the terminal that runs it.
- Capture is macOS only. Build, keep, launch and drive also run on Linux.
