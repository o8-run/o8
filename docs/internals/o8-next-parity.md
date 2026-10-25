# o8 next parity

The current desktop components under `src/` in All Glass mode are the layout
reference. The harness reads the shell registration inventory and requires one
mapping per production surface, excluding the test-only registration probe.
It renders the native shell and `/dashboard` at 1024×720 and 1440×900, with a
fresh production-route fixture host for each surface. Both clients read that
host; there is no alternate data implementation.

From the repository root, with the prerequisites in
[the shared Linux setup](../../.github/actions/next-linux-setup/action.yml):

```sh
cargo build --locked --manifest-path native/o8-next/Cargo.toml
cargo test --locked --manifest-path native/o8-next/Cargo.toml --bin o8-next --no-run
npx --no-install playwright-core install chromium
xvfb-run -a -s '-screen 0 1600x1200x24 -nolisten tcp -noreset -br' \
  node scripts/parity/next.mjs --output work/next-parity
node scripts/parity/checklist.mjs work/next-parity/report.json
```

Use `--browser /absolute/path` for an existing headless browser or `--only session`
to inspect a single surface. Set `VK_ICD_FILENAMES` to the installed software
Vulkan ICD, as the Linux workflow does. Use a private Xvfb display. The runner
never sends input to the active desktop. Native pixels come from an X11 window
owned by the launched child; current-UI pixels come from the actual Next route.
The browser uses a fresh storage context with the existing All Glass preferences.
Capture reads fixture APIs and permits only the existing terminal view-state save.
It refuses provider launches and other mutations. First-run choices are authored
in the disposable fixture through the existing defaults route, with sharing off.
The browser hides the development-tool overlay, which is outside the desktop UI.

Each capture directory contains `web.png`, `native.png` and `pair.png` (current
UI left, native right). `index.html` links the pairs. `report.json` contains
logical-pixel bounds, computed browser type and padding, colors, glass styles,
route statuses and signed metric differences. JSON null means unmeasured, never
zero. Missing controls and visual differences remain informational. A child
crash, timeout, failed route render or failed GPUI measurement test fails the job.
The PR workflow uploads only images and bounded reports; raw child diagnostics
stay in a local temporary directory printed by the runner.

## Measurement limits and remaining acceptance

This is partial parity coverage. GPUI's public test API exposes debug-selector
bounds, but does not expose all computed fonts, weights or paddings. These remain
null. Its test text system is different from the real Linux font renderer, so
the native bounds are a separate CPU-layout receipt, not pixel-derived metrics.
The browser records computed values for every located element. There are no
invented native token values in the report.

Surface openers, target pickers and missing selectors can leave a counterpart
unopened. The report records these cases and keeps their gaps unmeasured; a pair
alone does not establish equivalent selected data or a completed surface. The
session case targets the persisted rich history. Other surface interactions need
explicit ready selectors and matching selection assertions before acceptance is
complete. Grid worker selection, packet diff selection, terminal attachment,
files, and the native sidebar/rail/top-bar/transcript bounds need those probes.
The native terminal's pixels must be captured after attaching its selected
fixture PTY, not merely opening its target picker.

Linux exercises the native plain fallback. Browser All Glass has no desktop
wallpaper, and neither capture proves the system glass material on macOS.
No row is Done until both the matching state and all relevant measurements are
verified. Missing marks the unported rail/files elements; Partial includes
implemented elements whose geometry or selected state is not yet fully measured.
The table tracks the remaining look work under #4711 and surface ownership under
#4548. Regenerate it from an inspected report when updating measurements.

The checked-in [measurement snapshot](../../native/o8-next/evidence/parity/report.json)
contains 28 captures with zero crashes. Image paths inside it refer to the full
CI artifact layout. Representative pairs are saved at
[1024×720](../../native/o8-next/evidence/parity/session-1024x720.png) and
[1440×900](../../native/o8-next/evidence/parity/session-1440x900.png).

<!-- parity-table:start -->
| Surface | Element | Status | Owner | Measured gap (native − current UI, px) |
| --- | --- | --- | --- | --- |
| session | sidebar | Partial | [#4711](https://github.com/o8-run/o8/issues/4711) | 1024×720: unmeasured; 1440×900: unmeasured |
| session | rail | Missing | [#4711](https://github.com/o8-run/o8/issues/4711) | 1024×720: unmeasured; 1440×900: unmeasured |
| session | top bar | Partial | [#4711](https://github.com/o8-run/o8/issues/4711) | 1024×720: unmeasured; 1440×900: unmeasured |
| session | worker pane | Partial | [#4711](https://github.com/o8-run/o8/issues/4711) | 1024×720: unmeasured; 1440×900: unmeasured |
| session | transcript | Partial | [#4711](https://github.com/o8-run/o8/issues/4711) | 1024×720: unmeasured; 1440×900: unmeasured |
| session | composer | Partial | [#4711](https://github.com/o8-run/o8/issues/4711) | 1024×720: x +198, y -30.5, width -206, height -14; 1440×900: x -106, y -30.5, width +98, height -14 |
| session | palette | Partial | [#4711](https://github.com/o8-run/o8/issues/4711) | 1024×720: unmeasured; 1440×900: unmeasured |
| session | settings | Partial | [#4711](https://github.com/o8-run/o8/issues/4711) | 1024×720: unmeasured; 1440×900: unmeasured |
| session | files | Missing | [#4711](https://github.com/o8-run/o8/issues/4711) | 1024×720: unmeasured; 1440×900: unmeasured |
| session | diff | Partial | [#4711](https://github.com/o8-run/o8/issues/4711) | 1024×720: unmeasured; 1440×900: unmeasured |
| session | terminal | Partial | [#4711](https://github.com/o8-run/o8/issues/4711) | 1024×720: unmeasured; 1440×900: unmeasured |
| brain | sidebar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| brain | rail | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| brain | top bar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| brain | worker pane | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| brain | transcript | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| brain | composer | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| brain | palette | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| brain | settings | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| brain | files | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| brain | diff | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| brain | terminal | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| grid | sidebar | Partial | [#4530](https://github.com/o8-run/o8/issues/4530) | 1024×720: unmeasured; 1440×900: unmeasured |
| grid | rail | Missing | [#4530](https://github.com/o8-run/o8/issues/4530) | 1024×720: unmeasured; 1440×900: unmeasured |
| grid | top bar | Partial | [#4530](https://github.com/o8-run/o8/issues/4530) | 1024×720: unmeasured; 1440×900: unmeasured |
| grid | worker pane | Partial | [#4530](https://github.com/o8-run/o8/issues/4530) | 1024×720: x -64, y +115, width -444, height -404; 1440×900: x -368, y +115, width -348, height -494 |
| grid | transcript | Partial | [#4530](https://github.com/o8-run/o8/issues/4530) | 1024×720: unmeasured; 1440×900: unmeasured |
| grid | composer | Partial | [#4530](https://github.com/o8-run/o8/issues/4530) | 1024×720: unmeasured; 1440×900: unmeasured |
| grid | palette | Partial | [#4530](https://github.com/o8-run/o8/issues/4530) | 1024×720: unmeasured; 1440×900: unmeasured |
| grid | settings | Partial | [#4530](https://github.com/o8-run/o8/issues/4530) | 1024×720: unmeasured; 1440×900: unmeasured |
| grid | files | Missing | [#4530](https://github.com/o8-run/o8/issues/4530) | 1024×720: unmeasured; 1440×900: unmeasured |
| grid | diff | Partial | [#4530](https://github.com/o8-run/o8/issues/4530) | 1024×720: unmeasured; 1440×900: unmeasured |
| grid | terminal | Partial | [#4530](https://github.com/o8-run/o8/issues/4530) | 1024×720: unmeasured; 1440×900: unmeasured |
| activity | sidebar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| activity | rail | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| activity | top bar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| activity | worker pane | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| activity | transcript | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| activity | composer | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| activity | palette | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| activity | settings | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| activity | files | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| activity | diff | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| activity | terminal | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| pull_requests | sidebar | Partial | [#4652](https://github.com/o8-run/o8/issues/4652) | 1024×720: unmeasured; 1440×900: unmeasured |
| pull_requests | rail | Missing | [#4652](https://github.com/o8-run/o8/issues/4652) | 1024×720: unmeasured; 1440×900: unmeasured |
| pull_requests | top bar | Partial | [#4652](https://github.com/o8-run/o8/issues/4652) | 1024×720: unmeasured; 1440×900: unmeasured |
| pull_requests | worker pane | Partial | [#4652](https://github.com/o8-run/o8/issues/4652) | 1024×720: unmeasured; 1440×900: unmeasured |
| pull_requests | transcript | Partial | [#4652](https://github.com/o8-run/o8/issues/4652) | 1024×720: unmeasured; 1440×900: unmeasured |
| pull_requests | composer | Partial | [#4652](https://github.com/o8-run/o8/issues/4652) | 1024×720: unmeasured; 1440×900: unmeasured |
| pull_requests | palette | Partial | [#4652](https://github.com/o8-run/o8/issues/4652) | 1024×720: unmeasured; 1440×900: unmeasured |
| pull_requests | settings | Partial | [#4652](https://github.com/o8-run/o8/issues/4652) | 1024×720: unmeasured; 1440×900: unmeasured |
| pull_requests | files | Missing | [#4652](https://github.com/o8-run/o8/issues/4652) | 1024×720: unmeasured; 1440×900: unmeasured |
| pull_requests | diff | Partial | [#4652](https://github.com/o8-run/o8/issues/4652) | 1024×720: unmeasured; 1440×900: unmeasured |
| pull_requests | terminal | Partial | [#4652](https://github.com/o8-run/o8/issues/4652) | 1024×720: unmeasured; 1440×900: unmeasured |
| inbox | sidebar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| inbox | rail | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| inbox | top bar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| inbox | worker pane | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| inbox | transcript | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| inbox | composer | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| inbox | palette | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| inbox | settings | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| inbox | files | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| inbox | diff | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| inbox | terminal | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| issues | sidebar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| issues | rail | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| issues | top bar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| issues | worker pane | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| issues | transcript | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| issues | composer | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: x -85, y -156.19, width +110, height -14; 1440×900: x -445, y -291.19, width +526, height -14 |
| issues | palette | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| issues | settings | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| issues | files | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| issues | diff | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| issues | terminal | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| diff | sidebar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| diff | rail | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| diff | top bar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| diff | worker pane | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| diff | transcript | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| diff | composer | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: x +170, y +145.81, width -150, height -14; 1440×900: unmeasured |
| diff | palette | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| diff | settings | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| diff | files | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| diff | diff | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| diff | terminal | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| terminal | sidebar | Partial | [#4487](https://github.com/o8-run/o8/issues/4487) | 1024×720: unmeasured; 1440×900: unmeasured |
| terminal | rail | Missing | [#4487](https://github.com/o8-run/o8/issues/4487) | 1024×720: unmeasured; 1440×900: unmeasured |
| terminal | top bar | Partial | [#4487](https://github.com/o8-run/o8/issues/4487) | 1024×720: unmeasured; 1440×900: unmeasured |
| terminal | worker pane | Partial | [#4487](https://github.com/o8-run/o8/issues/4487) | 1024×720: unmeasured; 1440×900: unmeasured |
| terminal | transcript | Partial | [#4487](https://github.com/o8-run/o8/issues/4487) | 1024×720: unmeasured; 1440×900: unmeasured |
| terminal | composer | Partial | [#4487](https://github.com/o8-run/o8/issues/4487) | 1024×720: unmeasured; 1440×900: unmeasured |
| terminal | palette | Partial | [#4487](https://github.com/o8-run/o8/issues/4487) | 1024×720: unmeasured; 1440×900: unmeasured |
| terminal | settings | Partial | [#4487](https://github.com/o8-run/o8/issues/4487) | 1024×720: unmeasured; 1440×900: unmeasured |
| terminal | files | Missing | [#4487](https://github.com/o8-run/o8/issues/4487) | 1024×720: unmeasured; 1440×900: unmeasured |
| terminal | diff | Partial | [#4487](https://github.com/o8-run/o8/issues/4487) | 1024×720: unmeasured; 1440×900: unmeasured |
| terminal | terminal | Partial | [#4487](https://github.com/o8-run/o8/issues/4487) | 1024×720: unmeasured; 1440×900: unmeasured |
| settings | sidebar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| settings | rail | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| settings | top bar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| settings | worker pane | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| settings | transcript | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| settings | composer | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| settings | palette | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| settings | settings | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: x -60, y +119, width +64, height -116; 1440×900: x -60, y +119, width +64, height -116 |
| settings | files | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| settings | diff | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| settings | terminal | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| projects | sidebar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| projects | rail | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| projects | top bar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| projects | worker pane | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| projects | transcript | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| projects | composer | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| projects | palette | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| projects | settings | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| projects | files | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| projects | diff | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| projects | terminal | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| customize | sidebar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| customize | rail | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| customize | top bar | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| customize | worker pane | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| customize | transcript | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| customize | composer | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| customize | palette | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| customize | settings | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| customize | files | Missing | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| customize | diff | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| customize | terminal | Partial | [#4548](https://github.com/o8-run/o8/issues/4548) | 1024×720: unmeasured; 1440×900: unmeasured |
| setup | sidebar | Partial | [#4660](https://github.com/o8-run/o8/issues/4660) | 1024×720: unmeasured; 1440×900: unmeasured |
| setup | rail | Missing | [#4660](https://github.com/o8-run/o8/issues/4660) | 1024×720: unmeasured; 1440×900: unmeasured |
| setup | top bar | Partial | [#4660](https://github.com/o8-run/o8/issues/4660) | 1024×720: unmeasured; 1440×900: unmeasured |
| setup | worker pane | Partial | [#4660](https://github.com/o8-run/o8/issues/4660) | 1024×720: unmeasured; 1440×900: unmeasured |
| setup | transcript | Partial | [#4660](https://github.com/o8-run/o8/issues/4660) | 1024×720: unmeasured; 1440×900: unmeasured |
| setup | composer | Partial | [#4660](https://github.com/o8-run/o8/issues/4660) | 1024×720: unmeasured; 1440×900: unmeasured |
| setup | palette | Partial | [#4660](https://github.com/o8-run/o8/issues/4660) | 1024×720: unmeasured; 1440×900: unmeasured |
| setup | settings | Partial | [#4660](https://github.com/o8-run/o8/issues/4660) | 1024×720: unmeasured; 1440×900: unmeasured |
| setup | files | Missing | [#4660](https://github.com/o8-run/o8/issues/4660) | 1024×720: unmeasured; 1440×900: unmeasured |
| setup | diff | Partial | [#4660](https://github.com/o8-run/o8/issues/4660) | 1024×720: unmeasured; 1440×900: unmeasured |
| setup | terminal | Partial | [#4660](https://github.com/o8-run/o8/issues/4660) | 1024×720: unmeasured; 1440×900: unmeasured |
| palette | sidebar | Partial | [#4702](https://github.com/o8-run/o8/issues/4702) | 1024×720: unmeasured; 1440×900: unmeasured |
| palette | rail | Missing | [#4702](https://github.com/o8-run/o8/issues/4702) | 1024×720: unmeasured; 1440×900: unmeasured |
| palette | top bar | Partial | [#4702](https://github.com/o8-run/o8/issues/4702) | 1024×720: unmeasured; 1440×900: unmeasured |
| palette | worker pane | Partial | [#4702](https://github.com/o8-run/o8/issues/4702) | 1024×720: unmeasured; 1440×900: unmeasured |
| palette | transcript | Partial | [#4702](https://github.com/o8-run/o8/issues/4702) | 1024×720: unmeasured; 1440×900: unmeasured |
| palette | composer | Partial | [#4702](https://github.com/o8-run/o8/issues/4702) | 1024×720: x +170, y +146.31, width -150, height -14; 1440×900: x -190, y +236.31, width +266, height -14 |
| palette | palette | Partial | [#4702](https://github.com/o8-run/o8/issues/4702) | 1024×720: x -192, y -0.39, width +384, height +78.12; 1440×900: x -400, y -22, width +800, height +78.12 |
| palette | settings | Partial | [#4702](https://github.com/o8-run/o8/issues/4702) | 1024×720: unmeasured; 1440×900: unmeasured |
| palette | files | Missing | [#4702](https://github.com/o8-run/o8/issues/4702) | 1024×720: unmeasured; 1440×900: unmeasured |
| palette | diff | Partial | [#4702](https://github.com/o8-run/o8/issues/4702) | 1024×720: unmeasured; 1440×900: unmeasured |
| palette | terminal | Partial | [#4702](https://github.com/o8-run/o8/issues/4702) | 1024×720: unmeasured; 1440×900: unmeasured |
<!-- parity-table:end -->
