# Settings fixture verification

This partial Settings port is opt-in through the existing app shell. The shipped entry point and startup selection remain Tauri. The desktop presentation watcher also reconciles shared quiet-mode and notification changes. See [the full control parity table](parity.md) for every ported row and the missing desktop controls.

See [correction round 1](review-round-1.md) for the security, live-presentation, stale-edit regressions and verification after rebasing onto current main. The receipts below describe the initial implementation.

## Real entry points and red/green evidence

- `native/o8-next/src/settings_tests.rs`: shell palette -> GPUI mouse/text/keyboard -> existing authenticated HTTP routes -> persisted defaults/key stores. Covers all 41 form controls, environment locks, quiet-mode notification refusal, canceled drafts, key presence/save/remove/enable/check/refusals, clipboard/undo restrictions, errors/loading/empty results, lost-response recovery, and TOML save/reload/conflicts.
- `native/o8-next/src/shell_tests.rs`: Settings entry/close and the existing workspace, palette, Inbox and restart paths. Current-main shell suite: **9 passed**.
- `tests/next-settings-real-path.test.ts`: production middleware and handlers with disposable persisted state; unauthorized GET/POST/PATCH/DELETE, server validation, environment precedence, encrypted key writes/removal, and cross-client TOML conflicts.
- `tests/o8-next-shell-real-path.test.ts`: built CLI connection/auth boundaries, including the platform-native launcher probe. Combined HTTP/launcher suite: **9 passed**.

Before implementation, the six Settings GPUI tests failed because the real palette could not open Settings: **0 passed / 6 failed**. After implementation all six Settings cases pass inside the nine-case shell suite. Shared native form controls: **0 -> 41**; four provider key inventories and revision-checked TOML editing are also available. Raw excerpts: [red](red-tail.txt), [green native](green-tail.txt), [green HTTP/launcher](green-server-tail.txt).

The fixture uses the production operator-defaults and provider-key routes, middleware, validation and persistence. Only runtime subprocesses/profile discovery and external provider transport are replaced. Profile isolation happens before production imports. Roots and path assertions use canonical paths; no fixture reaches real accounts or a desktop instance. A stdout drain keeps production handler diagnostics from breaking the fixture pipe.

## Fixture measurements

Linux, Node 22, Rust stable, debug profile, GPUI TestAppContext with the test text system. Each run starts a fresh fixture and shell. Open time starts at Enter on the filtered Open settings command and ends after the loaded Settings revision reaches its CPU paint callback. Interaction time starts at the control action and ends after the corresponding server response and Settings revision reach that callback. The 41 samples per run cover 15 toggles, 12 choices and 14 editor saves. Test frame requests are included. These are CPU scene acknowledgements; macOS font shaping, GPU, compositor and display presentation were not measured.

| Run | Open to first frame (ms) | Interaction p50 (ms) | Interaction p95 (ms) | Writes measured |
| --- | --- | --- | --- | --- |
| 1 | 185.27 | 103.61 | 321.60 | 41 |
| 2 | 63.70 | 82.83 | 134.32 | 41 |
| 3 | 54.92 | 82.47 | 148.94 | 41 |

Before: no native Settings frame or interaction endpoint existed, so latency is **unavailable**, not zero. After: all three runs produced a loaded Settings frame and 41 acknowledged writes. The unmodified receipts are `run-1.json`, `run-2.json`, and `run-3.json`.

## Checks and remaining work

- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`: passed on the integrated main base.
- `npm run typecheck:fast`: passed before the focused commit and after resolving current-main shell integration.
- ESLint on the three touched TypeScript files: passed.
- `npm run rule-check -- --base=origin/main`: two eligible files, zero violations.
- `npm run test:classify`: 1229 hermetic / 879 resource-owning files; classification regenerated for the added test.
- Native dependency audit: **472 packages, zero GPL or excluded application crates**. No crates or dependencies were added.
- Full `npm test` was started once and interrupted after **383 files had reported passing**. There is no complete full-suite result.
- An earlier broad debug-native sweep reported **33 passed / 3 failed / 3 ignored**. The failed cases were the terminal flood, the worker first-transcript timing check, and the o8d saved-history check without its fixture binary. The o8d helper was then built with its existing `experimental-http` feature, staged through `O8D_HTTP_TEST_BINARY`, and its saved-history check passed. Both terminal and worker timing checks then passed in isolated reruns on the integrated main base. All three initial failures have green isolated reruns; the full native sweep was not repeated.

Complete desktop Settings parity remains open: native-only startup/appearance/voice/permissions, account and provider setup/routing details, usage details, worktree usage/actions, projects, GitHub auth, indexing, MCP, mobile/pairing, analytics, diagnostics/about and quick-drawer controls. Their exact controls are marked missing in the parity table. Several require existing desktop local-storage or Tauri APIs for which no server settings route currently exists. No substitute persistence route was introduced.

Use **Refs #4548**, not a closing keyword, until the missing controls and verification limits are resolved.
