# Preserve replaced state files

Base: `76dc57b2839f42082b6205c543bfb74a949ae4ab` (#4704).

Corrupt, empty, oversized and incompatible state loads use defaults and mark the
input for preservation. Loading leaves it in place. On the first valid save,
encoding and temporary-file sync complete before the source moves to a unique
`state.json.bad-<time>-<process>-<suffix>` name. Existing backups are never
overwritten. A shared recovery marker prevents later saves or state clones from
moving another copy. A failed preservation blocks replacement.

Unreadable directory-backed and dangling inputs retain their existing no-write
behavior. The synchronous save path in #4902 is unchanged.

Tests were added before changing production code and run on the base:

```text
test shell::window_tests::corrupt_shell_state_is_preserved_before_autosave ... FAILED
test shell::window_tests::empty_shell_state_is_preserved_before_autosave ... FAILED
test shell::window_tests::future_shell_state_is_preserved_before_autosave ... FAILED
autosave must preserve the original state before replacing it
  left: 0
 right: 1
test result: FAILED. 0 passed; 3 failed
```

After the fix, the same three tests pass. They load actual files through the
production window factory, wait for successful-load autosave, check the original
bytes at the backup path, read valid live state at the original path, and close
the window to verify subsequent saves retain exactly that one backup.

```text
cargo test --locked --manifest-path native/o8-next/Cargo.toml shell::window_tests -- --test-threads=1
test result: ok. 8 passed; 0 failed

cargo test --locked --manifest-path native/o8-next/Cargo.toml --test shell_cli
test result: ok. 3 passed; 0 failed

cargo test --locked --manifest-path native/o8-next/Cargo.toml geometry::tests
test result: ok. 2 passed; 0 failed
```

The existing window tests cover restart geometry, surfaces, focus, unreadable
symlinks and offscreen placement. The CLI cases verify that loading alone does
not move the input if startup stops before opening a window. This proves normal
save recovery; power-loss durability is not established by these tests.
