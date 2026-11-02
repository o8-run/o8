# Shell server link: fix round 1

Starting head: `aad82e95d`. Merged main: `238dc0e23`.
Native and TypeScript verification below uses the repaired code at `61a1472cb`
with locked npm dependencies installed using the declared npm 11.21.1.
Hosted CI, including the Linux native shards, remains the final gate.

## Mechanic and repair

- Maintenance set `loading` before the sidebar installed its catalog, so a
  healthy refresh was treated as bootstrap and replaced a valid cross-project
  selection. Track the first successful catalog separately from request state.
  Later loads retain any selected workspace still present in the catalog;
  a missing workspace falls back to the server-active project.
- Recovery could create a new session surface behind the shortcut dialog. Its
  constructor took focus from the current dialog control. The shortcut
  registration now blocks hidden surface creation until dismissal. The test
  waits for connection recovery with the dialog open, then requires history
  CPU scene paint after dismissal, when the history is visible.
- The legacy shortcut test checked absence from GPUI's historical debug-bounds
  map. On the failing run, live shortcut state was already false while the old
  selector still existed. Check live state and an increase in actual chrome
  render count after Escape instead.
- The deferred-save test's five-second assertion fired after both shell and
  sidebar had finished loading. It now asserts immediately that the declined
  refresh is queued or in flight, then awaits the full catalog with the existing
  production request budget used by the other connection tests. The reconnect
  deadline and production request timeouts are unchanged.

Credential, token-file and bearer handling are unchanged in this round.

## Red evidence

On `aad82e95d` plus the new regression and diagnostic assertions, the connection
group reported **6 passed, 4 failed**:

```text
maintenance_keeps_a_workspace_outside_the_active_project:
maintenance must preserve a valid workspace outside the server-active project
left: project-one; right: project-two

shell_recovers_from_down_and_restart_without_reopening:
selected fixture history must reach CPU scene paint through the existing surface
connected=true, loading=false, active=Session("thoughts-long")

reconnect_preserves_main_palette_recovery_and_shortcut_commands:
live shortcut state=false; old debug selector still present
assertion failed: cx.debug_bounds("shortcut-reference").is_none()

shell_connection_checks_are_single_flight_and_keep_current_view:
refresh deferred by a failed save must settle
```

After moving the history paint assertion to the visible phase, the restart test
exposed the real focus regression: the focused control changed during recovery.
Blocking hidden surface creation made the same focus and paint assertions pass.

A separate loaded diagnostic reproduced the five-second deferred-save failure
with `shell loading=false`, sidebar `loading=false`, `saving=false`, `dirty=false`.

## Final local verification

Debug builds only, Node 22, Cargo under `nice -n 10` with `-j 4`,
`CARGO_PROFILE_DEV_DEBUG=0` and `CARGO_INCREMENTAL=0`:

- Full connection group: **10/10 passed in each of three consecutive runs**,
  30 passed total, 0 failed, 0 ignored. This repeats all four originally failing
  tests three times.
- Exact retained-draft reconnect test: **3/3 additional passes**, 0 failed.
- Startup group: **5 passed, 0 failed, 1 ignored**. The ignored child probe runs
  and is asserted through its parent tests.
- `npm run typecheck:fast`: passed.
- `cargo check --locked --all-targets`: passed.
- The additional full npm unit gate could not collect tests under the requested
  home-directory `TMPDIR`: `tests/global-test-data-dir.ts` rejects that parent
  as outside a real temporary root. This is not a green npm suite receipt.

Initial npm attempts also found that the cloned dependency tree had Vitest
4.1.11 while the branch locks and patches 4.1.12. Installing the locked
dependencies replaced that tree before final native and TypeScript validation.
The default npm invocation then failed in experimental disk-cache error
reporting (`code.charCodeAt is not a function`). Repeating with only
`--experimental.fsModuleCache=false` exposed the temporary-root guard described
above. Test selection, repository configuration and the requested temporary
directory were not changed. Hosted CI remains the final gate.

Regression: [maintenance refresh](../../src/shell_features/connection/refresh_tests.rs).
Recovery, focus, dismissal and deferred-save assertions:
[connection tests](../../src/shell_features/connection/tests.rs).
