# Review correction round 1

The correction stays on PR #4656's branch. It rebases the issue surface onto
current main and retains both Brain and Issues in the shell tick and test-ready
matches. The installed app remains opt-in and unchanged.

## Mechanics and regression evidence

| Review finding | Before | After |
| --- | --- | --- |
| Repository A → B → A | Unsent A title/body cleared | Separate editor entities retain each repository's title, body, labels and pending creation |
| Commit followed by a 6.5-second reply, beyond the 5-second client timeout | Retry creates 2 issues | Frozen request key and persisted server receipt create 1 issue |
| Committed POST with lost upstream reply | Retry creates 2 issues | Persisted outcome-unknown receipt refuses another POST; 1 issue |
| Symlink-spelled workspace after Refresh | Selected session becomes null; send unavailable | Shared canonical-path comparison retains the session and its queue accepts the message |
| Repository switch with a frame between mouse-down/up | Destination issue never paints | Mouse-down selection survives repaint; both repositories paint in four alternating switches |

`native/o8-next/src/issue_review_tests.rs` drives real GPUI shell controls,
editors, fixture routes and persisted queue state. Its first three tests failed
before their fixes (`red-native.txt`). The split-event regression also reproduced
the account-switch failure on Linux before its fix (`red-frame-gap.txt`). The
existing account test waits for the destination issue's paint receipt instead of
a generic ready marker that can belong to the previous repository.

`tests/next-issues-real-path.test.ts` exercises the production create handler,
operator middleware and installation broker. Concurrent keyed requests and a
later replay return the same issue; another body using that key is refused; an
anonymous replay is refused; another repository has its own key scope. Its new
cases failed before their corresponding fixes (`red-server.txt` and
`red-upstream.txt`). Legacy keyless creation remains covered.

The server binds keys to the installation and normalized input using the existing
SQLite idempotency store, with receipts retained for the practical store lifetime.
No schema or dependency change is needed. A definitive GitHub 4xx refusal permits
an edited draft to retry; a transport/5xx ambiguity stays quarantined rather than
authorizing another side effect. The native draft retains its original key across
timeouts and repository switches, and refuses an edited unconfirmed request.

## Verification

The complete native suite passes: **50 passed, 0 failed, 3 ignored**, plus **7
passed** CLI tests. All ten GPUI issue tests pass, including the four new review
regressions. The touched HTTP/worker/shell run passes **3 files / 10 tests**.
TypeScript with the 8 GiB heap, fast typecheck, touched-file ESLint, Rust formatting,
test classification and rule-check all pass; rule-check scans six eligible files
with zero violations against `origin/main`. The normal release-profile native
build passes separately. `green.txt` retains the final command receipts.

Verification runs on Linux with Node 22 and stable Rust. The symlink fixture uses
canonical paths and owns both paths in its temporary tree. macOS execution is
unavailable here; the frame-gap reproduction and destination-paint wait avoid
depending on the test platform's event scheduling. Existing ignored tests and
the original parity/measurement limitations remain documented in
[`../verification.md`](../verification.md).

The first final `npm test` attempt stopped before collecting tests because its
Vitest cache directory was absent. Restoring the cache directory allowed the
unchanged command to run; its completion result is recorded in `green.txt`.

The completed full suite reports **1,236 files / 8,947 tests passed**, **1 file /
4 tests failed**, and **3 files / 5 tests skipped**, in **390.51 seconds**. All
four failures are in `tests/pi-sdk-live-contract.test.ts`: its billing contract
expires at 2026-10-25 00:00 UTC. That test and its contract, budget and transport
sources are identical to `origin/main`; a focused rerun reproduces the same four
failures. The correction does not change that unrelated billing safeguard. The
full npm gate therefore remains failing and is explicitly reported in the PR.
