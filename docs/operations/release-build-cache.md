# Release build cache

Desktop builds reuse verified compiler state and finished native executables from a local, content-addressed cache. The cache accelerates work while preserving the release pipeline's existing signing, notarization, publication, and exact-output checks.

## Cached phases

The build wrapper caches three phases:

- Web compiler state under `.next/cache`.
- The four staged `speech-local` helper executables under `src-tauri/helpers/`, keyed by Swift sources, package manifests and lockfile, compiler and SDK versions, target requirements, and Swift build environment. A verified hit skips the speech compiler.
- Standard macOS release builds cache the unsigned native executables, matching dSYMs for each architecture, and generated speech-recognizer helpers under `src-tauri/target/.release-native-artifact`. A verified hit supplies each executable through Tauri's Cargo runner and skips compilation. Tauri still runs prebuild, universal assembly, and bundling. Checkout-bound Cargo permission paths and other compiler metadata are excluded from this portable artifact. Other targets, debug builds, custom profiles, custom runners, and explicit target-directory arguments retain the existing compiler-state cache behavior.

Final applications, installers, exported server output, signatures, notarization tickets, and publication state are never cache inputs or cache outputs. Web builds still execute with restored compiler state. Native and speech compiler calls can be skipped only after executable-cache verification. Signing, notarization, publication, and all existing release gates remain in their existing pipeline.

## Identity and trust boundary

Each entry has two identities:

1. The compatibility identity covers the phase, platform, architecture, release mode, command options, toolchain versions, lockfiles, build recipes, target contract, relevant hashed build-time environment values, and hashes of the production env files loaded by the frontend build.
2. The full entry identity adds the Git commit, Git tree, and clean-worktree state.

A different source tree may reuse an entry only when the compatibility identity matches. Native compatibility additionally hashes tracked Rust sources, local crates, embedded prompt data, helpers, permissions, capabilities, icons, Cargo configuration, compiler features/options, build profile, compiler/SDK identities, and build-time environment values. Command options and external configuration values are recorded as hashes. Dirty worktrees bypass both restore and capture, except for the operator-owned `o8.md` review surface.

Native identity also covers every local file embedded through the effective `build.frontendDist`, including directory contents and explicit file arrays after base, platform, and command-line configuration overrides. URL frontends do not embed local assets. Symbolic links or unparseable configuration bypass native caching. The Cargo runner collects the native identity after prebuild has generated embedded assets. Both architecture calls share that identity and the wrapper's compiler-environment snapshot. Each call rechecks the inputs; capture compares the compiled identity with the final source and refuses changing inputs. A fresh checkout can therefore capture on its first build and restore on its second unchanged build even when generated frontend files are initially absent. Speech capture independently compares its source identity before and after compilation, so a source mutation cannot store a helper under the earlier source key. The complete prebuild manifest also requires an unchanged recipe; returning to the earlier source cannot bypass the speech miss through whole-artifact reuse.

The effective merged Tauri configuration and the bytes of configured bundle and tray icons are hashed, including icon paths outside `src-tauri`. Native dSYMs are copied from Cargo output into the portable artifact beside their executable and restored into the checkout's per-architecture release directory. Cargo's dSYM alias is resolved within its owned target before copying. The existing postship symbol-retention step can then retain these matching symbols outside the app before cleanup.

Cache directories and files are private to the local user. Before extraction, the build verifies the entry schema, compatibility identity, target contract, archive size, SHA-256 digest, and every archived path. Extraction happens in a quarantine directory, and restored trees may not contain symbolic links. A missing, corrupt, incompatible, or unreadable entry becomes a cache miss and normal compilation continues. Successfully rebuilt private regular entries replace corrupt entries. Existing native or speech output is reused only when its paths, types, file modes, sizes, and hashes match the verified archive; mismatched existing output is preserved for the compiler to rebuild.

This verification detects corruption and metadata mismatch. It does not turn an external cache provider into a trusted release authority. Any future remote transport must retain the verifier and add its own authenticated distribution boundary.

## Operation

`npm run tauri:build`, `npm run tauri:build:signed`, `npm run tauri:build:nonotary`, and `npm run tauri:build:stable-macos` use the shared cache automatically. The default root is the private per-user release build cache.

Set `O8_RELEASE_BUILD_CACHE_DIR` to isolate a canary or move the cache to another local volume. Set `O8_RELEASE_BUILD_CACHE=off` to bypass restore and capture without changing the build command.

For a macOS external volume, create a private marker at the volume root whose contents are a stable operator-chosen identity, then configure both the cache directory and that identity:

```bash
export O8_RELEASE_BUILD_CACHE_VOLUME_ID="<stable-volume-identity>"
printf '%s\n' "$O8_RELEASE_BUILD_CACHE_VOLUME_ID" > "/Volumes/<volume>/.o8-release-cache-volume"
export O8_RELEASE_BUILD_CACHE_DIR="/Volumes/<volume>/o8/release-cache"
```

Create the marker while the intended volume is mounted. Do not pre-create `/Volumes/<volume>` when it is absent. Before every restore or capture, the wrapper reads the marker and requires its contents to exactly match `O8_RELEASE_BUILD_CACHE_VOLUME_ID`. A missing marker, missing identity, or changed marker causes one warning and selects the local default instead; the wrapper never creates the configured `/Volumes/...` path in that state. `O8_RELEASE_BUILD_CACHE_LOCAL_DIR` can override the fallback for a hermetic canary.

The cache-entry budget defaults to 4 GiB on the local root and 20 GiB on a validated external root. Set `O8_RELEASE_BUILD_CACHE_MAX_BYTES` to a non-negative integer byte count to override it. Capture prunes whole compatibility entries oldest-first, with relative path as the deterministic tie-breaker. Receipts are outside the budget and are not pruned.

The cache retains one source entry for each compatibility identity and the two newest compatibility identities for each phase. This bounds the large native and web intermediates while preserving the most useful rollback point.

## Persistent release Cargo state

Standard macOS release compiles use `<cache-root>/cargo-target` as `CARGO_TARGET_DIR`, independently of the detached release checkout. Set `O8_RELEASE_CARGO_TARGET_DIR` to an absolute directory outside the checkout to override it. The directory must be dedicated to releases; the wrapper refuses a checkout path, a redirected path, a directory containing unowned files, or the inherited development `CARGO_TARGET_DIR`.

Only the release Cargo runner receives this directory. Development Cargo builds keep their own target directory. Tauri receives the checkout-local output directory, and the runner copies finished executables there, so bundle discovery and existing release gates keep their expected paths. Cargo dependencies and their fingerprints remain in the persistent directory across fresh checkouts. On an executable-cache miss, the runner cleans only package `o8` and resets its generated Swift helper intermediates before compilation. This prevents timestamp-only Swift reuse after a compiler, SDK, or deployment-target change while preserving compiled dependencies.

`O8_RELEASE_CARGO_TARGET_MAX_BYTES` sets its byte budget (default 20 GiB, separate from the archive budget). The runner checks before and after each compile. When usage exceeds the budget, it removes the whole disposable compiler state, preserving the ownership marker and active cache lock. Finished executables have already been copied into the checkout before post-compile cleanup. An exclusive cache lock prevents another runner from pruning while a compile is active. An interrupted runner leaves its lock for inspection; remove that lock only after establishing that no release compile owns the directory. Never point development builds at this directory.

## Version boundary and remaining acceptance

Version-only binary reuse is not enabled yet. The native shell reads `CARGO_PKG_VERSION` in desktop info, daemon compatibility, server launch, and telemetry, and Tauri embeds package metadata through `generate_context!()`. The loader also embeds the package version. Reusing that executable unchanged after a version bump would report a stale version and affect updater comparisons. The executable cache therefore includes the package, Cargo, and Tauri versions until runtime version reporting is moved outside the cached executable. A version-only release recompiles native code using the persistent dependency cache.

The Linux fixture tests stub Cargo and Swift at the process boundary. They demonstrate compiler skips, fresh-checkout dependency-state reuse, input invalidation, corruption refusal, and release/development target separation. They do not measure macOS compile speed or validate a signed application. Issue #4636 remains open for version-only binary reuse, shipped-app version proof, two real same-host release timings (second build under 10 minutes), cold/warm native timings across checkouts, and confirmation of signing, notarization, and every release gate on restored artifacts.

## Receipts

Every wrapped build writes a JSON receipt under `<cache-root>/receipts/`. It records:

- Exact, compatible, missed, or bypassed restore status for each phase.
- Restore and build duration for each phase.
- Verified archive bytes restored.
- Estimated build time saved from the producer receipt.
- Overall build outcome and elapsed time.

Receipts contain hashes and aggregate measurements, not repository or cache paths.

## Cold and warm canary

Use an isolated cache root and a clean source tree:

```bash
O8_RELEASE_BUILD_CACHE_DIR=/tmp/o8-release-cache-canary npm run tauri:build -- --no-bundle -- --features dev-mcp-plugin
```

Run once from one clean commit, then run the same command from a different clean source commit with unchanged toolchains, lockfiles, build recipes, environment, and command options. The first receipt should report three misses. The second should report compatible hits for web, speech, and native when embedded versions are also unchanged. Both builds must complete normally; a cache hit alone is not a release receipt.

## Measured canary

This historical compiler-state measurement predates executable skipping and persistent Cargo targets. The 2026-08-27 canary ran the command above twice in the same checkout. The cold run used a clean implementation commit. The warm run used a different clean Git tree with a harmless production TypeScript comment, while toolchains, lockfiles, build recipes, environment, architecture, and command options stayed fixed. The temporary canary commit was not published.

| Phase | Cold build | Changed-source warm build | Saved |
|---|---:|---:|---:|
| Speech | 125.464 s | 4.483 s | 120.981 s |
| Web | 824.043 s | 547.822 s | 276.221 s |
| Native | 554.052 s | 293.586 s | 260.466 s |
| Compiler phases | 1,503.559 s | 845.891 s | 657.668 s |
| Whole command | 1,527.557 s | 905.022 s | 622.535 s |

The cold receipt reported three misses and zero hits. The warm receipt reported three verified compatible hits and zero misses, restored 5,660,587,008 archive bytes, then completed every normal compiler, export, and native link step. Restore and recapture overhead is included in the whole-command comparison.
