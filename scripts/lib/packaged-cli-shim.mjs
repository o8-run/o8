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
  [ -x "$CANDIDATE" ] || return 0
  VERSION="$("$CANDIDATE" --version 2>/dev/null)" || return 0
  [ -n "$FOUND_VERSION" ] || FOUND_VERSION="$VERSION"
  MAJOR="\${VERSION#v}"
  MAJOR="\${MAJOR%%.*}"
  case " $SUPPORTED_MAJORS " in
    *" $MAJOR "*) exec "$CANDIDATE" "$DIR/o8.mjs" "$@" ;;
  esac
}
try_node "\${O8_NODE_BIN:-}" "$@"
# The desktop's existing probe cache records paths, not a guaranteed last
# server selection. Re-probe them; never trust the cached version or stamp.
if [ -n "\${HOME:-}" ] && [ -r "$HOME/.o8/node-abi-cache" ]; then
  while IFS="$(printf '\t')" read -r CACHED_NODE REST || [ -n "$CACHED_NODE" ]; do
    try_node "$CACHED_NODE" "$@"
  done < "$HOME/.o8/node-abi-cache"
fi
for LOGIN_SHELL in zsh bash sh; do
  LOGIN_NODE="$("$LOGIN_SHELL" -l -c 'command -v node' 2>/dev/null || true)"
  try_node "$LOGIN_NODE" "$@"
done
# Walk every PATH directory, including paths containing spaces and empty entries.
NODE_PATH="\${PATH:-}:"
while [ -n "$NODE_PATH" ]; do
  NODE_DIR="\${NODE_PATH%%:*}"
  NODE_PATH="\${NODE_PATH#*:}"
  try_node "\${NODE_DIR:-.}/node" "$@"
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
printf 'o8: Found Node.js %s; supported majors: %s. Set O8_NODE_BIN to a supported Node.js binary.\n' "\${FOUND_VERSION:-none}" "$SUPPORTED_MAJORS" >&2
exit 127
`;
}
