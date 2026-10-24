# Review correction round 2

PR #4656 stays on its existing branch. It is rebased onto current main, preserving
both the landed Settings controls and Issues in the shell and disposable route
host. This round changes only account ownership of creation and definite 429
refusals. No dependencies, schema, release or installed-app defaults change.

## Account ownership

The production create route captures the verified active account, sign-in epoch,
credential mode and API host before its first await. It resolves one installation
credential for that captured account and passes that credential through the
creation action to the broker. The account is checked after credential resolution,
immediately before dispatch, and before returning a completed or replayed receipt.
The send uses the captured token; it never resolves a new account's token after
reservation.

The existing persisted request binding now includes the account owner along with
installation and input. The key namespace is unchanged: another account cannot
replay the first owner's receipt or execute the same key as a new operation.
Unowned older bindings fail closed. Sign-in epoch is a request guard, so the
original account can recover its own receipt after signing in again. Credentials
are never written into receipt data.

## Definite 429 refusals

The broker's request-budget exception proves either a pre-dispatch refusal or a
definite upstream 403/429. The issue action classifies it as not created, allowing
the existing idempotency store to release the execution reservation. The route
returns 429, Retry-After and creationRefused, leaving the native draft editable.
The original key succeeds after cooldown. Ambiguous transport/5xx failures retain
the previous outcome-unknown quarantine.

## Red-first evidence

`tests/next-issues-account-real-path.test.ts` starts the real fixture HTTP host,
production middleware, create route, broker, account files and SQLite store. A
fixture-only SQLite trigger switches real managed account state exactly when the
production reservation is inserted. Another fixture control holds the upstream
reply after commit, allowing an account change before the receipt is returned.
Neither seam replaces production handlers or authorization helpers.

`native/o8-next/src/issue_review_tests.rs` adds two headless GPUI cases. One drives
a timed-out A creation, refuses B's retry, then recovers A's receipt with exactly
one upstream POST by A. The other edits the title after a definite 429 and creates
successfully after cooldown through the real native controls.

The four route regressions failed before either production fix (`red-server.txt`);
both GPUI regressions also failed before the fixes (`red-native.txt`). The final
focused runs pass all six new cases. An independent authorization review found no
blocking issue in the implementation or regression boundaries.

| Mechanic | Before | After |
| --- | --- | --- |
| B replays A's receipt on the same installation | 200 with A's URL | 409 without URL; A can recover |
| Account changes at reservation | 1 POST of A's draft with B's token | 0 POSTs; 409 |
| Account changes while committed reply is held | A's URL returned after switch | 409; receipt remains recoverable by A |
| Original key after definite 429 cooldown | Permanent 409 | 200; one committed issue |
| Native draft after 429 | Frozen as outcome unknown | Editable title; successful creation |

## Completion checks

The final native suite passes **62 tests**, with **3 ignored**, plus **7 passing
CLI tests**. All twelve GPUI issue cases pass. The affected TypeScript run passes
**5 files / 23 tests**. TypeScript with the 8 GiB heap, fast typecheck, touched-file
ESLint, classification, Rust formatting and rule-check pass; the rule check scans
seven eligible files with zero violations against `origin/main`. The normal
release-profile native build passes separately.

The final full `npm test` passes **1,237 files / 8,953 tests**, with **3 files /
5 tests skipped**, in **401.09 seconds**. The rebase includes main's landed
offline Pi-contract test-window fix, resolving the unrelated npm failure reported
in round 1 without changing its billing safeguard in this correction.

Final commands and totals are retained in `green.txt`. Checks run on Linux with
Node 22 and stable Rust. The existing account-switch and canonical-path tests stay
in the complete native suite; macOS execution is unavailable here.

An optional broader run of `tests/workspace-github-polling-real-path.test.ts`
reported 22 Git-fixture failures. The same test in a clean `origin/main` checkout
reproduces the same 22 failures (`REVIEW_GIT_UNAVAILABLE`), independently of this
correction. Its source and implementation are unchanged by this branch.

The first complete native run passed 61 cases but timed out in the existing
worker-steering fixture. A temporary main checkout had also been picked up by
TypeScript's broad source include. That clean checkout was removed, the fast
typecheck completed successfully, and the complete native suite was rerun
without competing checks. The final result is retained in `green.txt`.
