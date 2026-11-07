// POSIX entry point shared by the packaged CLI export and its executable tests.
export function packagedCliShim(nodeMajors) {
  return `#!/bin/sh
set -eu
# Resolve the REAL script location through symlinks — o8 is invoked via
# /usr/local/bin/o8 -> <app bundle>/server/bin/o8, and dirname "$0" alone
# pointed at /usr/local/bin, so o8.mjs was never found (every PATH invocation,
# including dispatched workers' \`o8 packet report\`, died MODULE_NOT_FOUND).
SELF="$0"
while [ -L "$SELF" ]; do
  LINK="$(readlink -- "$SELF")"
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *) SELF="$(dirname -- "$SELF")/$LINK" ;;
  esac
done
DIR="$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)"
SUPPORTED_MAJORS="${nodeMajors.join(' ')}"
FOUND_VERSION=""
try_node() {
  CANDIDATE="$1"
  shift
  # Only absolute paths: a relative override or PATH entry would run a
  # \`node\` planted in whatever directory o8 was invoked from.
  case "$CANDIDATE" in /*) ;; *) return 0 ;; esac
  [ -x "$CANDIDATE" ] || return 0
  VERSION="$("$CANDIDATE" --version 2>/dev/null)" || return 0
  [ -n "$FOUND_VERSION" ] || FOUND_VERSION="$VERSION"
  MAJOR="\${VERSION#v}"
  MAJOR="\${MAJOR%%.*}"
  case " $SUPPORTED_MAJORS " in
    *" $MAJOR "*) exec "$CANDIDATE" "$DIR/o8.mjs" "$@" 3<&- ;;
  esac
}
try_node "\${O8_NODE_BIN:-}" "$@"
# The desktop's existing probe cache records paths, not a guaranteed last
# server selection. Re-probe them; never trust the cached version or stamp.
if [ -n "\${HOME:-}" ] && [ -r "$HOME/.o8/node-abi-cache" ]; then
  # Read on fd 3 so a selected Node keeps the caller's stdin.
  while IFS="$(printf '\t')" read -r CACHED_NODE REST <&3 || [ -n "$CACHED_NODE" ]; do
    try_node "$CACHED_NODE" "$@"
  done 3< "$HOME/.o8/node-abi-cache"
fi
for LOGIN_SHELL in zsh bash sh; do
  # From / so an empty or "." PATH entry cannot resolve the caller's directory.
  LOGIN_NODE="$(cd / && "$LOGIN_SHELL" -l -c 'command -v node' 2>/dev/null || true)"
  try_node "$LOGIN_NODE" "$@"
done
# Walk every PATH directory, including paths containing spaces. Empty and
# relative entries are skipped, and Node's own NODE_PATH is left alone.
SEARCH_PATH="\${PATH:-}:"
while [ -n "$SEARCH_PATH" ]; do
  NODE_DIR="\${SEARCH_PATH%%:*}"
  SEARCH_PATH="\${SEARCH_PATH#*:}"
  if [ -n "$NODE_DIR" ]; then try_node "$NODE_DIR/node" "$@"; fi
done
if [ -n "\${HOME:-}" ]; then
  NVM_ROOT="\${NVM_DIR:-$HOME/.nvm}"
  NVM_DEFAULT=""
  if [ -r "$NVM_ROOT/alias/default" ]; then
    IFS= read -r NVM_DEFAULT < "$NVM_ROOT/alias/default" || true
    case "$NVM_DEFAULT" in [0-9]*) NVM_DEFAULT="v$NVM_DEFAULT" ;; esac
    if [ -n "$NVM_DEFAULT" ]; then
      for CANDIDATE in "$NVM_ROOT"/versions/node/"$NVM_DEFAULT"*/bin/node; do
        try_node "$CANDIDATE" "$@"
      done
    fi
  fi
  for CANDIDATE in "$NVM_ROOT"/versions/node/*/bin/node; do
    try_node "$CANDIDATE" "$@"
  done
fi
for BREW_ROOT in "\${HOMEBREW_PREFIX:-/opt/homebrew}" "\${HOMEBREW_PREFIX:-/usr/local}"; do
  for CANDIDATE in "$BREW_ROOT"/bin/node "$BREW_ROOT"/opt/node@*/bin/node; do
    try_node "$CANDIDATE" "$@"
  done
done
if [ -n "$FOUND_VERSION" ]; then
  printf 'o8: Found Node.js %s; supported majors: %s. Set O8_NODE_BIN to a supported Node.js binary.\n' "$FOUND_VERSION" "$SUPPORTED_MAJORS" >&2
else
  printf 'o8: No Node.js found; supported majors: %s. Set O8_NODE_BIN to a supported Node.js binary.\n' "$SUPPORTED_MAJORS" >&2
fi
exit 127
`;
}
