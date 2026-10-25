# Final PR request registration correction

Rebased on `origin/main` at `3b99b20d6`. The accepted P1 merge-gate, linked-worktree
and 14-payload parity code is unchanged. This correction removes the remaining
PR module include from shared `src/client.rs` and loads it from the registered
`surfaces/pull_requests.rs` instead.

Both `pr_preview` and `pr_post` use the existing shared URL, authenticated request
and bounded JSON reader. Queries, bodies, HTTP 409 preview handling, POST refusal
decoding, required operator credentials and the no-retry policy are retained.
Other PR route reads already live in the surface model and detail modules.

## Real-entry regression

`src/surfaces/pull_requests/registration_tests.rs` copies the actual native crate
source, fixtures and locked manifest into an owned disposable directory under
`CARGO_TARGET_DIR`. It retains the original immutable vendor source. It compiles
the real `main.rs`, including its normal shell macro and shared client:

| Copy of real application | Expected result |
| --- | --- |
| Registration present, canary calling both PR methods | Compiles |
| Remove only the single PR registration, no canary | Compiles |
| Registration removed, canary calling both PR methods | Both methods unavailable with E0599 |

The test was written first. Before the fix, the third compile succeeded because
the shared client independently loaded both methods. [Red tail](final-registration-red.txt):
`0 passed; 1 failed`. After the move, both methods are unavailable when their
registration is removed. [Green tail](final-registration-green.txt): `1 passed;
0 failed`. The original source is never changed by the regression.

A second test preserves the missing-credential refusal before any request is
delivered. Existing headless GPUI tests exercise the registered PR view and its
production routes, including the accepted merge-gate and delivery protocols.

## Final local verification

- Full native unit run: 116 passed, one failed, three explicitly ignored. The
  unchanged worker streaming test timed out waiting for its first transcript;
  [full-run failure tail](final-native-suite-red.txt). Its isolated rerun passed
  in 66.32 seconds without a source change. All seven native CLI integrations
  passed separately; [rerun and CLI tails](final-native-rerun-green.txt).
- All [28 PR tests](final-native-pr-green.txt) passed in the full native run,
  including both registration tests, both accepted P1 corrections and the
  14-identical-payload native/desktop parity test. The full native run itself
  remains recorded as red; the isolated pass does not replace that receipt.
- Related TS batch: eight files, 61 tests passed. This includes the six previously
  touched PR route, desktop and broker files plus shell and registration tests.
  No full npm test suite was run in this round.
- `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:fast`, Rust formatting
  and rule-check (17 files, zero violations) passed.
- Clippy `--all-targets` exited zero. The existing unused `pr_preview` warning
  remains, along with baseline diagnostics elsewhere; no new touched-file
  warning was introduced.
- Classification passed: 1,238 hermetic / 909 resource-owning tests and all 78
  isolated date-fixture checks.

All Cargo targets for this round were owned inside this worktree and removed
after verification. No OS-level input, installed-app operation, merge or release
was performed.
