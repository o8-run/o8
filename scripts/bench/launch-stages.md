# Current desktop launch measurements

The manual `Current app launch stage profile` workflow builds two clean release apps and measures them on one disposable macOS runner. It uses the current desktop shell and web interface. It refuses to run beside an installed app.

`MAIN_SOURCE` pins the baseline commit. `MEASUREMENT_HARNESS` pins the existing native composer harness. The head stays independent of that harness branch. `prepare-launch-stage-build.mjs` applies the startup prefetch change from #4874 to both disposable source checkouts for measurement only. It also adds an early frame observer, build-time client module identities, an isolated app identifier and an ephemeral webview profile. These source edits are absent from the product patch.

By default both apps are built from scratch. The optional `main_run_id` input reuses an exact baseline artifact built with the same probes. The comparison runs main three times, then head three times, on the same runner. Each launch has a fresh synthetic project and profile. Normal shell and server bootstrap run without preship startup shortcuts. Each sample must acknowledge an edit in a visible, uncovered, enabled, focused controlled composer. The app, server descendants and webview helpers are torn down and verified between samples.

Timing runs use listener and HTTP request timestamps only. Separate diagnostic runs add server CPU sampling, module load timing, subprocess attribution, client module execution and frame callback observations. CPU-profiled wall times are diagnostic and are not substituted for the six timing samples.

The receipt records process start, server entry and listen, document first byte, first paint and accepted input. A real paint entry is preferred; when unavailable, the receipt explicitly labels a two-frame observation of nonempty dashboard content. HTTP timings measure production route load and response work, not development compilation. Request durations overlap and must not be added together. Subprocess spawn durations describe synchronous launch work, distinct from child lifetimes.

`stages.json` includes source and artifact digests, the sample timings, native stages, navigation timing, requests and normalized profile summaries. Raw CPU profiles stay inside the disposable profile and are removed on teardown. Query strings, child arguments and child environments are not captured. Console reports use bounded lines and are flushed before budget assertions.

The startup discovery budget requires zero `/api/setup/cli-updates` requests before accepted input. The baseline budget is expected to fail; head must pass. A separate strict check retains the 1,000 ms end-to-end target, even when an incremental fix does not reach it. Mounted update-control tests also verify that opening Tools still performs an explicit read-only version check.

Local observer verification:

```sh
node --test scripts/bench/launch-stage-profile.test.mjs
```

On the disposable runner, with the pinned harness checkout and isolated release app:

```sh
node scripts/bench/native-launch-stages.mjs --harness=harness --app=head-app/o8.app --sha=<commit> --samples=3 --check-cli-startup --output=launch-head
node scripts/bench/check-launch-stage-receipt.mjs launch-head/stages.json --check
```
