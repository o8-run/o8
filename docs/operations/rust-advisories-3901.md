# Rust dependency verification for #3901

Checked on 2026-10-25 against advisory database `21d909e4c8bd4e14c7aea58bf980c881a0053ab1` with `cargo-audit 0.22.2`.

The dependency audit is the regression entry point for this policy change. The same unchanged lockfiles were audited before and after the three scoped maintenance ignores against the same database. The packages remain in the dependency graphs; the after column reports policy exclusion, not completed retirement.

## Dependency trace and migration constraint

The app graph reaches `zbus 5.14.0` through `tauri-plugin-notification -> notify-rust` and `tauri-plugin-single-instance`. The latter also forwards deep links from subsequent launches. The native graph reaches `zbus 5.19.0` through the renderer's `ashpd 0.11.1` and `oo7 0.5.0 -> ashpd 0.12.3` dependencies. Those bus versions resolve the standalone name, wire-format and derive crates named by the three notices. `zbus` is the maintained migration target; the issue records identify `zbus_names`, `zvariant` and `zvariant_derive`.

Checked current stable parent metadata before choosing the fallback:

| Consumer | Current stable release | Bus requirement |
| --- | --- | --- |
| `notify-rust` | 4.18.2 | 5.x |
| `tauri-plugin-single-instance` | 2.5.4 | ^5.9 |
| `ashpd` | 0.13.13 | ^5.13 |
| `oo7` | 0.6.0 | ^5.12; standalone wire types also required |
| `gpui` | 0.2.2 | portal/credential dependencies still select 5.x |

Direct `cargo update -p zbus --precise 6.0.0` attempts fail in both app graphs with `failed to select a version for the requirement zbus = "^5.9"`: the shell is constrained by its single-instance consumer and the native app by its credential consumer. No lockfile changed during those attempts. A notification backend change alone would leave the single-instance dependency. The renderer's X11 feature enables portals, and its credential dependency is unconditional. Dropping these paths would remove working Linux functionality.

## Scoped policy and real audit entry points

Only RUSTSEC-2026-0370, RUSTSEC-2026-0371 and RUSTSEC-2026-0372 are added to the ignore list. Each entry is a standalone-crate maintenance notice. The entries are dated 2026-10-25, require review by 2026-11-25, and name #3901/#3902/#3903 as the follow-up for consumer migration and removal.

The pinned CI audit action invokes `cargo audit --json --file src-tauri/Cargo.lock` from the repository root. Therefore `.cargo/audit.toml` covers that real CI entry point and supplies one shared policy for both graphs. Launch audits from the repository root with `cargo audit --file src-tauri/Cargo.lock` or `cargo audit --file native/o8-next/Cargo.lock`; the audit tool does not search parent directories for this configuration when launched inside a workspace. The array was checked to contain exactly those three IDs. Existing CLI ignores in the workflow and all other findings remain unchanged.

A targeted check drives the real `cargo audit` command and reads its JSON report. It was written and run before the policy change:

```text
Targeted maintenance findings: RUSTSEC-2026-0370,RUSTSEC-2026-0371,RUSTSEC-2026-0372
exit=1
```

After the policy change, the same check reports:

```text
Targeted maintenance findings: none
Targeted maintenance audit check passed; other findings remain separately reported.
exit=0
```

Audits of both workspace lockfiles from the repository root also report zero matching maintenance records. The shell audit still exits 1 on unrelated findings without the workflow's existing exceptions; this verifies that the scoped policy does not suppress those findings. No runtime exposure or full dependency retirement is claimed.

The final two-file scope also passes `scripts/next/check-surface-boundary.mjs --select-only` through a committed local fixture tree:

```text
o8 next surface boundary: no scoped changes
o8 next surface boundary wall=0.013 s

exit=0
```

## Advisory comparison

| Lockfile | Before | After |
| --- | --- | --- |
| `crates/o8d/Cargo.lock` | no matching finding | no matching finding |
| `native/o8-next/Cargo.lock` | RUSTSEC-2026-0371 (zbus_names 4.3.5), RUSTSEC-2026-0370 (zvariant 5.15.1), RUSTSEC-2026-0372 (zvariant_derive 5.15.1) | no matching finding |
| `src-tauri/Cargo.lock` | RUSTSEC-2026-0371 (zbus_names 4.3.1), RUSTSEC-2026-0370 (zvariant 5.10.0), RUSTSEC-2026-0372 (zvariant_derive 5.10.0) | no matching finding |
| `src-tauri/sidecars/pi-write/Cargo.lock` | no matching finding | no matching finding |
| `src-tauri/vendor/clerk-fapi-rs-0.2.0/Cargo.lock` | no matching finding | no matching finding |
| `src-tauri/vendor/tauri-plugin-clerk-0.1.1/Cargo.lock` | no matching finding | no matching finding |
| `tests/native-codex/Cargo.lock` | no matching finding | no matching finding |

Full `cargo audit` reports were also recorded. The advisory-only comparison uses `--no-yanked` to separate missing registry-cache entries from advisory findings. Neither command changes the required CI policy.

## Completion checks

| Command or file | Result tail |
| --- | --- |
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` | exit 0 |
| `npm run typecheck:fast` | exit 0 |
| `npm run test:classify` | [test-classification] 1247 hermetic, 934 resource-owning |
| focused tests | Test Files  6 passed (6); Tests  39 passed (39) |
| full `npm test` with the required runtime | Test Files  1251 passed \| 3 skipped (1254); Tests  9168 passed \| 5 skipped (9173) |

Focused test files: `tests/ci-gates-real-path.test.ts`, `tests/update-ping-entry-points.test.ts`, `tests/product-telemetry-entry-points.test.ts`, `tests/product-telemetry-toggle.test.ts`, `tests/auth-native-logging.test.ts`, `tests/workflow-policy.test.ts`.

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
| `cargo test --locked --manifest-path tests/native-codex/Cargo.toml` | exit 0; test result: ok. 26 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.86s; test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| `cargo test --locked --manifest-path crates/o8d/Cargo.toml --all-features` | exit 0; test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.85s; test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.24s; test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| `cargo build --locked --manifest-path src-tauri/Cargo.toml` | exit 101; exit=101 |

## Retained audit receipts

| Receipt | SHA-256 |
| --- | --- |
| `crates_o8d-audit-after-advisories.json` | `09de24f58401bb70fc48b02b8e61884c9a26dc65621fffbabaa5770322eec21e` |
| `crates_o8d-audit-after.json` | `09de24f58401bb70fc48b02b8e61884c9a26dc65621fffbabaa5770322eec21e` |
| `crates_o8d-audit-before-advisories.json` | `2b4e22134551de39dd762335a72db72b84c976cc2555df6d871086afe19c5b3a` |
| `crates_o8d-audit-before.json` | `2b4e22134551de39dd762335a72db72b84c976cc2555df6d871086afe19c5b3a` |
| `native_o8-next-audit-after-advisories.json` | `d3b2968be3bdb3d6726369b911b7e6711a3dfd45c52a43e8f666c6e4044654b5` |
| `native_o8-next-audit-after.json` | `d3b2968be3bdb3d6726369b911b7e6711a3dfd45c52a43e8f666c6e4044654b5` |
| `native_o8-next-audit-before-advisories.json` | `981c1c8396dd2803a582273974f228255f49cd7f149f06b39ab4b04a111f729a` |
| `native_o8-next-audit-before.json` | `981c1c8396dd2803a582273974f228255f49cd7f149f06b39ab4b04a111f729a` |
| `src-tauri-audit-after-advisories.json` | `dbe3dd73066db43eee5775a73dbab9cb5da14b424a6b51b9615da51905913e96` |
| `src-tauri-audit-after.json` | `0633d25cb67bf7f0ae56f2b49a41b4304a45a15b5673d0057728931e813e3238` |
| `src-tauri-audit-before-advisories.json` | `f3466fce54a3686c91554b9d0c0fd2435946f69214edb2125f5398022977e59c` |
| `src-tauri-audit-before.json` | `eced4484bdad4da3138be8d5dcd58397306e2c2ec6fec16e9595f3bf9dffd463` |
| `src-tauri_sidecars_pi-write-audit-after-advisories.json` | `4f91b606a36cc4d259ed45895e67f702ca060ef904890dc2e4519eaf61af1ced` |
| `src-tauri_sidecars_pi-write-audit-after.json` | `4f91b606a36cc4d259ed45895e67f702ca060ef904890dc2e4519eaf61af1ced` |
| `src-tauri_sidecars_pi-write-audit-before-advisories.json` | `11b0d35a3540076527c824adeb3ebbc1312d726f87b1f5ab22a45538cfd8f586` |
| `src-tauri_sidecars_pi-write-audit-before.json` | `11b0d35a3540076527c824adeb3ebbc1312d726f87b1f5ab22a45538cfd8f586` |
| `src-tauri_vendor_clerk-fapi-rs-0.2.0-audit-after-advisories.json` | `40171949286081ac3bdddd97f562b4c547c69e098e3d03824ced6ab2eca3e3c6` |
| `src-tauri_vendor_clerk-fapi-rs-0.2.0-audit-after.json` | `37866620c6d54dbf6f509233a661ef75e1df401e15df4098f248045667cbd490` |
| `src-tauri_vendor_clerk-fapi-rs-0.2.0-audit-before-advisories.json` | `9a27ae3697d198d36987f2b137bc7ab0b92aa882fabf5b2c8829c112d9fdaf9a` |
| `src-tauri_vendor_clerk-fapi-rs-0.2.0-audit-before.json` | `6371e16f5ac79d81c82f4700629f4d622287894d069c32003fd2f3e9e61825cf` |
| `src-tauri_vendor_tauri-plugin-clerk-0.1.1-audit-after-advisories.json` | `09255a5e5d1654cea4e7d45086b7e084a6e0173236d04f56042b84efc963abe8` |
| `src-tauri_vendor_tauri-plugin-clerk-0.1.1-audit-after.json` | `09255a5e5d1654cea4e7d45086b7e084a6e0173236d04f56042b84efc963abe8` |
| `src-tauri_vendor_tauri-plugin-clerk-0.1.1-audit-before-advisories.json` | `dcf661295d6855e2cc060cd0844a2fd65ae0dcb6d9f36dfb7eed89abc2595c42` |
| `src-tauri_vendor_tauri-plugin-clerk-0.1.1-audit-before.json` | `dcf661295d6855e2cc060cd0844a2fd65ae0dcb6d9f36dfb7eed89abc2595c42` |
| `tests_native-codex-audit-after-advisories.json` | `d357bb51e76509ddb83d8bc256bbc2ec03d2360f0629001cf69760649cb94f64` |
| `tests_native-codex-audit-after.json` | `d357bb51e76509ddb83d8bc256bbc2ec03d2360f0629001cf69760649cb94f64` |
| `tests_native-codex-audit-before-advisories.json` | `d09c71dc3d4967ce05ebdc7fa28645d8309f85bec9fd24445d7875fa9c6e0836` |
| `tests_native-codex-audit-before.json` | `d09c71dc3d4967ce05ebdc7fa28645d8309f85bec9fd24445d7875fa9c6e0836` |

## Remaining acceptance

The three maintenance notices are scoped ignores, not completed dependency retirement. Remove these entries after the stable notification/single-instance and renderer portal/credential consumers support the maintained 6.x modules. Review by 2026-11-25 and track the migration in #3901, #3902 and #3903. No vulnerability threshold or other advisory policy changed; other findings remain visible.

- Finish the shell app build and GUI-linked tests with the Linux GUI development libraries. Local invocations stop at missing `glib-2.0`/`gobject-2.0` metadata; system package installation is unavailable here.
- Complete native Windows CI using its C toolchain and `lib.exe`. Existing Windows source portability failures remain in the write sidecar and native test harness.
- The renderer vendor manifests cannot run as standalone workspace members; their code is checked through the native app, whose Linux check passes.
- No Rust source, manifest or lockfile changed in this item. The native harness and daemon tests were re-run as additional verification. Full audit reports preserve unrelated findings; the runtime and certificate corrections are separate PRs.

Keep all three issues open until the consumer migrations and remaining native checks are complete. No merge or release was performed.
