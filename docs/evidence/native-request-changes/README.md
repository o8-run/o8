# Native Request changes

Correction round 1: **not checked by eye**. The images below are historical
captures from before this layout correction, retained under the operator ruling.
They do not establish the revised UI. Current evidence is headless native tests,
production-route tests and macOS cargo check; the operator owns visual captures.

The captures show the native packet diff and its shared Request changes control
against a disposable loopback HTTP fixture. The fixture supplies authored saved-rejection,
reviewed-HEAD and author-run metadata. It starts no worker and has no production data.
These captures establish native layout and request feedback, not an installed-app
or production-author delivery result.

- `idle.png`: optional operator note before sending the saved findings.
- `busy.png`: submission in flight, with duplicate submission disabled.
- `error.png`: inline failure, retained note and retry of the original request.

Packet review in Activity embeds the same native entity. Availability and optional
note delivery are tested separately through the production correction handlers
and persisted worker/review state in `tests/review-author-handoff-real-path.test.ts`.
The native transport coverage lives in `tests/o8d-next-surfaces-real-path.test.ts`.
No new route, authorization exception or automatic destructive fallback is added.

The classic chat banner's orchestrator-composer recovery prefill is deliberately
not ported. Start over with feedback belongs to the separate reset-controls change.

## Original verification scope

- Focused production-handler tests: four passed. The two new availability/note
  cases failed against the unchanged route/service before implementation.
- Native request/retry and note-shortcut regressions: two passed.
- Existing Activity packet-review and real-server diff tests: one passed each.
- Touched TypeScript ESLint, rule check, Rust formatting for the shared control,
  and test-classification manifest check passed.

The full typecheck and verifier did not pass in this checkout without a local dependency installation.
An alternate dependency resolver was sufficient for the focused tests, but full
resolution/bundle checks and dated-fixture probes still failed. The broader
handler suite also encountered an unavailable CLI bundle in three isolated-author
cases. The additional o8d transport assertions were added but not executed locally.
These limits require CI and review before merge. No installed app or production
author was exercised.

The local macOS `cargo check --release` and `cargo build --release` passed using
the shared Cargo target cache. The capture binary was copied into the worktree
and checked for its embedded source path before launch. Its SHA-256 was
`7bd7a21e93f040299e01e63a2cf091fdbfee7689368260e8c1c6488441748836`.
The private binary copy was moved to Trash and the disposable server stopped
after capture.

Window fit was checked at 900 × 700 and 1680 × 1050 in both light and dark themes.
The additional `light-compact.png`, `light-wide.png`, `dark-compact.png` and
`dark-wide.png` captures show those layouts.

## Initial hosted receipt

At `97875b9fc9e4cfd9d41038df1b7b887a3f044f81`, the changed-file integration
job passed all 13 author-handoff tests. The three new correction-route transport
assertions also passed with Next stopped. The transport suite had 131/133 passes:
two pre-existing method expectations still described GET-only for setup CLI
updates and problem dossiers, while both routes already registered GET and POST
on the base commit. This change updates only those expected method lists.

## Correction round 1

The toolbar/dismissal regression fails on the reviewed head: Request changes is
at a different vertical position from Approve. The revised suite covers toolbar
order, content-width Send/Cancel, dismissal with retained text, Cmd+Enter,
UTF-16 remaining room, identical retry identity, read-only failed input and
selection of a single outcome line. A production-handler capacity regression
also fails on the reviewed service. Ten production-handler cases pass on the
correction; three isolated-author cases remain skipped for the unavailable CLI.
No further captures or operating-system input automation are used. The revised
control is **not checked by eye**.

Correction results: all four request-changes native tests passed, as did the
existing Activity packet-review path test. macOS release cargo check passed.
Touched ESLint, Rust formatting, rule-check and classification manifest checks
passed. Full typecheck remains blocked by dependency/type resolution. No fresh
visual acceptance is claimed.

## Correction round 2 of 2

The operator note now precedes the closing scope limits under the explicit
label “Operator note on these findings; it does not widen the task or change
permissions:”. The limits remain the last line. Stored-note replay matches that
bounded section and final limits; same-note and automatic replays return the
same receipt without another author run.

The new real-path test fails on the reviewed message order, then passes with
this correction. Eleven production-handler cases passed; three isolated-author
cases were not rerun. The new Activity typing-guard regression calls the handler
directly in GPUI's test platform, without window-system input. It fails when
the guard is removed, then passes with the restored guard after a fresh compile.
It checks Space/Enter while the note is focused and a working action outside it.
MacOS release cargo check, touched ESLint, Rust formatting, rule-check and the
classification manifest check passed. Full typecheck still fails at missing
dependency/type resolution. The revised UI remains **not checked by eye**.
