# Activity parity

This is a partial Activity port. It does not complete desktop parity or close
#4548. The installed desktop app is unchanged; the shell still requires explicit
`o8 next --enable-next --app-shell` opt-in. No dependencies were added.

| Desktop control or behavior | Native counterpart | Status |
| --- | --- | --- |
| Repository selector; All repositories | Repository buttons; All repositories | Ported |
| All, Commits, PRs, Issues, CI, Packets filter pills and counts | Six filter buttons and counts | Ported |
| Chronological feed, 50-row cap, commit/CI grouping | Native feed model | Ported |
| Expand/collapse commit, PR, issue, CI, packet rows | Expand/collapse buttons, keyboard navigation | Ported |
| Commit summary and hash | Native expanded commit | Ported |
| Open commit in desktop commit pane | External commit link is available; native commit pane navigation absent | Missing |
| PR state, branch, additions/deletions, lazy file preview, checks/review status | Native PR summary and preview | Ported |
| PR author, changed-file count, passed/failed/pending count breakdown | No complete counterpart | Missing |
| Open PR in browser | Open PR details; CI-related PR links | Ported |
| Embedded PrPanel, close/back, destination preference | Browser link only | Missing |
| Issue labels, author, body excerpt, comment count, external issue navigation | Expanded issue and Open issue | Ported |
| Issue assignees | No counterpart | Missing |
| CI failure jobs, first failed step, error-line summary, loading, Retry CI details | Lazy validated CI detail, retained snapshot and Retry | Ported |
| CI 403/429 cooldown, recovery after expiry, manual retry, malformed-run refusal | Native detail state and active-pane tick | Ported |
| Open CI run; related pull request | Open CI run; Open PR #N | Ported |
| Packet summary, status, runtime, branch | Native packet row and summary | Ported |
| Focus packet worker | Open worker reuses the shell session Surface/sidebar | Ported |
| Hold, Unhold | Hold, Release hold; targeted state PATCH and refusal feedback | Ported |
| Stop mission | Same POST route and exact-body receipt replay after lost responses | Ported |
| Launch/Dispatch | No counterpart | Missing |
| Stop worker; Resume worker | No counterpart | Missing |
| Archive/unarchive; Delete | No counterpart | Missing |
| Retry/reset; copy/open packet issue | No counterpart | Missing |
| Packet title/summary/runtime/repository/branch/spec editing | No counterpart | Missing |
| AGENTS, CONTEXT, CHANGES, FILES tabs; Details popover | No counterpart | Missing |
| Artifacts, buy-in document, recall, spend, claim-unbacked and rejection feedback | No counterpart | Missing |
| Review snapshot/files, Show all files, Open branch diff | No Activity-to-review navigation | Missing |
| Create PR, merge, close-unmerged/discard controls and confirmations | No counterpart | Missing |
| Proposed-directive drawer, new/seen preferences, Accept and Dismiss for all sources | No counterpart | Missing |
| Recurring-problem list/details; Accept, Suppress, Stop, Resume | No counterpart | Missing |
| Loading, empty, local-only GitHub connection prompt, error and Retry | Native states with retained remote streams and successful-empty replacement | Ported |
| Today/Yesterday labels, relative ages, per-mount packet timestamp fallback | Raw ISO day groups; no complete counterpart | Missing |
| Realtime/lifecycle invalidation and five-minute fallback | Five-minute active-pane fallback and explicit refresh; immediate invalidation absent | Missing |
| Activity before any workspace has a saved session | Existing shell workspace requirement remains | Missing |

Every implemented action is exercised through GPUI controls against the disposable
HTTP host and production route handlers. The fixture authors only upstream GitHub
responses and disposable Git/SQLite state, not application route responses. Both
fixture roots use canonical paths, including the macOS temporary-directory alias.
No platform-native sidecar or packaged resource is staged or changed by this port.

Measurements use Linux debug-build GPUI TestAppContext CPU scene paint. They include
fixture HTTP where applicable and GPUI test text/layout work. They do not measure
GPU presentation, compositor latency, the installed app, or macOS. No speedup is
claimed over the absent baseline surface. The missing controls above remain open acceptance items; these measurements do
not establish physical GPU or macOS presentation latency.
