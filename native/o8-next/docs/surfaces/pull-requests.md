# Native pull requests (partial parity)

Open the opt-in app shell, open its command palette with Ctrl+K or Cmd+K,
and choose **Open pull requests**. The selected workspace supplies `repoPath`;
the server resolves its GitHub origin. The launcher remains opt-in. Shared merge
safety is enforced for both desktop and native clients through the existing PR
routes. No additional crates or application routes are added.

Registration, workspace view retention, focus and shell tests belong to
`src/surfaces/pull_requests.rs` and `src/surfaces/pull_requests/`. The shell has
one inventory entry. The surface loads its own request adapter from
`pull_requests/client.rs`; its inherent `impl Client` uses the shared URL,
authenticated-request and bounded-response helpers. Shared `src/client.rs`
matches main and contains no PR-specific code. Removing the inventory entry
removes the view and request methods together. The
fixture registers with `scripts/next/dev-server.ts --pull-requests` through
`scripts/next/surfaces/55-pull-requests.surface.ts`.

The final [registration correction](pull-requests/final-registration.md) records
the real-entry compiler regression and its red/green output. The accepted merge
gate and linked-worktree fixes are unchanged in that correction.

The surface uses the shared native theme and GPUI composer. Reads and writes use
the existing `Client` and its explicit loopback origin/operator bearer. The PR
list uses `/api/panel/prs?view=list`; details and writes use
`/api/panel/prs/:number`. Confirmations freeze repository, number, head, comment
and merge method. A repository change invalidates the previous detail. Busy,
uncertain and partial-close delivery state is scoped to repository and PR in the
GPUI app, shared by all workspace and window instances. It survives closing and
reopening the shell's PR tab. Uncertain writes never retry automatically.
Acknowledgment applies only to the displayed attempt and cannot release a newer
busy or uncertain hold. Partial close retries only the close, preserving the
posted comment. Metadata actions preserve unsent editor text; confirmed comment
and review submissions may clear only the unchanged draft they sent.

PR merge uses the desktop PR server route with the selected method and reviewed
head. It never calls GitHub directly or substitutes a packet merge. The server
resolves repository/PR packet membership across current and archived missions,
delivery links and lanes, including linked worktrees. Git common directories
and paths are canonicalized. Explicit PR identities take precedence over branch
fallback; fork branch collisions do not link unrelated packets. Unavailable
identity, review or packet state refuses merging.

The detail response includes one shared merge decision covering checks, reviews,
every linked packet's merge-preview checks, holds, blocked state and fresh runtime
liveness. Confirm refreshes this decision and refuses any change from preparation,
including membership, head, base and merge methods. The existing POST route
rechecks immediately before provider publication, after the broker's metadata
read, even for callers without a snapshot. This is fresh validation, without a
cross-writer lease or an atomicity claim. Native Checks displays all gate rows,
details, remedies and structured preview refusals.
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
| Busy, uncertain delivery, acknowledge after checking GitHub | App-wide per-repository/PR delivery state shared across workspaces | Ported |
| Summary, description, review decision, diff totals | Plain native summary | Partial; collapse and review guide missing |
| Changes, file tree, open/collapse files, split/unified, syntax highlighting | Plain file patches with unavailable notice | Partial; file navigation and diff controls missing |
| Checks, buckets, View run | Desktop-ordered status buckets and View run | Ported |
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

See [verification receipts](pull-requests/verification.md),
[draft/delivery correction receipts](pull-requests/correction-1.md),
[merge correction receipts](pull-requests/correction-2.md), plus
[raw timing samples](pull-requests/timing.json). See also the [registration migration receipts](pull-requests/registration.md). Full desktop parity,
packet-linked merging and the partial/missing controls above remain open.
