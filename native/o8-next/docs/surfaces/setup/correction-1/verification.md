# Selected runtime model correction

The headless shell test `onboarding_opencode_keeps_selected_model_for_first_send`
in `native/o8-next/src/shell_tests.rs` saves an OpenCode lead/model through the
production operator-defaults route, finishes native setup with GPUI clicks,
checks persisted history, and submits the first message through the composer.
The production queue must retain both `opencode` and `fixture/selected-model`.
Only CLI/model discovery and background activity are fixture inputs.

Before: 0 passed, 1 failed. The production history handler persisted
`claude-code` instead of `fixture/selected-model`. See [red tail](red-tail.txt).
After: 1 passed, 0 failed, including persisted first-message routing.
See [green tail](green-tail.txt). Setup now passes its selected lead model
alongside its backend when creating the conversation.

The branch was rebased onto `origin/main` at `30887e215`. The combined fixture
retains onboarding mode and main's Brain mode, along with every shell test from
both sides and the separate Brain test module. All **15 shell/onboarding/Inbox/
Brain cases passed** in the rebased native run (`shell_tests.rs`, `inbox_tests.rs`,
`brain_tests.rs`).

The broader native run reported **43 passed, 1 failed, 3 ignored**. The failure
was `saved_history_surface_with_only_o8d` because its required native binary was
absent. Built the prerequisite with the existing documented entry point:
`cargo build --locked --manifest-path crates/o8d/Cargo.toml --features experimental-http --bin o8d`.
Its focused retry passed **1/1**; see [retry tail](o8d-retry-tail.txt). No source
change was needed for that prerequisite. The original broader result is retained
in [rebased native tail](rebased-native-tail.txt).

Both TypeScript checks passed with `NODE_OPTIONS=--max-old-space-size=8192`:
`npm run typecheck:fast` and `npx tsc --noEmit`. Touched-script ESLint,
`npm run rule-check -- --base=origin/main`, `npm run test:classify` and touched
Rust formatting checks passed. Classification produced no tracked changes.

The [rebased measurement](run.json) records 226.23 ms open-to-first-frame and
94.63 ms interaction-to-frame during concurrent checks. This is the same Linux
debug/headless CPU endpoint, with no GPU/compositor or macOS claim. No latency
comparison is made.

Full `npm test`: **1,236 files passed, 1 failed, 3 skipped; 8,943 tests passed,
9 failed, 5 skipped**, in 618.74 seconds. See [summary](npm-summary.txt).
All nine failures are in unchanged `src/components/desktop/CustomizePage.test.ts`.
The focused retry with the same unit config passed **11/11**; see
[retry tail](customize-retry-tail.txt). `git diff --exit-code origin/main -- src`
confirmed that desktop application/test sources are identical to main.
The full run remains non-green; no desktop changes were made in this correction.
An initial Vitest cache startup error occurred before tests ran; recreating the
existing cache allowed the recorded full run to execute.

Refs #4548
