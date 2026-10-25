# Workspace chrome verification

Shell work: the wrapping workspace list, shared command palette and embedded
session header are owned by the shell. No new surface is registered or ported.
The session renderer/composer changes stay in their existing modules.

Test-first receipts are in red.txt, red-labels.txt and red-focus.txt. The first
shell run failed with 15 fixture workspaces because it had no single switcher.
The transcript run exposed the Operator label. The hostile review then exposed
Refresh recording palette focus instead of restoring the composer; the retained
draft test failed before the refresh order was corrected.

Green receipts: green.txt and green-session.txt. Four shell tests and four
session/composer tests pass. The existing fixture routes own all data; no account
or desktop application is used. The three hostile-review cases are compact/wide
geometry with 15 workspaces, platform-shortcut cancellation and Refresh restoring
composer focus, and switching before an outstanding inventory response applies.
The existing restart/offline test still covers persisted selection and Retry.

| Measurement | Before | After |
| --- | ---: | ---: |
| Permanent workspace controls with 15 workspaces | 15 | 1 |
| Embedded session header rows | 1 | 0 |
| Permanent shortcut hint lines | 2 | 0 |
| Role/activity secondary labels changed here | 3 | 0 |

layout.json records production GPUI layout at 900 x 700 and 1680 x 1050. The
switcher is 106 x 33 in each. This is a layout receipt, not a rendered screenshot:
the pinned GPUI TestWindow discards its scene and the test text system does not
shape native fonts. Raster screenshots in glass/plain and macOS compositor
acceptance remain unmet. All Glass is separate work in this batch.

Node 22.23.4, Rust stable 1.99.1, locked native dependencies. The workspace needed
local linker names for already-installed X11 libraries. Typecheck:fast and
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit passed. ESLint passed on
the two touched TypeScript files; its configuration ignores Rust files.
Rule-check passed on both TypeScript files against origin/main. test:classify
passed (1238 hermetic, 910 resource-owning); no manifest change was needed.

JavaScript real-path suites passed: tests/o8-next-shell-real-path.test.ts,
tests/composer-next-worker-real-path.test.ts, tests/next-render-parity.test.ts
(3 files, 15 tests). The full npm test receipt will be recorded at the end of the
three-item batch.
