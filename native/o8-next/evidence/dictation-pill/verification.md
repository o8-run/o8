# Dictation pill verification

Part of #6130.

The original drawing test attempted to render the root from inside that root's
entity update. GPUI needed another lease of Pill to render it. Native
setFrame/display presentation was also inside a typed WindowHandle<Pill>
update, which could synchronously request a draw under the same model lease.
State events now defer on the window/App context. Model updates return their
lease before drawing or native presentation. The timer uses an untyped window
handle and returns the model lease before AppKit calls.

Removing the deferred boundary reproduces the original panic:

    cannot update o8_next::native_pill::Pill while it is already being updated
    test result: FAILED. 0 passed; 1 failed

The production deferred boundary was restored afterward.
The regression injects a state event while Pill is mid-update, asserts that
state application and its receipt wait until the outer update returns, and
draws the updated root. The state, feed-expiry, placement, real parent-pipe and
one-shot session-scoped finish guards also pass.

## macOS receipts

    cargo check --locked --manifest-path native/o8-next/Cargo.toml --bin o8-next
    Finished `dev` profile [optimized + debuginfo] target(s) in 7.84s

    cargo test --locked --manifest-path native/o8-next/Cargo.toml --bin o8-next native_pill::tests -- --nocapture --test-threads=1
    Finished `test` profile [optimized + debuginfo] target(s) in 5m 02s
    test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 1426 filtered out; finished in 0.06s

The commands used the required isolated target directory and compile wrapper.
No src-tauri files changed, so its macOS Cargo check is not applicable.
No visible desktop window or simulated OS input was used.

## Linux receipts

Fast type checking, touched-file ESLint and 28 focused tests passed. Coverage
includes web/native exclusivity across dictation states, retained edit/revert,
stale finish rejection, the existing finish handler and presentation suppression.
Seven production GPUI rasters were captured on a private Xvfb display with
software Vulkan: idle, requesting microphone, listening, transcribing, polishing,
done and error. Each has a distinct SHA-256 digest. The capture script verifies
PNG output and waits for painted content; no OS input is injected.
Full verify:ci could not start because the machine-wide verification lease
was held. Its queued launcher was withdrawn before any checks started under
the two-failure stop rule. This completion gate remains outstanding.

## Acceptance boundary

The panel's application-owned subclass refuses key/main window status and
inherits the toolkit's nonactivating NSPanel and first-mouse delivery. Native
model tests do not establish physical keyboard focus or paste behavior. The
lead performs that check in the existing development window using the steps in
the surface guide. Gradient/shimmer, the squiggle loader and spring geometry
are follow-up visuals.

## WIP stop receipt

The repository rule check failed twice on the existing oversized defaults file.
The first result reported page growth to 1022 lines and defaults growth to 1318.
The correction extracted the native dock-extent hook and shared idle snapshot,
bringing the page to 1004 lines. The local defaults file was restored to its
1316-line baseline, but it was missing from the remote sync list: the second
run still examined the earlier 1318-line copy and failed the same guard.

    src/lib/operator/defaults.ts
    [file-ceiling] File grew to 1318 lines (was 1316, max 800).

The final local correction is preserved, but there is no passing post-correction
rule-check receipt. This remains a draft under the two-failure stop rule.
