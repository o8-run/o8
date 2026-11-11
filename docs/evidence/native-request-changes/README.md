# Native Request changes

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

## Verification scope

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
