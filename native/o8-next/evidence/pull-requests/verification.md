# Native pull request verification

Authored fixture verification on Linux, Node 22 and Rust stable. The native code
uses published Apache-2.0 GPUI and existing dependencies; no dependency manifests
or lockfiles changed. The normal/build license audit covered 472 packages and
found zero GPL packages or excluded application crates.

## Red before green

The initial regression drove the existing shell and command palette before the
PR surface was wired in. Its retained tail was:

```text
shell::tests::shell_pull_requests_opens_from_palette
assertion `left == right` failed: the shell command palette must expose the repository pull request surface
  left: 0
 right: 1
test result: FAILED. 0 passed; 1 failed
```

Independent review then identified repository retargeting, loss of structured
preview refusals and an ambiguous packet/GitHub merge boundary. Real-entry-point
regressions were added and failed before those corrections:

```text
pull_requests_repository_change_invalidates_old_detail
a changed list repository must invalidate the previous detail
test result: FAILED. 0 passed; 1 failed

pull_requests_structured_preview_refusal_and_rebase
structured preview refusal must retain gate details
test result: FAILED. 0 passed; 1 failed

pull_requests_linked_packet_preview_refuses_merge
a passing preview cannot bypass the governed packet merge path
test result: FAILED. 0 passed; 1 failed
```

The final focused native tail is:

```text
test result: ok. 8 passed; 0 failed; 0 ignored; 33 filtered out
```

These eight tests are in `src/pull_request_tests.rs` and `src/shell_tests.rs`.
They click GPUI controls, type through the shared composer, use an owned fixture
HTTP server, and inspect production-route responses and server-side action
receipts. They cover all eleven implemented PR write actions, all three merge
methods on unlinked PRs, unsupported method/draft/stale-head refusals, partial
close without duplicate comments, uncertain delivery across navigation,
repository identity changes, loading/error/retry/unavailable/empty states,
pagination, filters, clipboard/navigation controls, and preview refusal display.
The deliberately passing linked-preview case is a client contract fixture,
not evidence of a successful governed merge.

The TypeScript fixture starts red without its route host, then passes:

```text
tests/next-pull-requests-real-path.test.ts
Test Files  1 passed (1)
     Tests  1 passed (1)
```

It checks the real list and detail handlers, production operator middleware,
unauthenticated POST refusal, and a comment visible on a subsequent detail read.
The existing desktop and merge-gate checks also passed:

```text
Test Files  4 passed (4)
     Tests  26 passed (26)
```

Files: `tests/next-pull-requests-real-path.test.ts`,
`tests/merge-preview-all-gates-real-path.test.ts`,
`src/components/desktop/pr-panel/PrPanelActions.test.ts`, and
`src/components/desktop/pr-panel/PrDeliveryState.test.ts`.

## Counts and timings

| Observation | Before | After |
| --- | --- | --- |
| Shell palette matches for “pull” | 0 | 1 |
| Native PR write actions | 0 | 11 |
| Fixture PR rows after loading both pages | No native list | 4 |
| Focused native regression result | 0 passed, 1 failed | 8 passed, 0 failed |
| Test classification | 1,229 hermetic / 877 resource-owning | 1,229 hermetic / 878 resource-owning |
| PR open to first loaded-list paint | Unavailable | 23.33 ms |
| Detail selection to loaded-detail paint | Unavailable | 29.40 ms |
| Tab interaction to paint, 20 samples | Unavailable | median 13.26 ms; p95 13.84 ms; max 15.31 ms |

Raw values are in [timing.json](timing.json). The debug-profile timer ends in
the GPUI canvas paint callback. Linux TestAppContext has no native font shaping,
GPU, compositor or physical presentation. No display latency target is claimed.

## Completion gates and remaining acceptance

- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`: passed.
- `npm run typecheck:fast`: passed through its Linux tsc fallback.
- ESLint on both touched TypeScript files: passed.
- `npm run rule-check -- --base=origin/main`: passed; one applicable TypeScript
  source file, zero violations. Rust files also pass `rustfmt --check` and remain
  below the 800-line ceiling.
- `npm run test:classify`: passed; the new process-owning test is classified.
- Final full native run: 38 unit/headless tests passed, three explicit benchmarks
  ignored, and all seven CLI integration tests passed. The existing o8d test used
  its supported `O8D_HTTP_TEST_BINARY` override with a locally built fixture
  binary; no installed application was used.
- Full `npm test`, run once: 1,232 files passed, one failed, three skipped;
  8,895 tests passed, one failed, five skipped. The failure was `spawnSync git
  ENOBUFS` in `tests/release-artifacts.test.ts`, because Git enumerated the local
  untracked Rust toolchain in `work/`. Excluding that scratch directory in local
  Git metadata resolved it; the affected file passed all 15 tests on rerun.
  No release file was modified.

This is a partial parity slice. Packet-linked merging and enabling auto-merge
remain unavailable. Full native per-gate mutation coverage, independent red
receipts for every desktop action, desktop keyboard behavior, saved per-PR
draft/view state, and the controls marked partial/missing in the
[parity table](../../PULL-REQUESTS.md) remain open. macOS and real display
measurements were not available in this environment. The installed app changes
only when the user explicitly opts in to o8 next.
