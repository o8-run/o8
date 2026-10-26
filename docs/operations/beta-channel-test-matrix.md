# Beta boundary acceptance matrix

Baseline: origin/main at `0dbed62fc`. Promotion is tracked separately in #4857.
The five acceptance rows were written and run before implementation. Public,
precomputed signature fixtures contain no private key; tests only copy and
verify them. Tests never sign, notarize or publish.

| Acceptance | Entry-point tests written red first | Required result |
| --- | --- | --- |
| 1. Artifact-bound publication | `artifact-channel-publication-real-path`: interrupted beta retry, stable environment, changed sidecar, tampered archive | Authenticate embedded identity before publication; beta cannot write stable or fixed manifests |
| 2. Symmetric identity | `stable_refuses_beta_identity_on_primary_and_fallback` | Stable refuses a higher beta manifest from either endpoint |
| 3. Result order | `A3: a late beta failure cannot overwrite a newer stable result through the real state route` | Older completion cannot replace newer state |
| 4. Stable guard parity | `A4: a stable artifact still runs the stable archive guard regardless of beta environment` | Stable archive guard still rejects an invalid bundle; no beta exemptions |
| 5. No downgrade | `enrollment_persists_and_returning_to_stable_never_downgrades` | Persist enrollment, switch back, execute manual and launch checks, retain the newer installed version |

## Recorded red tails

On unchanged main, the initial publication and ordering matrix reported:

```text
Test Files  2 failed (2)
Tests       7 failed (7)
```

The initial native matrix reported:

```text
stable_refuses_beta_identity_on_primary_and_fallback ... FAILED
enrollment_persists_and_returning_to_stable_never_downgrades ... FAILED
test result: FAILED. 0 passed; 2 failed
```

Additional red-first regressions covered a primary returning current before a
newer beta mirror, a superseded native launch failure emitting a clear event,
beta dry-run writes, a rolling feed anchored to latest stable, the preview
clobber guard, unauthenticated Linux installers (both real publishers returned
success), and a newer mirror feed refusing after primary publication had begun.
Their recorded tails were one failed test per case, except the
two installer publisher cases and the Linux matrix (13 failed, 3 passed).

## Green entry-point coverage

`tests/artifact-channel-publication-real-path.test.ts` executes the real ship,
stable and beta publisher commands with provider and platform edges replaced.
It covers signed identity, interruption retries with omitted or misleading
environment settings, tampering, stable guard parity, beta dry-run isolation,
independent beta anchors, both Linux installer refusals and all-destination
preflight. Its tail is `13 passed`.

`tests/linux-build-channel-boundary-real-path.test.ts` executes the real Linux
signature-completion command using precomputed public signatures. It verifies
identity before extraction, never executes the AppImage, rejects ambiguous or
invalid filesystem offsets, preserves platform entries, refuses mixed feeds
before writes, and leaves newer rolling beta versions unchanged. Its tail is
`20 passed`. Extractor and signer process edges are fixtures; these tests do not
establish acceptance of an installed Linux build.

`tests/update-channel-order-real-path.test.ts` exercises the real check client,
state route and UpdateCard. It covers late successes and failures, queued native
events, other windows, clock reversal and untagged reports. The manual-route cases also call the real
`checkAppUpdates` hub and require an incomplete result for a discarded request,
so suppression cannot falsely report current. Those two cases first failed
with `failed`/`available` replacing `current`, then failed with
`incomplete: false`. The final ordering file reports `9 passed`; the broader
focused updater/publication run reports `11 files / 83 passed`.

The native fixture compiles production `src-tauri` updater, launch and scheduler
modules and invokes their real commands against a loopback manifest service.
`cargo test --manifest-path tests/fixtures/update-ping-native/Cargo.toml update_ping`
now reports `9 passed`, including `beta_uses_the_newer_beta_or_stable_candidate`.
The whole native fixture reports `33 passed`. The desktop `cargo check` gate
also compiles the production application; it uses an environment-only empty
resource overlay because source verification does not build packaged resources.

Existing stable/preview publication guards remain covered by
`tests/release-channel-real-path.test.ts`: `47 passed, 1 skipped` (the existing
platform-only case). That suite also uses precomputed public signatures and
runs the real published-ancestor calculation.

## Scope

The unchanged preflight descendant-cleanup tests require a functioning child
reaper in the test container; a temporary parent reaper supplies that execution
capability without modifying repository code. All five cases pass under it.

Full TypeScript, fast typecheck, test classification, touched-file lint, rule
checks and the full hermetic suite are completion gates. No tag, signing,
notarization, release publication, promotion or installed-app acceptance is
performed by this matrix. #4813 remains a draft.
