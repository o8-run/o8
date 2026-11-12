#!/usr/bin/env bash
set -euo pipefail

# This complete recipe, including install commands and feature flags, is hashed
# into the executable cache key by audit-tool-cache.mjs.
if [ "${AUDIT_TOOL_CACHEABLE:-false}" != true ]; then
  cargo install cargo-audit --locked
  exit 0
fi

version_matches() {
  local actual
  actual=$(cargo audit --version 2>/dev/null) || return 1
  # Cargo/clap releases use either name; the complete version must match.
  case "$actual" in
    "cargo-audit $AUDIT_TOOL_VERSION"|"cargo-audit-audit $AUDIT_TOOL_VERSION") return 0 ;;
    *) return 1 ;;
  esac
}

if version_matches && [ "${AUDIT_TOOL_CACHE_HIT:-false}" = true ]; then exit 0; fi
rm -f "${CARGO_HOME:-$HOME/.cargo}/bin/cargo-audit"
cargo install cargo-audit --version "$AUDIT_TOOL_VERSION" --locked --force
version_matches
