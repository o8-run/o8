# Sidebar width correction

Base: `c2d6ec41f037b8baf7734d0a4b7f5c7a146e24b0`.

Four new regressions ran before the production change, through startup
preferences, real project routes, native row selection and rendered bounds:

```text
launch_preferences_sidebar_minimum_width_fits_controls ... FAILED
launch_preferences_sidebar_intermediate_width_fills_column ... FAILED
launch_preferences_sidebar_maximum_width_fits_controls ... FAILED
sidebar content width: 280px; expected: 160px / 384px / 500px
launch_preferences_sidebar_width_is_clamped_at_the_layout_boundary ... FAILED
requested: 159; actual: 159; expected: 160
test result: FAILED. 0 passed; 4 failed
```

The list now fills the selected column. Startup layout clamps widths to
160–500 px. Repository chips use the actual available width; footer actions wrap
and stay inside the column. Palette, typography and existing control insets are
preserved.

```text
cargo test -p o8-next launch_preferences
test result: ok. 7 passed; 0 failed
```

The new cases cover 160, 384 and 500 px at compact/light and wide/dark window
sizes. They require the registered repository chip and check every present
header, search, list, rename, archive and repository control against its column's
bounds. Existing startup typing, collapsed-sidebar input and invalid-snapshot
fallback cases also pass.

Additional verification:

- Launcher/preferences, shell and webview command tests: 23 passed.
- Fast typecheck, full typecheck, touched Rust formatting and diff checks passed.
- The broad sidebar run had 45 passes and two failures. The 2,000-thread
  measurement observed an empty initial snapshot during competing workloads;
  it passed alone on both the unchanged parent and final head. The worker
  archive case also fails on the unchanged parent at the same readiness
  assertion; that separate fixture failure is not repaired here.
- The full hermetic gate was not green on this host: 9,572 passed, one failed,
  five skipped. The unchanged `credential-store.linux.test.ts` could not create
  its default lock directory under the protected home. No credential-store
  changes or permission changes are included.

The requested layout regressions pass. The unrelated gate failures remain
reported above; no desktop presentation timing is claimed.
