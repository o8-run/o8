# Native pull requests (partial parity)

Open the opt-in app shell, open its command palette with Ctrl+K or Cmd+K,
and choose **Open pull requests**. The selected workspace supplies `repoPath`;
the server resolves its GitHub origin. The installed desktop client and launcher
defaults are unchanged. No additional crates or application routes are added.

The surface uses the shared native theme and GPUI composer. Reads and writes use
the existing `Client` and its explicit loopback origin/operator bearer. The PR
list uses `/api/panel/prs?view=list`; details and writes use
`/api/panel/prs/:number`. Confirmations freeze repository, number, head, comment
and merge method. A repository change invalidates the previous detail. Busy,
uncertain and partial-close delivery state is scoped to repository and PR and
survives closing/reopening the shell's PR tab. Uncertain writes never retry
automatically. Partial close retries only the close, preserving the posted comment.

PR merge uses the desktop PR server route with the selected method and reviewed
head. It never calls GitHub directly or substitutes a packet merge. When a packet
matches the canonical workspace and head branch, the native surface reads
`/api/orchestrator/merge-preview` and displays all returned checks, details,
remediation actions and blockers, including structured HTTP 409 refusals.
Packet-linked PR merging and enabling auto-merge remain disabled in this slice,
even when preview passes: the packet merge protocol cannot preserve the selected
PR/base/method, and a preview followed by a GitHub merge cannot atomically enforce
packet gates. Disable auto-merge remains available. This is an explicit parity gap.

## Desktop control parity

| Desktop control | Native counterpart | Status |
| --- | --- | --- |
| Search, quoted terms, `label:`, `author:`, `author:me` | GPUI search editor | Ported |
| Updated, oldest, newest sort | Sort cycle control; same server query | Ported |
| Open, closed, merged, all | State cycle; merged reads closed and filters locally | Ported |
| Author, label, base, draft, check filters | Individual cycle controls on loaded pages | Ported |
| All authors, authored, review requested, others | Involvement cycle; unavailable without viewer | Ported |
| Author grouping and branch stacks | Author/branch metadata switch | Partial; group headings and dependency hierarchy missing |
| Row title, author, branch, status, diff totals | Native text rows | Partial; avatars, labels and relative timestamps missing |
| Refresh, Retry, Load more | Native controls, duplicate-number suppression | Ported |
| Empty, unavailable, initial load, refreshing, failed read | Native list/detail notices and Retry | Ported |
| Open detail and close/back | Native detail pane | Ported; desktop focus/keyboard parity missing |
| Copy checkout command, link, PR number; Open GitHub | Clipboard and GPUI URL actions | Ported |
| Merge/squash/rebase and confirmation/cancel | Head/repo/method-pinned POST through desktop PR route | Ported for unlinked PRs |
| Merge-preview checks, blockers, remedies | Every returned gate row, including HTTP 409 | Ported display; packet-linked merge and auto-merge enable missing |
| Draft, Ready for review, Enable/Disable auto-merge, Close | Confirmed native PR actions | Ported; linked auto-merge enable refused |
| Comment, Close with comment, retry partial close | Shared GPUI editor and native controls | Ported |
| Review comment, Approve, Request changes, Use latest commit | Head-pinned review controls | Ported |
| Busy, uncertain delivery, acknowledge after checking GitHub | Per-repository/PR delivery state | Ported |
| Summary, description, review decision, diff totals | Plain native summary | Partial; collapse and review guide missing |
| Changes, file tree, open/collapse files, split/unified, syntax highlighting | Plain file patches with unavailable notice | Partial; file navigation and diff controls missing |
| Checks, buckets, View run | Flat check rows and View run | Partial; bucket grouping missing |
| Fix failing checks, selection, Start repair, receipt retry, open owner/worker | None | Missing |
| Timeline, sort order, pagination, commits | None | Missing |
| Issue and review discussion display | Plain discussion rows | Partial; rich rendering and thread controls missing |
| Thread reply, resolve/unresolve, viewed/collapsed state | None | Missing |
| Ask Brain, explain/discuss, context injection, hidden comments | None | Missing |
| Artifact proof strip and review guide navigation | None | Missing |
| Per-PR drafts, tab, open-file and scroll persistence | Delivery state only | Missing view/draft persistence |
| PR viewer section keys, item navigation and quick actions | Standard composer input and shell palette | Missing PR-specific keys |

## Verification

The production-route fixture owns its canonical temporary repository and account
state. It replaces only GitHub's external responses and supplies an authored packet
inventory; preview refusals run through the production preview handler. It never
contacts an account or external server. The passing-preview client refusal case
injects a contract fixture into the GPUI state, then clicks the actual merge
control and verifies that the server received no POST.

```sh
npm run test:classify
npx vitest run tests/next-pull-requests-real-path.test.ts
cargo test --locked --manifest-path native/o8-next/Cargo.toml pull_requests -- --nocapture --test-threads=1
```

Set `O8_NEXT_PR_RESULTS` to an explicit output file to capture the timing receipt.
The timer ends in the GPUI canvas paint callback. List-open includes HTTP reads;
detail-selection includes the production detail read. Twenty tab interactions
measure dispatch to the changed revision's first CPU paint. The Linux headless
text system does not shape native fonts, render on a GPU or present to a display.
These debug-profile measurements establish no macOS/display latency target.

See [verification receipts](evidence/pull-requests/verification.md) and
[raw timing samples](evidence/pull-requests/timing.json). Full desktop parity,
every-gate native mutation coverage and packet-linked merging remain open.
