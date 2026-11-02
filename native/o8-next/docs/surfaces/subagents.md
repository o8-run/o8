# Subagent inspector

The native inspector extends the existing transcript traces with named agent
links. The trace's tools, branches, reasoning, disclosure and retained rows stay
in place. A launch tool returning successfully does not mark its worker done.

Open an agent from a trace, the workspace header, the right panel's Subagents
tool, or **Inspect agent** on a Workers card. Main chat and side chat keep their
own parent context. Grid follows the focused pane. Outside a conversation, the
inspector shows the selected workspace's recorded work. Opening, reading and
copying do not dispatch, resume, steer or approve a worker.

The index groups working agents, agents needing attention and finished agents.
Review, blocked, failed, queued, idle and held-result states remain explicit.
Search filters names, runtimes and statuses. Selecting a row opens its recorded
runtime, model, effort, progress and transcript. Back preserves the index scroll;
close returns to the parent. The parent conversation, draft and scroll remain in
place. Closing restores an existing panel's tools and split layout before returning
focus to its parent. At compact widths the inspector uses the panel's full-width mode.

Details reuse the native transcript merger, retained renderer and bounded image
loader. Live history uses the existing session subscription. Earlier messages
load through the same revision-bound history cursor, with a scoped retry on
failure. Copy uses the recorded result or the latest assistant text. Elapsed
times appear only when the server supplies run timestamps.

## Data and failure behavior

- Mission workers use `/api/orchestrator/state`, joined by recorded parent,
  workspace and original lane session key.
- Shared workers use `/api/orchestrator/shared-team/active` with the exact
  repository and parent thread. That route includes archived teams recorded for
  the parent. The workspace view includes its active Shared team. The native
  daemon registers the same GET handler when Next is stopped.
- The inspector preserves each source's last known data when that read fails and
  shows a local error. Unknown status remains unknown. A worker result held for
  parent delivery stays under Needs attention.
- Changing selection or the recorded run invalidates pending transcript reads.
  Media completion applies only to the current detail's cache. Grid navigation
  includes the focused inspector identity when choosing the parent.
- A delegation reference whose record is no longer supplied by these routes
  stays explicitly unavailable. The inspector does not invent a history binding
  for unreported runtime-internal agents.

## Verification

`shell_features/right_panel/subagents_tests.rs` drives the native controls through
the disposable `--subagents` host and production persisted mission, Shared-team,
history and media routes. It covers named trace links, preserved parent drafts
and original steps, grouped counts, copy, search, refresh recovery, earlier-history
retry, image loading, grid parent changes, compact fit and held Shared results.
The side-chat path also checks its split companion, unchanged draft and keyboard
return to the originating trace action.
Workers inspection checks keyboard return to the same card. A lower-split check
keeps detail in its existing slot and restores the tools that preceded inspection.
The grid path advances the original trace while inspection is open and checks
keyboard return to that trace after the retained row updates.
A production history read whose selection is cleared before completion also
proves that a late reply cannot restore the old transcript or images.
`tests/o8d-next-surfaces-real-path.test.ts` covers the Shared read through the
production native bridge with Next stopped.

The initial native regressions fail on the absent `header-subagents` and
`subagent-trace-subagent-calculation` controls. Final green receipts and live
visual acceptance are recorded with the pull request; source tests alone do not
establish installed-app acceptance.
