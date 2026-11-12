#!/usr/bin/env bash
# The development loop for the native window: build a checkout, keep a private
# copy of the binary, open one window against a running server, capture it,
# and press a control by name. See native/o8-next/docs/dev-loop.md.
#
#   dev.sh build            build this checkout with the driver
#   dev.sh keep             copy the build to the path the window runs
#   dev.sh launch           open the one development window
#   dev.sh stop             close it
#   dev.sh shot [FILE]      capture the window (macOS); prints the file
#   dev.sh drive ARGS...    press, type or read by control name (drive.mjs)
#   dev.sh env              print the settings in use
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${O8_NEXT_DEV_SRC:-$(cd "$here/../../.." && pwd)}"
HOME_DIR="${O8_NEXT_DEV_HOME:-$HOME/.o8/next-dev}"
# A build directory of its own: background workers must build somewhere else
# (O8_NEXT_DEV_TARGET), or this build waits on theirs and theirs can replace
# the binary the window runs.
TARGET="${O8_NEXT_DEV_TARGET:-$HOME_DIR/target}"
PROFILE="${O8_NEXT_DEV_PROFILE:-release}"
SERVER="${O8_NEXT_DEV_SERVER:-}"
TOKEN_FILE="${O8_NEXT_DEV_TOKEN_FILE:-}"
BUILT="$TARGET/$PROFILE/o8-next"
BIN="$HOME_DIR/bin/o8-next"
STATE="$HOME_DIR/shell-state.json"
SOCKET="${O8_NEXT_DRIVER_SOCKET:-$HOME_DIR/driver.sock}"

fail() {
  echo "dev.sh: $*" >&2
  exit 1
}

window_pid() {
  pgrep -f "^$BIN( |\$)" | head -1 || true
}

build() {
  local flag=()
  [ "$PROFILE" = release ] && flag=(--release)
  CARGO_TARGET_DIR="$TARGET" cargo build --manifest-path "$SRC/native/o8-next/Cargo.toml" \
    --locked --bin o8-next --features driver "${flag[@]}"
}

keep() {
  [ -x "$BUILT" ] || fail "no build at $BUILT; run build first"
  # Cargo writes every checkout's build to the same file in a shared build
  # directory. Refuse a binary some other checkout built there.
  strings -a "$BUILT" | grep -q -m1 -F "$SRC/native/o8-next" \
    || fail "$BUILT was not built from $SRC; not copied"
  mkdir -p "$HOME_DIR/bin"
  cp "$BUILT" "$BIN.new"
  mv "$BIN.new" "$BIN"
  echo "kept $BIN"
}

launch() {
  [ -n "$SERVER" ] || fail "set O8_NEXT_DEV_SERVER to the server origin, such as http://127.0.0.1:PORT"
  [ -x "$BIN" ] || fail "no binary at $BIN; run build and keep first"
  [ -z "$(window_pid)" ] || fail "a development window is already open (pid $(window_pid)); run stop first"
  command -v o8 >/dev/null || fail "the o8 command is not on PATH"
  if [ -z "${O8_NEXT_API_TOKEN:-}" ] && [ -n "$TOKEN_FILE" ]; then
    [ -r "$TOKEN_FILE" ] || fail "cannot read $TOKEN_FILE"
    # Read into the environment of the window only; never printed.
    O8_NEXT_API_TOKEN="$(cat "$TOKEN_FILE")"
    export O8_NEXT_API_TOKEN
  fi
  mkdir -p "$HOME_DIR"
  O8_NEXT_DRIVER_SOCKET="$SOCKET" nohup o8 next --enable-next --binary "$BIN" --app-shell \
    --server "$SERVER" --shell-state "$STATE" >"$HOME_DIR/window.log" 2>&1 </dev/null &
  local tries
  for tries in $(seq 1 40); do
    [ -n "$(window_pid)" ] && { echo "window up (pid $(window_pid)); log $HOME_DIR/window.log"; return; }
    sleep 0.5
  done
  tail -5 "$HOME_DIR/window.log" >&2
  fail "the window did not start after $((tries / 2)) seconds"
}

stop() {
  local pid
  pid="$(window_pid)"
  [ -n "$pid" ] || { echo "no development window"; return; }
  kill "$pid"
  echo "stopped $pid"
}

shot() {
  local out="${1:-$HOME_DIR/capture.png}" pid id
  # Remove the last image first: a window that is gone must never leave an
  # old picture to be read as a new one.
  rm -f "$out"
  [ "$(uname)" = Darwin ] || fail "capture is macOS only"
  pid="$(window_pid)"
  [ -n "$pid" ] || fail "no development window"
  id="$(swift "$here/window-id.swift" "$pid")"
  [ -n "$id" ] || fail "the window is not on screen"
  screencapture -x -o -l "$id" "$out"
  [ -s "$out" ] || fail "the capture is empty (screen recording permission?)"
  echo "$out"
}

case "${1:-}" in
  build) build ;;
  keep) keep ;;
  launch) launch ;;
  stop) stop ;;
  shot) shot "${2:-}" ;;
  drive)
    shift
    O8_NEXT_DRIVER_SOCKET="$SOCKET" node "$here/../drive.mjs" "$@"
    ;;
  env)
    printf '%s\n' "source   $SRC" "home     $HOME_DIR" "target   $TARGET" "profile  $PROFILE" \
      "server   ${SERVER:-(unset)}" "binary   $BIN" "socket   $SOCKET"
    ;;
  *) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
