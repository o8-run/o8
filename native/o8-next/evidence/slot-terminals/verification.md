# Grid slot terminal verification

The server and keyboard regressions were run before their fixes. The unchanged
red output is retained in [red-server.txt](red-server.txt) and
[red-rust.txt](red-rust.txt). Tests cross the production fixture HTTP handlers,
production WebSocket server, real fixture PTYs and the GPUI root.

The fixture follows the README dev-server pattern. No accounts, operator
application state or visible windows are used. The shipped Tauri app is unchanged.

## Regression receipts

The first server run found zero terminal-bound fixture workers. The first native
run loaded the real grid, dispatched Ctrl+Alt+T and inspected its persisted layout:

```text
six runtime workers must expose exact terminal bindings: expected [] to have a length of 6
Test Files 1 failed (1); Tests 1 failed (1)
assertion `left == right` failed: Ctrl+Alt+T must persist the focused slot's terminal choice
  left: Null
 right: "terminal"
test result: FAILED. 0 passed; 1 failed
```

After the fix, the corresponding server and native regressions pass. The larger
GPUI test also drives three exact runtime bindings, focused input and Tab routing,
reorder, unavailable bindings, view switching, zoom, clipping, attachment identity,
continued hidden output, workspace persistence, restart and old-file defaults.
Terminal glyph shaping occurs within the counted paint callback, so unchanged
paint counts prove that hidden/clipped terminal glyphs are not shaped either.

Tests:

- `tests/o8-next-grid-terminal-real-path.test.ts`
- `tests/o8-next-pane-grid-real-path.test.ts`
- `tests/next-terminal-real-path.test.ts`
- `tests/next-render-parity.test.ts`
- `tests/next-stream-parity.test.ts`
- `native/o8-next/src/pane_grid_tests.rs`
- `native/o8-next/src/grid_terminal_tests.rs`
- `native/o8-next/src/terminal_tests.rs`
- `native/o8-next/tests/pane_grid_cli.rs`
- `native/o8-next/tests/terminal_cli.rs`

| Mechanic | Before | After |
| --- | ---: | ---: |
| Slot view choices | 1 (transcript) | 2 (transcript / terminal) |
| Persisted per-slot terminal choices | 0 | 6 |
| Runtime fixture workers with exact terminal bindings | 0 | 6 |
| New server regression | 1 failing | 1 passing |
| New keyboard/persistence regression | 1 failing | 1 passing |

## Measurement method

Run the ignored workload explicitly, in a fresh optimized process for each run:

```sh
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml grid_terminal_measurement -- --ignored --nocapture
```

The real `Grid` root loads six slots through the HTTP fixture host. Three display
persisted 100-row transcripts; three switch to distinct runtime PTYs through the
same `terminal::Pane` and terminal transport as standalone terminal mode. GPUI
TestAppContext uses a no-op text system and CPU scenes. It does not measure native
font shaping, GPU work, compositor presentation or physical input.

Idle RSS is the native test process after all three terminal replay barriers and
all six initial views are painted, before flood commands. The fixture HTTP/WS
processes and six Python PTYs are excluded. Thirty focused key samples start
before GPUI text input and Enter dispatch, and end only after new PTY echo bytes
reach the focused terminal's paint acknowledgement. These include socket, server,
PTY, polling and scene work.

Each of the three visible PTYs then runs the fixture's 2.5 MB/s flood producer.
Each of 60 timed scenes must acknowledge advancing bytes from all three terminals.
Frame timers include notification polling, transcript merging if any, and the
forced CPU scene draw; socket reading and ANSI parsing occur on transport threads.
The other three transcripts remain visible and quiet during this workload.
This measures a live flood interval, not delivery of the entire 50 MB producer.
Percentiles use the sorted nearest-rank sample at `ceil(0.95 * count) - 1`.
There is no comparable six-slot terminal baseline on main and no speedup claim.

## Measurement results

Three sequential optimized runs at 1920 x 1080, each with six slots, three
flooding terminals, 60 frame samples and 30 focused echoed-input samples:

| Run | Frame p95 (ms) | Idle native RSS (MiB) | Focused key to PTY echo to scene p95 (ms) |
| --- | ---: | ---: | ---: |
| [1](run-1.json) | 56.690 | 21.078 | 40.813 |
| [2](run-2.json) | 52.956 | 20.742 | 41.900 |
| [3](run-3.json) | 31.302 | 20.980 | 39.922 |
| Median | 52.956 | 20.980 | 40.813 |

Frame p95 exceeds a 16.7 ms frame budget; focused echoed-input p95 remains above
the terminal work's 8 ms target. These targets remain unmet. Idle native RSS is
below the existing 500 MiB terminal memory limit. The raw arrays and advancing
byte counters are preserved in each JSON receipt. No comparable before-timing
exists because main has no slot terminal rendering.

## Completion checks

The touched JavaScript suites pass serially after the rebase:

```text
Test Files  5 passed (5)
     Tests  14 passed (14)
Rust release: test result: ok. 19 passed; 0 failed; 3 ignored
Grid CLI: test result: ok. 3 passed; 0 failed
Terminal CLI: test result: ok. 1 passed; 0 failed
Explicit measurement workload, each of three runs: 1 passed; 0 failed
npm test: Test Files 1222 passed | 3 skipped (1225)
               Tests 8675 passed | 4 skipped (8679)
```

The clean full npm gate finished in 728.68 seconds. Its summary and the native
and touched-suite green tails are retained in [green.txt](green.txt).

`NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`, touched-file ESLint,
the changed-file rule checker, classification and Rust formatting pass. One
standalone-terminal fixture startup missed its deadline during concurrent gates;
the complete serial touched-suite rerun above passed without changing a timeout.

An initial full npm gate collided with a baseline probe through a shared Vitest
transform cache, causing missing-cache errors. The baseline probe was rerun with
filesystem module caching disabled, and the full gate was rerun alone. The
earlier account-identity assertion failure also reproduced in an isolated probe
on the unmodified base `8bb34ead4`:

```text
tests/desktop-account-identity.test.ts:70
AssertionError: expected [] to have a length of 1 but got +0
Test Files 1 failed (1)
Tests 1 failed | 3 passed (4)
```

No account-identity implementation or test was changed by this follow-up. All
four account-identity tests pass in the clean final full npm run above.

## Dependencies and remaining acceptance

The crate's existing license audit passed for Linux (465 packages) and macOS
(448 packages): zero GPL or excluded application crates. `gpui` 0.2.2 and
`alacritty_terminal` 0.26.0 declare Apache-2.0. The graph also contains permissive
and MPL-2.0 dependencies. No Zed editor, terminal, terminal_view or markdown
application crate is used.

PR #4540 landed during this work; the branch was rebased onto that main revision.
The terminal foundation from the still-open PR #4502 uses the same module names,
parser and protocol here, extended for embedded focus and silent hidden polling.
The separate diff surface is untouched. Concurrent startup/fixture/classification
changes from the other open branches require normal integration conflict
resolution; the merge simulations identified those shared seams.
The final read-only merge simulation is clean against main `5c6a3600a`; its
native/o8-next files match the tested base.

Remaining acceptance: native-font/GPU/compositor measurements, physical input
timing and unattended on-screen visual acceptance. These are not established by
headless CPU scene measurements, so this follow-up references rather than closes
#4530. The measured frame and echoed-input latency targets also remain unmet.
