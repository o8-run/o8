## Mechanic

The app-shell launcher reads a bounded startup snapshot from the selected profile's running webview. The native shell opens with its palette, glass mode, sidebar width/visibility and logical window size. It adds no screen or helper text.

## What changed

The existing authenticated webview transport uses only `get_app_info`, `list_windows`, and six named `manage_local_storage` reads with `action: get`. It never asks for all storage, evaluates supplied code, or writes preferences. Two reads of each preference must agree. A 1500 ms deadline permanently cancels this client, including reconnection. Missing, stalled or inconsistent peers retain native defaults and saved bounds.

Inherited preference payloads are removed. Workers, spectators and explicit foreign origins never read the desktop. An environment-selected API port requires an explicit bridge selector; explicit data-directory profiles retain the existing no-fallback rule. The explicit socket selector is trusted configuration: the existing protocol has no HTTP-origin binding.

Shell work: shared appearance tokens, window material and the existing session sidebar consume the startup snapshot. macOS can use native blur; other platforms retain the same solid fallback as the current app. All Glass selects the dark material without changing the user's saved choices. The snapshot is not saved into native state; the existing native window-bounds persistence remains in use.

## Verification

- Test first: `tests/next-preferences-real-path.test.ts`, 2 failed / 2 passed before implementation. The native real-window test failed at 1200 px versus the requested 900 px. The timeout regression separately failed because disposal retried a request.
- Final focused JS checks: 23 passed across `next-preferences-real-path.test.ts`, `o8-next-shell-real-path.test.ts`, and `src/lib/mcp/o8-webview-commands.test.ts`; existing client tests: 17 passed.
- Native real-window checks: `preferences_tests.rs`, 3 passed. Palette changes dark → light, sidebar width 250 → 384 px, collapse yields 0 px, and window size changes 1200 × 816 → 900 × 700. Composer input survives startup and collapse; invalid snapshots preserve saved bounds. Existing theme checks: 2 passed; shell palette/switch/restart/server-down check: 1 passed.
- Hostile review covers macOS physical-to-logical scale conversion and canonical temporary paths, focus/input after applying the layout, torn reads during theme changes and permanent timeout cancellation. The env-port fixture uses a synthetic default socket and fake profile, so a regression cannot reach an installed account. Independent review found no remaining concrete blockers after those fixes.
- Passed: fast typecheck, heap-bounded root `tsc --noEmit`, touched-file ESLint, rule-check and test classification. Full `npm test` at the end: 1242 files / 9057 tests passed; 3 files / 5 tests skipped.
- Additional CLI-project typecheck reports TS18047 in unchanged `cli/src/commands/conversation-prs.ts:31`. The same error was reproduced on an isolated untouched main checkout. That file is outside this change.

This is a startup snapshot for the existing app-shell surfaces. Desktop tile arrangements and right-panel layouts have no matching native surfaces and remain unmapped; standalone launches without the app shell retain their existing configuration. macOS native material appearance is covered by conditional test expectations but has not been visually verified in this Linux environment. These limits keep #4713 open.
