# Native release size

The native release profile strips executable symbols, uses thin LTO and one
codegen unit, and keeps Rust's default unwind behavior. Release builds generate
line tables and pack the debug information into separate macOS dSYM bundles.

For a universal build, retain both architecture artifacts:

```text
src-tauri/target/aarch64-apple-darwin/release/o8.dSYM/
src-tauri/target/x86_64-apple-darwin/release/o8.dSYM/
```

These directories sit outside `bundle/macos/o8.app`. Before removing
`src-tauri/target`, `scripts/postship-cleanup.mjs` copies and verifies the dSYMs
in a private retained store, outside the checkout:

```text
$HOME/.o8-symbols/<version>/<cpu>/<UUID>/<bundle-sha256>/o8.dSYM/
$HOME/.o8-symbols/<version>/<cpu>/<UUID>/<bundle-sha256>/receipt.json
```

CPU keys are `arm64` and `x86_64`. `O8_RELEASE_SYMBOLS_DIR` selects an absolute
alternative outside the checkout. Directories are owner-only (0700), and files
are owner-only (0600). These artifacts contain private source paths; do not
upload them as public download assets. Keep this store when retiring release
checkouts. Postship cleanup does not remove retained symbols.

Retention checks executable/dSYM UUIDs, copies the complete bundles through a
private staging directory, and verifies their SHA-256 content before cleanup.
Distinct UUIDs and content hashes preserve rebuilds of the same version.
An unavailable store, invalid path, changed copy or UUID mismatch refuses native
cleanup and keeps the original target tree. `--best-effort` reports the refusal
without failing the publication tail; it still keeps that tree. Preserve and
inspect any `.pending-*` copy after an interrupted retention attempt.

Manual `cargo clean` does not perform retention. Before manual cleanup, invoke
the retention function from the checkout and verify it succeeds:

```sh
node --input-type=module -e 'import { retainMacosReleaseSymbols } from "./scripts/lib/release-symbols.mjs"; await retainMacosReleaseSymbols(process.cwd());'
```

The universal executable contains both UUIDs. Each architecture's dSYM must
match that architecture's UUID in the executable:

```sh
dwarfdump --uuid src-tauri/target/universal-apple-darwin/release/o8
dwarfdump --uuid src-tauri/target/aarch64-apple-darwin/release/o8.dSYM
dwarfdump --uuid src-tauri/target/x86_64-apple-darwin/release/o8.dSYM
```

Signing and thinning preserve the executable UUID. Keep the matching dSYM for
each retained release; a rebuild of the same version is not a replacement for
the original symbols. `tests/native-release-profile.test.ts` compiles both slices
with the repository profile, checks stripped symbols and matching dSYM UUIDs,
and resolves a retained function address with `atos` after postship cleanup has
deleted the original build tree. `tests/postship-cleanup.test.ts` also exercises
the production CLI, failed retention, corrupt retained copies, UUID mismatches
and repeated cleanup.

## Binary-only measurement

Build both native targets with the release features, then combine their binaries.
Run the same commands from empty Cargo output for each profile. Set
`MACOSX_DEPLOYMENT_TARGET=14.0` and use the same `CARGO_BUILD_JOBS` each time.
The frontend export and external sidecars must already exist. Reuse the same
inputs for every run; do not include the web export in the native compile time.

```sh
cargo build --release --locked --bin o8 \
  --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin \
  --features dev-mcp-plugin,tauri/custom-protocol
cargo build --release --locked --bin o8 \
  --manifest-path src-tauri/Cargo.toml --target x86_64-apple-darwin \
  --features dev-mcp-plugin,tauri/custom-protocol
mkdir -p src-tauri/target/universal-apple-darwin/release
lipo -create src-tauri/target/aarch64-apple-darwin/release/o8 \
  src-tauri/target/x86_64-apple-darwin/release/o8 \
  -output src-tauri/target/universal-apple-darwin/release/o8
```

The elapsed compile time is the sum of the two Cargo invocations. It includes
dependency compilation and build scripts, and excludes cleaning, bundling and
the final `lipo` operation. Compare `thin` and `fat` using
`CARGO_PROFILE_RELEASE_LTO`. Keep strip, debug, split debug information and codegen units
identical between the two LTO runs.

## Measurements, 2026-10-24

The source baseline is `8517645db5a8`. These cold binary-only builds used
`rustc 1.94.0`, macOS deployment target 14.0, four Cargo jobs and
`dev-mcp-plugin,tauri/custom-protocol`. Both architectures started from empty
Cargo output for each profile. Concurrent host work affects the observed wall
times. The optimized runs include packed dSYM generation.

| Profile | Universal executable bytes | Cargo wall time | Defined symbols (`nm -U`) |
| --- | ---: | ---: | ---: |
| Repository default | 96,969,840 | 48m 37s | 99,216 |
| Thin LTO, stripped | 67,533,792 | 59m 54s | 1 |
| Fat LTO, stripped | 63,809,152 | 70m 25s | 1 |

Thin LTO is selected: it saves 29,436,048 bytes (30.4%) against the default
profile and avoids the additional 10m 31s cold compile for fat LTO's 3,724,640
byte saving. Fat LTO for a final signed build is deferred until
[#4639](https://github.com/o8-run/o8/issues/4639) proves macOS reuse of matching
native slices and dSYMs. Both measured profiles' dSYM UUIDs match their
corresponding executable slices.

Unsigned bundle and download-size measurements reuse the existing 0.1.807 web
export and external sidecars with the measured fat-LTO native executable. Those
historical packaging measurements are not a new thin-LTO bundle measurement. This holds
the resource payload fixed while measuring native packaging changes.
