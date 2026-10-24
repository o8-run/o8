# GitHub read and refresh inventory

This is the UI read inventory for #3460. Repository slugs are case-insensitive. Display-name
lookups also include the checkout path; an omitted repository uses a separate default key.
The desktop operator and each mobile credential epoch have separate QueryClients. Credentials
never appear in cache keys. Local Git commands and authenticated writes are not GitHub list reads.

## Shared policy

- Repository issue/PR/CI/commit lists: fresh 120 seconds; observed lists poll every 120 seconds
  visible, 300 seconds hidden. Visibility changes reschedule observers. No per-badge item read.
- PR checks: 30 seconds only while the selected checks view is visible and the PR is open.
  The compact panel uses 120 seconds for ordinary open detail. Terminal details remain fresh
  for the lifetime of the retained entry and have no polling. Item hovers have no polling.
- Explicit refresh cancels the older read, uses the same cache key, bypasses route TTLs with
  `fresh=1`, and is allowed to reach the server during an automatic hold. The server's actual
  quota refusal remains authoritative. Broker list sync gives explicit reads interactive
  priority; background sync cannot spend the interactive reserve.
- Quota refusals honor numeric/date Retry-After and exhausted-quota reset, capped at 24 hours.
  Permission failures remain ordinary errors. Known data survives failed/malformed refreshes.
  Retained age uses the broker's last successful timestamp when supplied, rather than making
  an old server snapshot look new. Automatic sibling reads share repository quota holds.

## Application entry points

Paths below are relative to `src/`. Distinct item representations have distinct keys to avoid
mixing normalized full-viewer data, watch/discussion detail, summary detail, and paginated data.
They share the policy, not an unsafe cast between different response shapes.

| Consumer / source | Cache and trigger | Interval |
| --- | --- | --- |
| `lib/github-client/hooks.ts` (`useRepoIssues`, `useRepoPullRequests`) | Canonical `gh/repo/issues` and `gh/repo/prs`; enabled observers | 120s / 300s |
| `components/desktop/useBranchPr.ts` and branch/session marker callers | Select from shared PR list; never read detail per badge | Inherit list |
| `components/desktop/repo-registry/useRepoCardModel.ts`, `RepoStatusHover.tsx` | PR list on hover; cached badges survive closing; CI uses shared run list | Inherit list while enabled |
| `components/desktop/IssueLinkPicker.tsx` | Shared issue list while picker open | Inherit list |
| `components/desktop/llm-chat/useHistoryAndMission.ts` | Shared issue/PR counts for resolved mission repository | Inherit list |
| `components/desktop/repo-focus/tabs/control-room/useIssueIntake.ts` | Canonical issue lists grouped by remote (checkout-scoped fallback); explicit refresh | Inherit list |
| `components/desktop/agent-panel/useActivityExtras.ts` | Four shared list entries per repository; lifecycle and explicit refresh | 120s / 300s |
| `components/desktop/useO8ActivityData.ts`, `o8-activity-helpers.tsx` | Same remote entries; local folder validation remains independent; lifecycle/relevant realtime/manual retry | 120s / 300s fallback; transcript-only batches ignored |
| `components/mobile/IssuesPage.tsx` | Same list factories in credential-isolated client; pull-to-refresh; epoch remount on rotation | 120s / 300s |
| `lib/github-client/ci-runs.ts` | Canonical CI run list; selected CI views, card/hover, retry | 120s / 300s |
| `components/desktop/pull-requests/useRepositoryPullRequests.ts` | Enriched pages keyed by checkout/state/sort/page, shared between views; selected tab/load-more/update event/manual refresh | 120s / 300s while active |
| `lib/github-client/linked-pr-list.ts`, `components/desktop/pr-panel/LinkedPullRequests.tsx` | Shared enriched first page for linked branch dependencies; explicit link verification reads current access once | Inherit list; verification has no timer |
| `components/desktop/settings/useDiagnosticsPrCount.ts` | Separate default-repository count; cached successful count and age, retry | 120s / 300s |
| `components/desktop/pr-panel/detail-query.ts`, `usePrDetail.ts` | Shared compact PR detail per repository/number, initial selection, write acknowledgment/manual retry | Open: 120s; selected checks: 30s; terminal: none |
| `components/desktop/pr-viewer/detail-query.ts`, `usePRData.ts` | Shared normalized full PR detail per repository/number; selection, action acknowledgment, retry | Selected visible open checks only: 30s; otherwise none |
| `components/desktop/pr-panel/usePrTimeline.ts` | Shared PR timeline per repository/number/page; selected conversation and pagination | No timer |
| `components/desktop/useIssueDetail.ts` | Shared issue viewer per repository/number, selection; quota-aware recovery | No timer |
| `components/desktop/agent-panel/useActivityPrHoverDetail.ts`, `o8-activity-helpers.tsx` expansion | Shared validated PR summary detail per repository/number, hover/expand | No timer |
| `components/desktop/agent-panel/useActivityCiHoverDetail.ts` | Shared CI hover item per repository/run; selection and retry, quota-aware | No timer |
| `components/desktop/canvas/useCanvasCIDetail.ts`, `O8ActivityCIDetail.tsx` | Representation-scoped CI item cache per repository/run; selection and retry, quota-aware | No timer |
| `components/mobile/PRReviewSheet.tsx` | Shared selected PR summary in mobile principal cache; closing unsubscribes | No timer |
| `lib/mobile/diff-fetch.ts` | Shared selected PR files in mobile principal cache; local worktree diffs stay local | No timer |
| `components/desktop/pr-viewer/usePRData.ts` review-thread reads | Shared client item entry and server cache; opened reviews and post-write invalidation | No timer |
| `components/desktop/CommitViewer.tsx` | Workspace-scoped local Git commit/file reads; selection | No remote list polling |

`components/mobile/PRDetailSheet.tsx` and `components/desktop/MergeActionCluster.tsx` have no mounted
callers. They are not live pollers. `O8InboxPane` consumes supervisor state rather than a separate
GitHub-list fetch. Create/enhance/review/merge/checkout endpoints are deliberate actions, not
background list observers; their acknowledgment/reconciliation behavior stays intact.

## Server and transport boundary

| Source | Cache / scheduling |
| --- | --- |
| `lib/github-broker/sync.ts`, `store.ts` | SQLite repository snapshots; 120s freshness including successful empty results; `fresh` bypass; installation-authenticated transport; interactive/background request priority |
| `app/api/panel/issues/route.ts`, `prs/route.ts` | Compact snapshot projection, stale/error/last-success/quota metadata; explicit `fresh=1` honored |
| `lib/github-broker/pull-request-list.ts` and `app/api/panel/prs/route.ts` enriched list path | Filter/sort/page-aware snapshots; explicit first-page refresh and validation |
| `app/api/panel/ci/route.ts`, `commits/route.ts` | Remote list cache 120s, bypassed with `fresh=1`; workspace commits keep local Git validation |
| `app/api/panel/prs/[number]/route.ts`, `lib/github-broker/details.ts` | Selected PR detail/watch enrichment; background `poll=1`; route/item-scoped snapshots |
| `app/api/panel/pr/route.ts`, `issues/[number]/route.ts`, `ci/[id]/route.ts`, review/timeline routes | Item-specific server reads/caches; UI only selects items; quota-aware response handling |
| `lib/github-broker/auth.ts`, `request-budget.ts`, `conditional-read.ts` | Credential-scoped quota reserve/holds and transport coalescing; opt-in conditional reads share in-flight transport; explicit list sync uses interactive priority |

The broker's supervisor synchronization, webhooks, write acknowledgment refreshes, and CLI/MCP
explicit reads use this authenticated transport but are not mounted UI interval timers. They
must retain their event/command semantics rather than being turned into extra UI pollers.
