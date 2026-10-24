# Surface-owned requests (#4695)

Baseline: `c9acfe4b28011462b21e7db1e826738c480a16c0` in an untouched checkout.
Linux, Node 22, Rust stable; the existing owned fixtures and entry points.

The existing fake-surface regression was extended before changing the transport.
Its shell factory now calls a module-owned request that POSTs JSON and a query
parameter to its own discovered fixture entry. The initial build failed at the
surface/transport boundary:

```text
error[E0599]: no method named `url` found for reference `&client::Client`
error[E0599]: no method named `request` found for reference `&client::Client`
error[E0624]: associated function `read` is private
error: could not compile `o8-next` (bin "o8-next" test) due to 3 previous errors
```

After extracting the shared transport helpers:

```text
test shell::fake::new_surface_routes_renders_and_gets_navigation ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 81 filtered out
```

The same test verifies the response query/body receipt, invalid-bearer 401,
ordinary requests withholding desktop identity, rendering, navigation, keyboard
binding and persisted state. Its native method lives entirely in `surfaces/fake.rs`;
the new HTTP peer is an automatically discovered surface entry. The existing one
shell registration line loads the entire native module, including its request.

`cargo test --manifest-path native/o8-next/Cargo.toml -- --test-threads=2`:

| Inventory | Before | After |
| --- | ---: | ---: |
| Passed | 86 | 86 |
| Failed | 0 | 0 |
| Ignored | 3 | 3 |
| Fully qualified test names | 89 | 89 |

All fully qualified test names and statuses are identical; see
[test-names.txt](test-names.txt). No test was added, renamed or moved.

`cargo clippy --manifest-path native/o8-next/Cargo.toml --all-targets` exits zero,
with zero diagnostics in touched native files. Existing unrelated diagnostics
remain. All 13 moved request methods retain their protocol/error literals after
factoring common authorization and POST construction into transport.

`client.rs` shrank from 576 to 172 lines. The session model/error compatibility
reexports preserve existing imports; request method names and call sites remain
unchanged. The rebase guide now includes module-owned `impl Client` adapters,
shared transport helpers and removing port edits to `client.rs`.

Completion gates:

- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`: passed.
- `npm run typecheck:fast`: passed.
- ESLint on `scripts/next/surfaces/90-registration-probe.surface.ts`: passed.
- Rule check against the baseline: one touched TypeScript file, zero violations.
- `npm run test:classification:check`: passed; no test file was added or moved.
- `tests/next-surface-registration-real-path.test.ts`: one test passed.
- Full `npm test`: 1242 files passed, 3 skipped; 9056 tests passed, 5 skipped.

No release, version, deployment or publishing file changed.
