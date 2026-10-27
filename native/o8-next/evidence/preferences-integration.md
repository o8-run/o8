# Preferences integration correction

Original preferences head: `435f5c2ec8efcc403c6dd9d29ab7ae43fbcbf378`.
Main baseline: `05dc85bc6` (contains the reported `44dddc51` baseline).
Keyboard integration head: `a28a9102e6d9e29149ff3fb61e84af56a43f6747`.

The preferences branch merges main cleanly. Adding the keyboard branch then
conflicts where the appearance predicate overlaps keyboard registration. The
unresolved tree reproduces the reported compiler failure:

```text
error: expected one of `!`, `(`, `+`, `::`, `<`, `>`, or `as`, found `.`
  --> src/shell_view.rs:53:13
error: could not compile `o8-next`
```

The material renderer now owns the All Glass predicate and returns an empty
element when that layer is disabled. The shell keeps its shared material call
site, so appearance selection and keyboard registration merge independently.
Palette selection, sidebar sizing, window bounds and the keyboard handlers are
preserved. No tests or CI jobs are added.

Both the preferences branch merged with main and a scratch copy combined with
the keyboard head pass:

```sh
cargo check --locked --manifest-path native/o8-next/Cargo.toml --all-targets
```

Native counts use the same command, toolchain, two test threads and prebuilt
daemon fixture on main and head. Each checkout owns its build directory:

```sh
cargo test --locked --manifest-path native/o8-next/Cargo.toml --no-fail-fast -- --test-threads=2
```

| Tree | Native unit passed | Failed | Ignored | Other integration passed |
| --- | ---: | ---: | ---: | ---: |
| Main `05dc85bc6` | 283 | 4 | 7 | 11 |
| Preferences head with main | 290 | 4 | 7 | 11 |

The failure sets are identical. This round adds zero native failures:

- `shell::issues::tests::issues_worker_receives_linked_context_through_stream`
- `shell::settings::tests1::settings_fixture_all_default_controls_persist_and_refresh`
- `shell::sidebar::tests::sidebar_worker_archive_real_path`
- `ui::tests::worker_tests::worker_send_steer_queue_promote_remove_and_streaming_latency`

The locked all-targets checks, fast type check, touched-file Rust formatting and
diff checks pass. The preferences branch retains seven passing native cases
beyond main. Native tests remain outside required CI; this round adds no CI job.

The required CI command also ran. Type Check, Lint, Test Classification, Server
Bundle Size, Security Audit and Governance Smoke pass. Hermetic tests report
9,644 passed, one failed and five skipped; the credential-store case cannot
create its lock directory in the process home under this runner's filesystem
policy. Preferences integration assertions pass eight of eight, but the gate
cannot confirm fixture-process teardown. These runner limits keep aggregate CI
red and are separate from the four unchanged native failures above.
