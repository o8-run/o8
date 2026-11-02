---
name: o8-checks
description: Choose or run verification for code, process seams, authorization, persistence, or documentation changes.
---

# Verification

- Every code change runs `npm run typecheck:fast` and the hermetic `npm test` completion gate.
  `typecheck:fast` falls back to tsc 5.8 on Intel Macs and Windows.
  Use `npm run typecheck:tsc` for the slower cross-check. Run the smallest relevant tests while
  iterating, and use integration or Rust tests when the changed boundary requires them. Docs-only
  changes validate links and the affected documentation checks.

- New cross-process seams, prompt-taught arguments, persistence paths, and principal or authorization
  changes need a test through the real entry point and persisted state. Helper-only tests are not
  reachability proof.

- Run `npm run rule-check -- --base=<ref>` for changed TypeScript or TSX and ESLint only on touched
  files. Read `.github/workflows/ci.yml` before describing current CI.

## Local CI parity

Run `npm run verify:ci` before pushing to execute the local CI checks. Use Node 22,
the npm version in `packageManager`, installed dependencies, and `bash` and `cargo-audit` on `PATH`
(install with `cargo install cargo-audit --locked`). Public dependency audits need network
access but no account credentials.

The command reads `.github/workflows/ci.yml` for Type Check, Lint, Test Classification,
all Hermetic Unit Tests shards, Server Bundle Size, Integration Tests (changed files),
Governance Smoke, and Security Audit. Fetch `origin/main` before running. Changed
integration files use CI's merge-base selector, including staged, unstaged and untracked
classified tests locally, and the same integration configuration and baseline as CI.
Install `ripgrep` and the system secure-shell tools for resource-owning tests.
Linux CI restores prerequisite `.deb` archives for Rust and resource tests using
the package definitions, installer version, architecture and exact runner image
version. Every run refreshes signed APT indexes and verifies cached bytes against
the exact package/version/architecture SHA256 before normal APT installation.
Missing, stale or damaged payloads are downloaded by APT. Only main saves shared
caches; authenticated archive revisions keep later security updates reusable.
This privileged runner setup is
explicitly hosted in the coverage guard; local verification uses the installed
system prerequisites. The package-cache proof workflow transfers a short-lived
archive directory between fresh containers on one hosted runner to measure miss
and authenticated hit behavior against an identical base image, without allowing
a PR to save the shared cache.
Browser tests declare Chromium through their runtime import, or a first-line
`// @o8-test-browser` marker for an indirect launcher. Classification generates
`browser: true`; CI and local verification select the prerequisite from that same
metadata. Adding a browser test does not require editing the workflow or verifier.
Both coverage and classification guards trace runtime imports, called exports and
Node script launches. An indirect browser launcher requires the first-line marker;
the refusal names its test and the marker to add. A file-wide mocked launch does
not require a browser, while restoring the real launch restores the prerequisite.
The coverage guard also rejects browser flags that disagree with the source.
It sets `CI=true`, uses the CI test configuration and environment, gives type checking
an 8192 MiB heap, and runs the smoke in a fresh temporary data directory with its CI
timeout. Each check prints PASS or FAIL under its CI name; any failed command makes
the final exit status non-zero. Audit failures also block CI.
Independent checks run concurrently; governance waits for Type Check. Vitest commands
share one local execution queue so their module caches and worker pools do not collide.

Dependency changes use the same credential-free lockfile audit in CI and locally:
added package versions fail at low severity, while unchanged baseline findings remain
the responsibility of the full audits. Nested package and native lockfiles are included.
The o8 next Native Tests (Linux) check also runs on Linux x64, using CI's locked
Cargo build for the HTTP fixture daemon and all four headless suite shards. CI runs
the shards on separate jobs; local verification runs them serially against one Cargo
target cache, retaining every discovered test exactly once. Each native shard shares
CI's combined daemon-build/test deadline. Native
fixed-rate terminal probes run without sibling native tests and share the local
Vitest execution queue, retaining their original byte and time bounds. Local queue
waiting pauses the native job clock, matching CI's independent runners. Native
build/cache outputs are excluded from lint and type checking; source fixtures remain checked. Install
the system prerequisites listed in `scripts/ci/install-native-linux-deps.sh` and
the stable Rust toolchain. Its selector compares against `origin/main` and includes
committed, staged, unstaged and untracked native inputs. The selector derives fixture
inputs from native source file references, transitive host imports and discovered
fixture directories; deleting an input also selects the suite. Headless CI installs
only missing compile prerequisites, leaving capture tools and drivers to graphical jobs.
A TS-only change outside that dependency closure prints SKIP
and runs no native build. Other platforms print HOSTED with the Linux x64 requirement.
Hosted reporting, other native target builds and weekly integration lanes remain hosted
checks. The CI coverage guard rejects an unclassified
job or an unsupported action in a local check. Update the local implementation or its
explicit hosted classification whenever CI changes; unknown checks never silently pass.
