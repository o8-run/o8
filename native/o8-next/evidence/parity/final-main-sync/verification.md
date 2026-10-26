# Final main synchronization

Fetched and rebased onto `origin/main` at `737c988ff`, newer than `40025f048`.
Sidebar was the only added surface without a parity mapping. It now uses the
existing `--sidebar` production-route fixture, the current `/dashboard` route and
sidebar toggle, and the native thread search/list selectors. No data logic was
added or copied.

Inventory agreement now has one dedicated CLI guard, `--check-surfaces`, tested
in `tests/next-parity-harness-real-path.test.ts`. The regular listing, comparison,
selected capture and GPUI measurement paths do not repeat global inventory
validation. The missing-mapping fixture also checks that listing and comparison
remain usable. Its diagnostic assertion tolerates other future missing names.
CI runs all three harness test files, including the guard, before rendering.

The fail-first run deliberately retained the missing Sidebar mapping after
isolating the guard. It produced **one failure naming `sidebar`, with 21 tests
passing**: [red tail](red.txt). Adding the mapping produced **22 passing tests**:
[green tail](green.txt). This exercises the failure mode caused by the next
unmapped registration without cascading failures through the render tests.

The [other check tails](checks.txt) record two real GPUI parity tests, seven native
CLI assertions, clippy, 27 Linux/boundary regressions, 9,157 JavaScript tests, both
TypeScript checks, classification, lint and formatting. Native checks on this
final synchronization are the targeted GPUI and CLI suites; the prior complete
native run remains in the [round 2 history](../review-2/verification.md).

The accepted 52-gap report and prior screenshot evidence are unchanged. The
matrix now contains 16 registered surfaces. Sidebar's row, typography and full
column parity remain unmeasured under #4642; its checklist rows make no Done
claim. The next full CI capture writes 32 pairs.
