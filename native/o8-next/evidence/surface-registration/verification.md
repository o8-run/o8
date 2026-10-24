# Surface registration verification

Baseline: `f3f81af7faee9a96683ba46645517372e735ea37`, in a separate untouched checkout.
Linux, Node 22, Rust stable, owned fixture accounts and repositories only.

## Red before extraction

The new native test drove the real shell command palette before registration
existed. The new TypeScript test added a surface file and requested its route
through the real disposable host.

```text
assertion `left == right` failed
  left: []
 right: ["Open registration probe"]
test shell::tests::registration_probe::new_surface_routes_renders_and_gets_navigation ... FAILED
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 81 filtered out; finished in 11.00s
AssertionError: expected 404 to be 200 // Object.is equality
```

## Green after extraction

```text
test shell::fake::new_surface_routes_renders_and_gets_navigation ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 81 filtered out; finished in 5.55s
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

The fake module and one shell list entry supply its route, typed runtime slot,
persisted state slice, painted view, clickable nav and keyboard binding. Its test
also checks the existing workspace JSON keys and reloads the saved fake route.

## Existing behavior comparison

`cargo test --manifest-path native/o8-next/Cargo.toml` ran before and after.
The before run used `--test-threads=2`; the after run used `--test-threads=1` and
`--skip new_surface_routes_renders_and_gets_navigation` to compare the identical
original inventory. The additional regression ran separately as shown above.

Both runs: **85 passed, 0 failed, 3 ignored** (78 native unit tests and 7 CLI tests
passed). All **88 original function names and statuses match**. See
[test-names.txt](test-names.txt) and [comparison.json](comparison.json); the latter
maps all 48 changed module paths while retaining every function name.

The sidecar fixture was built with the existing test's required feature set:
`cargo build --locked --manifest-path crates/o8d/Cargo.toml --all-features`.
Initial attempts exposed a missing sidecar/feature set and intermittent existing
issues paint waits. The final comparison is green without changing those surfaces.

`cargo clippy --manifest-path native/o8-next/Cargo.toml --all-targets` exits zero,
with **0 diagnostics in touched native files**. Existing diagnostics elsewhere
remain outside this refactor.

## TypeScript and repository gates

- `tests/next-surface-registration-real-path.test.ts`: red 404, green route and
  authentication checks.
- The above plus `tests/o8-next-shell-real-path.test.ts`,
  `tests/next-settings-real-path.test.ts`, `tests/next-brain-real-path.test.ts`,
  `tests/next-diff-review-real-path.test.ts`, `tests/next-terminal-real-path.test.ts`
  and `tests/next-history-real-path.test.ts`: **7 files, 19 tests passed**.
- `tests/composer-next-worker-real-path.test.ts`: **1 passed** on untouched baseline
  and isolated rerun after an initial transient 400 in the broader run.
- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`,
  `npm run typecheck:fast`, touched-file ESLint, repository rule check and
  `npm run test:classify` / classification check pass.

Shared registration file edits for a future port: **6 to 1** (including README).
Shared `shell_tests.rs`: **466 to 210 lines**, with fixture helpers extracted and
surface-specific cases included by their own modules. No release, version,
deployment or publishing files changed.

Final full `npm test`:

```text
Test Files  1242 passed | 3 skipped (1245)
Tests       9053 passed | 5 skipped (9058)
```

The first full attempt had 9052 passes and one `spawnSync git ENOBUFS` failure:
Git enumerated the scratch dependency/build cache under `work/`. A local ignore
inside that scratch directory fixed the environment; the failing file then
passed all 16 tests and the complete suite passed on rerun. No release file was
changed.
