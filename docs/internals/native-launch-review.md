# Reproduce current desktop launch measurements

Use a fresh disposable macOS account or VM, with no installed o8 app and no running o8 process. The harness checks both application directories, requires the isolated `ai.o8.desktop.launchbench` identifier, and accepts only app artifacts below the explicitly supplied workspace root. It never launches an installed app.

Prerequisites: Node 22.23.4, npm 11.21.1, the stable Rust toolchain, the macOS SDK and command-line developer tools including `swiftc`. Use the same machine, power state and optional-permission state for both builds. Finish builds and other tests before collecting timings. Do not change host power settings for a measurement.

## Build two disposable copies

Run from a source clone. Preparation edits the disposable layout to install the request observer before dashboard code and writes an isolated app-only release configuration. Older artifacts without that observer must be rebuilt; the corrected harness refuses them rather than reporting a zero count.

```sh
git fetch origin main refs/pull/4874/head:refs/remotes/origin/review-4874
launch_head_sha=$(git rev-parse refs/remotes/origin/review-4874)
launch_main_sha=$(git merge-base origin/main "$launch_head_sha")
launch_review_root=$(mktemp -d /tmp/o8-launch-review.XXXXXX)
git worktree add --detach "$launch_review_root/harness" "$launch_head_sha"
git worktree add --detach "$launch_review_root/main" "$launch_main_sha"
git worktree add --detach "$launch_review_root/head" "$launch_head_sha"

for launch_variant in main head; do
  (
    set -e
    cd "$launch_review_root/$launch_variant"
    npm ci --prefer-offline
    npm run typecheck:tsc
    node "$launch_review_root/harness/scripts/bench/native-launch-config.mjs" "$PWD"
    NEXT_TELEMETRY_DISABLED=1 O8_RELEASE_BUILD_CACHE=off APPLE_SIGNING_IDENTITY=- \
      npx --no-install tauri build --features dev-mcp-plugin --bundles app --config work/native-launch.json
  ) || break
done
```

Stop if either build or its fallback typecheck fails. Preserve the diagnostic and source SHA; do not label incomplete builds as measured samples. In the review of `01ab614f9`, both builds were reported failing at `storage-telemetry.ts:426`. That file and the dependency lock are identical between measured main `c43a59c` and that head. The reported failure is shared with main, not introduced by the startup-prefetch diff. The fallback checker passes on the isolated Linux checkout; the exact reported macOS diagnostic has not been independently reproduced there.

## Run the uninstalled artifacts locally

Install harness dependencies separately. Local disposable mode compiles its foreground-activation helper but leaves the privacy database untouched. Calibrate the isolated candidate once, manually settle any optional-permission prompts, and keep that permission state fixed for the six timed launches. Keep calibration output separate.

```sh
(cd "$launch_review_root/harness" && npm ci --prefer-offline)
node "$launch_review_root/harness/scripts/bench/native-launch.mjs" \
  --disposable-root="$launch_review_root" \
  --app="$launch_review_root/head/src-tauri/target/release/bundle/macos/o8.app" \
  --sha="$launch_head_sha" --samples=1 --output="$launch_review_root/evidence/calibration"

node "$launch_review_root/harness/scripts/bench/native-launch.mjs" \
  --disposable-root="$launch_review_root" \
  --app="$launch_review_root/main/src-tauri/target/release/bundle/macos/o8.app" \
  --sha="$launch_main_sha" --samples=3 --output="$launch_review_root/evidence/main"
node "$launch_review_root/harness/scripts/bench/native-launch.mjs" \
  --disposable-root="$launch_review_root" \
  --app="$launch_review_root/head/src-tauri/target/release/bundle/macos/o8.app" \
  --sha="$launch_head_sha" --samples=3 --output="$launch_review_root/evidence/head" \
  --check-startup-loads --check
```

Every sample gets new application data and an ephemeral main webview profile. The endpoint remains an acknowledged controlled edit in a visible, uncovered, enabled and focused composer. Receipts retain all samples and teardown verification. The startup-request check must be zero on head. The separate 1,000 ms check remains strict and may exit nonzero after saving the receipt.

Local receipts identify `runnerMode: disposable-local` and `privacyMode: manual`. Hosted mode retains its existing controlled permission setup. Do not set hosted-runner environment variables to imitate that mode on a local machine.

## Review evidence boundaries

The cold-entry regression holds connected data pending, verifies loading and an unknown active count, then verifies real schedules and counts after resolution. It separately checks failure without a false zero. The request-counter regression prepares the real benchmark layout, starts a connected fetch before the first composer probe, and leaves its response pending.

Those tests do not establish native feature-delay or first-paint acceptance on a review machine. The previously published hosted arm64 launch results are historical; their late-installed counter did not establish coverage of requests already pending before probing. Corrected native launch counts require newly prepared artifacts and a fresh six-sample run. Record cold feature-entry delays and first-paint observations separately when reviewing the new builds; absent observations remain unverified.
