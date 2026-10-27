# Rust dependency verification for #4034

Checked on 2026-10-25 against advisory database `21d909e4c8bd4e14c7aea58bf980c881a0053ab1` with `cargo-audit 0.22.2`.

The dependency audit is the regression entry point for this dependency-only change. The original lockfiles were audited before editing; the corrected files were audited against the same database. No application behavior change is inferred from static package presence.

## Preserved original evidence

The original receipt linked from #4034 identifies failed job `118839678438` in run `39484030758`, head `cc7c9e143739f53e90789716f67bb2d24beff0e9`, base `2283e745bc715f057081a43634d296723c2c1c1b`, lockfile blob `19d0218bcb5b355573ba59954be6938561043faa`, and advisory database `e6f94f3760d5e6c54c1b05f204002263bc025524`. That exact lockfile blob and database were retained and re-audited before this correction. The reproduced finding records are:

```text
RUSTSEC-2026-0382 rustls-webpki 0.103.15
RUSTSEC-2026-0383 webpki-root-certs 1.0.6
RUSTSEC-2026-0381 webpki-roots 0.26.11
RUSTSEC-2026-0381 webpki-roots 1.0.8
```

The current app lockfile reports zero vulnerabilities under the unchanged CI ignore policy against both that historical database and the current database. Its legacy root entry is absent. The standalone vendor snapshots still contained three certificate records before this follow-up; the comparison below records their removal. The historical failed job is evidence retained by #4034, not a new CI run from this follow-up.

The current native integration graph was audited without replacing its unrelated lockfile changes. The originally pending candidate #4012 and held PRs #4033/#4025 are merged. Their recorded heads are `0661ba225fa10e5caf369aebf496402b59c95b1e`, `0f97b98fef9f08c8f0d70dfcc93f03ddf6fd501b`, and `70a30f0961fe72c7c7faaac78de12e2ff4a1d1f5`, respectively; their previous green checks remain historical receipts.

## Transport and feature review

The app uses HTTP client versions 0.12.28 and 0.13.2, crash-reporting SDK 0.42.0 and minidump integration 0.13.0. The direct HTTP client and updater permit the existing certificate backend configuration. The SDK's older transport shares certificate features with the rest of the app. No verification option, telemetry gate or transport feature changed.

The standalone API lockfile's older verifier record is present in the lock graph but is not selected by its default native-certificate transport. The standalone plugin reaches the verifier through its HTTP plugin and client. Static presence alone does not establish runtime exposure.

A temporary `tls-fixture/Cargo.toml`, `tls-fixture/src/lib.rs` and `run_tls_fixture.py` exercise the real client builders and crash-reporting HTTP transport with these resolved versions and the corrected certificate stack. Both clients accept a local trusted certificate and reject a wrong hostname and unknown issuer. A synthetic envelope traverses the crash-reporting transport. The server's receipt is:

```text
test result: ok. 1 passed; 0 failed
Loopback HTTP receipt: [('GET', '/trusted'), ('GET', '/trusted'), ('POST', '/api/1/envelope/')]
Trusted requests and synthetic envelope accepted; both clients rejected wrong hostnames and unknown issuers.
```

Only the loopback fixture was contacted. This is a transport check, not installed native crash-capture acceptance.

## Advisory comparison

| Lockfile | Before | After |
| --- | --- | --- |
| `crates/o8d/Cargo.lock` | no matching finding | no matching finding |
| `native/o8-next/Cargo.lock` | no matching finding | no matching finding |
| `src-tauri/Cargo.lock` | no matching finding | no matching finding |
| `src-tauri/sidecars/pi-write/Cargo.lock` | no matching finding | no matching finding |
| `src-tauri/vendor/clerk-fapi-rs-0.2.0/Cargo.lock` | RUSTSEC-2026-0382 (rustls-webpki 0.102.8) | no matching finding |
| `src-tauri/vendor/tauri-plugin-clerk-0.1.1/Cargo.lock` | RUSTSEC-2026-0382 (rustls-webpki 0.103.9), RUSTSEC-2026-0381 (webpki-roots 1.0.6) | no matching finding |
| `tests/native-codex/Cargo.lock` | no matching finding | no matching finding |

Full `cargo audit` reports were also recorded. The advisory-only comparison uses `--no-yanked` to separate missing registry-cache entries from advisory findings. Neither command changes the required CI policy.

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
| `cargo test --locked --manifest-path src-tauri/vendor/clerk-fapi-rs-0.2.0/Cargo.toml --lib` | exit 0; test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s; exit=0 |
| `cargo test --locked --manifest-path src-tauri/vendor/tauri-plugin-clerk-0.1.1/Cargo.toml --lib` | exit 101; exit=101 |
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
| `src-tauri-audit-after-advisories.json` | `f3466fce54a3686c91554b9d0c0fd2435946f69214edb2125f5398022977e59c` |
| `src-tauri-audit-after.json` | `eced4484bdad4da3138be8d5dcd58397306e2c2ec6fec16e9595f3bf9dffd463` |
| `src-tauri-audit-before-advisories.json` | `f3466fce54a3686c91554b9d0c0fd2435946f69214edb2125f5398022977e59c` |
| `src-tauri-audit-before.json` | `eced4484bdad4da3138be8d5dcd58397306e2c2ec6fec16e9595f3bf9dffd463` |
| `src-tauri_sidecars_pi-write-audit-after-advisories.json` | `11b0d35a3540076527c824adeb3ebbc1312d726f87b1f5ab22a45538cfd8f586` |
| `src-tauri_sidecars_pi-write-audit-after.json` | `11b0d35a3540076527c824adeb3ebbc1312d726f87b1f5ab22a45538cfd8f586` |
| `src-tauri_sidecars_pi-write-audit-before-advisories.json` | `11b0d35a3540076527c824adeb3ebbc1312d726f87b1f5ab22a45538cfd8f586` |
| `src-tauri_sidecars_pi-write-audit-before.json` | `11b0d35a3540076527c824adeb3ebbc1312d726f87b1f5ab22a45538cfd8f586` |
| `src-tauri_vendor_clerk-fapi-rs-0.2.0-audit-after-advisories.json` | `c225dfb08ae2c5f176ed996b3cfdc7f79bd680ddcf2833ac29615893af055054` |
| `src-tauri_vendor_clerk-fapi-rs-0.2.0-audit-after.json` | `1a60a4e4cd049ca87335d8edd20b49e6eadd78d2c64232e7e73fc9b4794337f3` |
| `src-tauri_vendor_clerk-fapi-rs-0.2.0-audit-before-advisories.json` | `9a27ae3697d198d36987f2b137bc7ab0b92aa882fabf5b2c8829c112d9fdaf9a` |
| `src-tauri_vendor_clerk-fapi-rs-0.2.0-audit-before.json` | `6371e16f5ac79d81c82f4700629f4d622287894d069c32003fd2f3e9e61825cf` |
| `src-tauri_vendor_tauri-plugin-clerk-0.1.1-audit-after-advisories.json` | `90a9dcfca1334ab76ef16eeb01b9360b250f1cd4768d0404963587a8374a44ae` |
| `src-tauri_vendor_tauri-plugin-clerk-0.1.1-audit-after.json` | `90a9dcfca1334ab76ef16eeb01b9360b250f1cd4768d0404963587a8374a44ae` |
| `src-tauri_vendor_tauri-plugin-clerk-0.1.1-audit-before-advisories.json` | `dcf661295d6855e2cc060cd0844a2fd65ae0dcb6d9f36dfb7eed89abc2595c42` |
| `src-tauri_vendor_tauri-plugin-clerk-0.1.1-audit-before.json` | `dcf661295d6855e2cc060cd0844a2fd65ae0dcb6d9f36dfb7eed89abc2595c42` |
| `tests_native-codex-audit-after-advisories.json` | `d09c71dc3d4967ce05ebdc7fa28645d8309f85bec9fd24445d7875fa9c6e0836` |
| `tests_native-codex-audit-after.json` | `d09c71dc3d4967ce05ebdc7fa28645d8309f85bec9fd24445d7875fa9c6e0836` |
| `tests_native-codex-audit-before-advisories.json` | `d09c71dc3d4967ce05ebdc7fa28645d8309f85bec9fd24445d7875fa9c6e0836` |
| `tests_native-codex-audit-before.json` | `d09c71dc3d4967ce05ebdc7fa28645d8309f85bec9fd24445d7875fa9c6e0836` |

## Remaining acceptance

All records for RUSTSEC-2026-0381, RUSTSEC-2026-0382 and RUSTSEC-2026-0383 are absent from every tracked lockfile. The app's existing SDK/minidump pairing, updater configuration, verification settings and native integration lockfile remain intact. No audit ignore or required-check policy changed.

- Finish the shell build and GUI-linked native tests on a host with the Linux GUI development libraries. Local invocations stop at missing `glib-2.0`/`gobject-2.0` metadata; system package installation is unavailable here.
- Complete the native Windows CI gate on a host with the native C toolchain and `lib.exe`. The all-targets matrix also retains existing Windows source portability failures in the write sidecar and native test harness.
- The renderer vendor manifests cannot run as standalone workspace members; the native app's Linux check passes through those dependencies.
- Native crash capture and installed-release acceptance remain outstanding. The loopback transport fixture verifies certificate handling and synthetic envelope delivery; it does not establish hardware-fault capture in an installed build.
- The historical integration candidate and held PRs #4012, #4033 and #4025 are already merged. Their historical receipts remain linked from #4034. No merge or release hold is cleared by this follow-up, and no new downstream merge was performed.
- Other advisories remain outside the three certificate-trust IDs. In particular, the runtime advisory is handled in its separate PR; existing ignores were not expanded to hide certificate findings.

Keep #4034 open for the remaining native acceptance and exact-head CI checks. No merge or release was performed.
