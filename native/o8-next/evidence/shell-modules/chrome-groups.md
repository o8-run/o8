# Cached chrome integration

Merged main at `39618b7d0981e503223eb8688575ed831ed22149`. Main's measured
`shell-chrome` boundary is retained. Module render slots name either `Chrome`
or `Content`; chrome slots compose inside `Shell::render_chrome`, and the
content slot retains the existing surface decorator fold. The material veil and
first-paint receipt keep their root order outside the cache. Startup readiness
still comes only from first paint; the Experimental gate is unchanged.

The real-input regression changes a registered slot's local state with a
keystroke, paints without forcing a refresh, and checks the updated slot and
chrome render count. The flat-slot merge fails with `0 -> 0`; the grouped merge
passes. See [red](chrome-groups-red.txt) and [green](chrome-groups-green.txt).
The loaded-shell typing benchmark and both fifteen-workspace tests are unchanged
and pass alongside both registry tests: **5 passed, 0 failed**.

Main's locked all-target check passes. Its complete native CI inventory, using
all four regular shards and their isolated timed probes, passes: **314 passed,
0 failed, 8 ignored**. No ignored test was enabled or disabled by the refactor.

## Full comparison

| Tree | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| Main at `39618b7d0` | 314 | 0 | 8 |
| Grouped module head | 316 | 0 | 8 |

Every main harness outcome is retained, including all eight ignored identities.
The only additions are the two passing registry tests. There are no failures
only on the head, no dropped tests and no new ignores. Both locked all-target
checks pass. The [comparison receipt](chrome-groups-comparison.json) records the
exact outcome differences.

The independent-module experiment still passes all six merge orders with one
identical resulting tree and its production-shell regression. A scratch tree
merging the updated archive and worker-action branches also merges cleanly,
passes its locked all-target check, and passes all **65** sidebar, worker,
registry, loaded-typing and fifteen-workspace tests. Those surfaces retain their
existing registrations through the surface-hooks and content modules; no shared
shell lists gain another entry.

`npm run typecheck:fast` passes. Local `npm run verify:ci` passes eight checks,
including the full native suite. Its sole failed check is the hermetic suite:
**9,752 passed, 1 failed, 5 skipped**. The unchanged credential-store fixture
cannot create its data directory outside writable workspace paths. Lint,
classification, changed integration checks, bundle size, governance, security
and full Type Check pass. Scoped Rust formatting and script syntax also pass.
