# Type and placement verification

Shell work: shared type/geometry tokens and tab geometry belong to the shell.
The existing session, composer and Brain modules own their surface changes.
No screen is ported. Extracting the changed sidebar renderer keeps ui.rs at 776
lines, below the 800-line limit, with one module registration.

red.txt records the two failing production-entry tests before the fix: no top-tab
geometry and no centred empty-conversation prompt. green.txt records all three
placement cases passing after the fix, including send/selection races.

The shared tokens follow the locked design roles and current desktop source:
13.5/300 row titles, 9.5/260 metadata, 12/300 chrome, 1.25 chrome line height,
26 px tabs with 7 px radius, 28 px rows with 8 px radius, 40 px headers, 4 px
outer insets, 8 px gaps, and the current composer's 720 px limit/18 px radius.
The theme contract parses the authoritative design table, desktop constants and
composer card source rather than comparing with another native copy.

| Authored property | Before | After |
| --- | ---: | ---: |
| Shell default weight | 400 | 300 |
| Shell chrome size | 13 | 12 |
| Native empty-history build prompts | 0 | 1 |
| Session-row height | automatic with metadata line | 28 px |
| Composer maximum width | uncapped | 720 px |
| Brain bottom-dock maximum height | 360 px | right slot instead |

layout.json records the real GPUI entry's compact/wide geometry. With Brain open,
the composer is 333 px wide at 900 x 700 and 720 px at 1680 x 1050; the right slot
is respectively 270 and 440 px wide. The empty state shares the composer's centre
and stays above it. Before/after values above describe authored geometry, not
native font or performance measurements.

Hostile-review cases:
- Compact macOS geometry: 900 x 700 and 1680 x 1050 checks keep the composer between
  the sidebar and right slot, with top tabs 26 px and sidebar rows 28 px high.
- Focus after resizing/closing the right panel: real text input appends to its
  retained Brain draft after resize; closing returns focus to the launching
  composer. Session changes preserve each Brain draft.
- Late send results after selection: the first session's durable queue receives
  the prompt while the newly selected empty conversation remains empty.

Native green groups: shell 2; session/composer 5; theme 3; Brain 3; editor 4.
The editor covers IME, UTF-16 selection, multiline paste and undo; Brain uses the
production shell palette and fixture routes. The placement/focus checks were
repeated after the final renderer extraction and layout changes.
JavaScript real-path suites: tests/o8-next-shell-real-path.test.ts,
tests/composer-next-worker-real-path.test.ts and tests/next-render-parity.test.ts:
3 files, 15 tests passed.

Node 22.23.4, Rust stable 1.99.1, locked dependencies. Cargo check, typecheck:fast,
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit, touched-file ESLint and
rule-check passed. ESLint has no Rust configuration; rule-check scanned the one
touched TypeScript fixture file. test:classify passed (1238 hermetic, 910
resource-owning) with no manifest change.

The batch's one full npm test run passed: 1242 files passed, 3 skipped; 9057 tests
passed, 5 skipped. npm-test.txt contains its summary. No full-suite rerun.

Remaining: actual rendered screenshots in glass/plain and macOS font/compositor
acceptance. Headless GPUI discards its scene; layout.json is not a screenshot.
Exact locked letter spacing cannot be applied through the pinned GPUI text API.
The separate glass and chrome PRs supply their own changes; this independent
branch starts from main and does not duplicate them.
