# Rust dependency verification for #4688

Checked on 2026-10-25 against advisory database `21d909e4c8bd4e14c7aea58bf980c881a0053ab1` with `cargo-audit 0.22.2`.

The dependency audit is the regression entry point for this dependency-only change. The original lockfiles were audited before editing; the corrected files were audited against the same database. No application behavior change is inferred from static package presence.

## Advisory comparison

| Lockfile | Before | After |
| --- | --- | --- |
| `crates/o8d/Cargo.lock` | no matching finding | no matching finding |
| `native/o8-next/Cargo.lock` | no matching finding | no matching finding |
| `src-tauri/Cargo.lock` | RUSTSEC-2026-0386 (tokio 1.50.0) | no matching finding |
| `src-tauri/sidecars/pi-write/Cargo.lock` | no matching finding | no matching finding |
| `src-tauri/vendor/clerk-fapi-rs-0.2.0/Cargo.lock` | RUSTSEC-2026-0386 (tokio 1.41.1) | no matching finding |
| `src-tauri/vendor/tauri-plugin-clerk-0.1.1/Cargo.lock` | RUSTSEC-2026-0386 (tokio 1.50.0) | no matching finding |
| `tests/native-codex/Cargo.lock` | RUSTSEC-2026-0386 (tokio 1.53.1) | no matching finding |

Full `cargo audit` reports were also recorded. The advisory-only comparison uses `--no-yanked` to separate missing registry-cache entries from advisory findings. Neither command changes the required CI policy.

Audit excerpt before the update:

```text
Crate:     tokio
Version:   1.50.0
Warning:   unsound
Title:     `AsyncFd::new` and related constructors violate I/O safety
Date:      2026-10-13
ID:        RUSTSEC-2026-0386
```

After the update, the unchanged CI ignore policy reports zero vulnerabilities for the app lockfile; the advisory comparison reports zero RUSTSEC-2026-0386 records across all seven tracked lockfiles. Other warning categories remain recorded.

## Completion checks

| Command or file | Result tail |
| --- | --- |
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` | exit 0 |
| `npm run typecheck:fast` | exit 0 |
| `npm run test:classify` | [test-classification] 1247 hermetic, 934 resource-owning |
| focused tests | Test Files  5 passed (5); Tests  31 passed (31) |
| full `npm test` with the required runtime | Test Files  1251 passed \| 3 skipped (1254); Tests  9165 passed \| 5 skipped (9170) |

Focused test files: `tests/ci-gates-real-path.test.ts`, `tests/update-ping-entry-points.test.ts`, `tests/product-telemetry-entry-points.test.ts`, `tests/product-telemetry-toggle.test.ts`, `tests/auth-native-logging.test.ts`.

## Rust compile matrix

`cargo check --workspace --all-targets --locked --manifest-path <manifest> --target <target>` was invoked for every discovered manifest. The two renderer vendor manifests inherit the native workspace and cannot be checked as standalone members; their dependencies are covered by the native app invocation.

| Manifest | Linux target | Windows target |
| --- | --- | --- |
| `native/o8-next/vendor/taffy/Cargo.toml` | exit 101 | exit 101 |
| `native/o8-next/vendor/gpui/Cargo.toml` | exit 101 | exit 101 |
| `native/o8-next/Cargo.toml` | exit 0 | exit 101 |
| `crates/o8d/Cargo.toml` | exit 0 | exit 0 |
| `crates/o8-restart-safety/Cargo.toml` | exit 0 | exit 0 |
| `src-tauri/vendor/tauri-plugin-clerk-0.1.1/Cargo.toml` | exit 101 | exit 101 |
| `src-tauri/vendor/tauri-codegen-2.6.3/Cargo.toml` | exit 0 | exit 0 |
| `src-tauri/vendor/clerk-fapi-rs-0.2.0/Cargo.toml` | exit 0 | exit 0 |
| `src-tauri/sidecars/pi-write/Cargo.toml` | exit 0 | exit 101 |
| `src-tauri/Cargo.toml` | exit 101 | exit 101 |
| `tauri-plugin-mcp/Cargo.toml` | exit 101 | exit 0 |
| `tests/native-codex/Cargo.toml` | exit 0 | exit 101 |
| `tests/fixtures/update-ping-native/Cargo.toml` | exit 101 | exit 101 |

## Touched crate tests and app build

| Command | Result |
| --- | --- |
| `cargo test --locked --manifest-path tests/native-codex/Cargo.toml` | exit 0; test result: ok. 26 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 4.07s; test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s; exit=0 |
| `cargo test --locked --manifest-path crates/o8d/Cargo.toml --all-features` | exit 0; test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.24s; test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s; exit=0 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` | exit 101; exit=101 |
| `cargo test --locked --manifest-path tauri-plugin-mcp/Cargo.toml --lib` | exit 101; exit=101 |
| `cargo test --locked --manifest-path src-tauri/vendor/clerk-fapi-rs-0.2.0/Cargo.toml --lib` | exit 0; test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s; exit=0 |
| `cargo test --locked --manifest-path src-tauri/vendor/tauri-plugin-clerk-0.1.1/Cargo.toml --lib` | exit 101; exit=101 |
| `cargo test --locked --manifest-path tests/fixtures/update-ping-native/Cargo.toml` | exit 101; exit=101 |
| `cargo build --locked --manifest-path src-tauri/Cargo.toml` | exit 101; exit=101 |

## Retained audit receipts

| Receipt | SHA-256 |
| --- | --- |
| `crates_o8d-audit-after-advisories.json` | `2b4e22134551de39dd762335a72db72b84c976cc2555df6d871086afe19c5b3a` |
| `crates_o8d-audit-after.json` | `2b4e22134551de39dd762335a72db72b84c976cc2555df6d871086afe19c5b3a` |
| `crates_o8d-audit-before-advisories.json` | `2b4e22134551de39dd762335a72db72b84c976cc2555df6d871086afe19c5b3a` |
| `crates_o8d-audit-before.json` | `2b4e22134551de39dd762335a72db72b84c976cc2555df6d871086afe19c5b3a` |
| `native_o8-next-audit-after-advisories.json` | `981c1c8396dd2803a582273974f228255f49cd7f149f06b39ab4b04a111f729a` |
| `native_o8-next-audit-after.json` | `981c1c8396dd2803a582273974f228255f49cd7f149f06b39ab4b04a111f729a` |
| `native_o8-next-audit-before-advisories.json` | `981c1c8396dd2803a582273974f228255f49cd7f149f06b39ab4b04a111f729a` |
| `native_o8-next-audit-before.json` | `981c1c8396dd2803a582273974f228255f49cd7f149f06b39ab4b04a111f729a` |
| `src-tauri-audit-after-advisories.json` | `6ffd641d4dea67a066e4903eb2090cf629726e788f799d0808b656f31a061879` |
| `src-tauri-audit-after.json` | `0a5118388780dd00ff7c2a330a751fe7f7440ba49e0c5aee43987aeb345dec47` |
| `src-tauri-audit-before-advisories.json` | `f3466fce54a3686c91554b9d0c0fd2435946f69214edb2125f5398022977e59c` |
| `src-tauri-audit-before.json` | `eced4484bdad4da3138be8d5dcd58397306e2c2ec6fec16e9595f3bf9dffd463` |
| `src-tauri_sidecars_pi-write-audit-after-advisories.json` | `11b0d35a3540076527c824adeb3ebbc1312d726f87b1f5ab22a45538cfd8f586` |
| `src-tauri_sidecars_pi-write-audit-after.json` | `11b0d35a3540076527c824adeb3ebbc1312d726f87b1f5ab22a45538cfd8f586` |
| `src-tauri_sidecars_pi-write-audit-before-advisories.json` | `11b0d35a3540076527c824adeb3ebbc1312d726f87b1f5ab22a45538cfd8f586` |
| `src-tauri_sidecars_pi-write-audit-before.json` | `11b0d35a3540076527c824adeb3ebbc1312d726f87b1f5ab22a45538cfd8f586` |
| `src-tauri_vendor_clerk-fapi-rs-0.2.0-audit-after-advisories.json` | `71dbf3316bbf7e110f8513d9afd35e1bf53b9687cab1ac5c56a1f7299b3b94e7` |
| `src-tauri_vendor_clerk-fapi-rs-0.2.0-audit-after.json` | `461d6c60a9b5bc16ac39eeffce8f7eeb3109563d96c7d092c6228ba8e06d8e9e` |
| `src-tauri_vendor_clerk-fapi-rs-0.2.0-audit-before-advisories.json` | `9a27ae3697d198d36987f2b137bc7ab0b92aa882fabf5b2c8829c112d9fdaf9a` |
| `src-tauri_vendor_clerk-fapi-rs-0.2.0-audit-before.json` | `6371e16f5ac79d81c82f4700629f4d622287894d069c32003fd2f3e9e61825cf` |
| `src-tauri_vendor_tauri-plugin-clerk-0.1.1-audit-after-advisories.json` | `6b4c4735ec8dc32a19e1ecafbe633da477263a79660e4f6bbf5ba9731eaecd44` |
| `src-tauri_vendor_tauri-plugin-clerk-0.1.1-audit-after.json` | `6b4c4735ec8dc32a19e1ecafbe633da477263a79660e4f6bbf5ba9731eaecd44` |
| `src-tauri_vendor_tauri-plugin-clerk-0.1.1-audit-before-advisories.json` | `dcf661295d6855e2cc060cd0844a2fd65ae0dcb6d9f36dfb7eed89abc2595c42` |
| `src-tauri_vendor_tauri-plugin-clerk-0.1.1-audit-before.json` | `dcf661295d6855e2cc060cd0844a2fd65ae0dcb6d9f36dfb7eed89abc2595c42` |
| `tests_native-codex-audit-after-advisories.json` | `135e622443a82fed684e56dfa9dc69cab6cd28bb5b1b2a7a310e5873eebebb5f` |
| `tests_native-codex-audit-after.json` | `135e622443a82fed684e56dfa9dc69cab6cd28bb5b1b2a7a310e5873eebebb5f` |
| `tests_native-codex-audit-before-advisories.json` | `d09c71dc3d4967ce05ebdc7fa28645d8309f85bec9fd24445d7875fa9c6e0836` |
| `tests_native-codex-audit-before.json` | `d09c71dc3d4967ce05ebdc7fa28645d8309f85bec9fd24445d7875fa9c6e0836` |

## Remaining acceptance

The AsyncFd advisory is absent from every tracked lockfile. No audit ignore was added.

- The shell app build and its GUI-linked tests need the Linux GUI development libraries. The local failure is `The system library glib-2.0 required by crate glib-sys was not found`; related invocations also report missing `gobject-2.0`. Installing system packages is unavailable in this read-only system environment.
- Native Windows CI remains required. Cross-target invocations stop at the missing archive tool `lib.exe` and unavailable native C toolchain. A cross-target check on this Linux host does not establish native Windows acceptance.
- The write sidecar also has existing Windows source errors, including the missing platform-specific `dir_path` implementation. It passes the Linux check. Porting that sidecar is outside this advisory correction.
- The native test harness additionally imports a Unix-only test fixture on Windows. That existing all-targets portability failure must be corrected or the harness scoped to supported targets before universal target acceptance can be claimed.
- The two renderer vendor manifests cannot run as standalone workspace members. Their code is reached through `native/o8-next`, whose Linux check passes.
- Other advisories in vendored standalone lockfiles and warning-only findings remain outside this item. Their presence is recorded by the full audit; clearance here applies to RUSTSEC-2026-0386.

Keep the issue open until the remaining native checks pass. No merge or release was performed.
