# Native dictation drawing

Part of #6130. The default remains the web dock. In settings.toml:

    [experimental]
    native_dictation_pill = true

The equivalent operator-defaults field is nativeDictationPill. Set it to false
to restore web drawing. The existing server-owned native process must be running.
A standalone process without the existing parent pipe remains on the web fallback.
Runtime panel takeover is macOS-only in this PR; other platforms retain the web
fallback. Linux raster fixtures exercise the production renderer separately.
Use a session routed to the dock for acceptance; caret/HUD-routed sessions retain
their separate feedback owner until that surface is ported.

The dock continues receiving the original session-fenced STT events and owns the
same snapshot lifecycle, watchdog and completion timing. It prepares the native
window through the existing authenticated API and owned child pipe, commits its
hidden dictation render, then sends snapshots. Only preparation acknowledged by
a running native process suppresses web drawing. No listening port is added.
Only a session-correlated click-to-finish intent returns to the existing dock owner.
Audio, providers, paste and approval authority retain their existing owners.

The dock reads the flag once at mount. A disabled dock adds one HTTP probe,
no per-session probes, and no native quiet-mode listener or read. Enabling the
flag requires reopening the dock. Enabled sessions check settings and liveness;
a failed session keeps web ownership until the next session's short preparation.
Idle ownership sends no traffic. Active feeds wait 100 ms after a reply, at most
10 frames per second. Quiet mode sends one release, pauses frames and resumes on
exit. The native loop parks while hidden and ticks every 16 ms while visible.
Unsupported platforms reject frames immediately. The panel does not keep the
shell alive after the last real window closes.

Requests carry an absolute deadline of 500 ms; the pipe caps it at 450 ms.
The unchanged native lease is 750 ms, so cadence plus the request deadline is
600 ms, leaving 150 ms before expiry. Timeout or failure restores web ownership
with zero added delay and sends a best-effort release. Native expiry hides even
an active last frame immediately, without the 160 ms normal exit animation.
If release is lost, a responsive native loop hides by the 750 ms lease plus one
16 ms maintenance tick. A native main thread hung with a frame already on screen
cannot be hidden by web code: the compositor can retain it until that thread
recovers (then expiry runs) or the process exits. There is no finite wall-clock
bound during that hang. Window class/configuration is installed once; geometry
changes alone set the frame, without forced display, and only show transitions
order the panel front. Invalid window delivery returns an error immediately and
clears the handle so a later request can recreate it. Unknown states
never become visible. The native window is a nonactivating GPUI popup; only its listening capsule
accepts clicks. AppKit orders it front without making it key, at the same level and
primary-screen notch offset as the web dock. Geometry is recomputed in logical
points while shown, including when displays change. The owner’s live quiet-mode event
(including temporary overrides) suppresses the native feed and retained web
controls; no resize request reasserts the web window during suppression.

The retained web window hosts the following surfaces. This is the follow-up
port order; source references name the current implementation.

| Surface | Source | Trigger | Shell commands | Disposition |
| --- | --- | --- | --- | --- |
| Dictation requesting/listening/levels, transcribing, polishing, done, error | src/app/dictation-pill/page.tsx:196; native/o8-next/src/native_pill.rs:1 | System STT events and existing session fence | Presentation API only; capture/finish stay with their existing owners | native in this PR |
| Edit/revert chip | src/app/dictation-pill/EditRevertChip.tsx:25 | edit-applied and edit-revert-settled; timed dismissal | agent_edit_revert | still web |
| Action and plan confirmation cards | src/components/desktop/dictation/useAgentConfirmations.ts:47; src/components/desktop/dictation/DockNotchSurface.tsx:843 | agent-confirm and agent-confirm-dismissed, exact confirmation/task identity | agent_confirm_exact | still web |
| Ask conversation, pending user turn, answers, errors and sources | src/app/dictation-pill/page.tsx:530; src/components/desktop/dictation/DockAskPanel.tsx:214 | ask-open/answer/error and agent-task-event; pending agent dictation while panel is open | dock_set_expanded; agent_interrupt via shared stop control; clipboard copy and source links use browser APIs | still web |
| Speech playback, pause, stop and speed | src/app/dictation-pill/page.tsx:399; src/components/desktop/dictation/DockNotchSurface.tsx:568 | tts-state playing/paused | tts_toggle_pause, tts_stop, tts_set_speed | still web |
| Live voice presence and stop | src/app/dictation-pill/page.tsx:427 | realtime-status connecting/live/off; safety timer | Emits o8:realtime-toggle (dock-tap); no direct shell command | still web |
| Agent working/synthesizing capsule, current tool and elapsed timer | src/app/dictation-pill/page.tsx:700; src/components/desktop/dictation/DockNotchSurface.tsx:972 | running task set and tool_call/done/failed task events | agent_interrupt | still web |
| File drop target and staged-file chips | src/components/desktop/dictation/useDockFileDrop.ts:33; src/app/dictation-pill/page.tsx:830 | drag/drop over dock, staged chip timeout | agent_files_stage | still web |
| Worker orbit and expanded worker/ready capsule | src/app/dictation-pill/page.tsx:638; src/components/desktop/dictation/DockNotchSurface.tsx:1304 | worker-status, parked-lanes-status; idle tap; stale-snapshot expiry | No direct action command | still web |
| Memory/progress/task-result glints | src/app/dictation-pill/page.tsx:614; src/app/dictation-pill/DockGlint.tsx:9 | agent-task-event glint/plan progress/handoff, timed fade | No direct action command | still web |
| Idle sliver and Voice settings shortcut | src/app/dictation-pill/page.tsx:495,955; src/components/desktop/dictation/DockNotchSurface.tsx:783 | top-pill preference, resting dock double click | open_voice_settings | still web |
| Window hit testing, expanded geometry and presentation suppression | src/app/dictation-pill/page.tsx:855; src-tauri/src/dock_window.rs:366 | ResizeObserver, dock visibility, Ask open/close | dock_set_hit_rect, dock_set_expanded, presentation_quiet_mode_get; o8_dock_log instrumentation | still web |

When native owns dictation, the web snapshot is idle and its pending dictation
waveform is suppressed. Other controls can still make the web dock visible. While native dictation is
painted, retained web controls move below its capsule and use the existing
expanded window extent so the edit/revert chip and Ask controls are not occluded.
The idle sliver alone does not make it visible under native ownership.

| Web behavior | Native counterpart | Remaining difference |
| --- | --- | --- |
| Idle | Hidden | No persistent idle sliver for dictation |
| Requesting microphone | Connecting label | No browser microphone prompt changes |
| Listening | Live level bars and timer | Native theme accent and nonactivating click-to-finish; original gradient/shimmer remains a follow-up |
| Transcribing | Transcribing label | Squiggle loader remains unmatched |
| Polishing | Polishing label | Squiggle loader remains unmatched |
| Done | Pasted text, falling back to Pasted | Existing web completion timeout drives retirement |
| Error | Bounded error label | Existing web error timeout drives retirement |
| Enter/exit | 160 ms interruptible native ease-out; full-size opacity | No web spring geometry morph |
| Placement | Primary-screen top center in points, safe-area inset plus notch gap | Physical display/focus acceptance remains for the lead |
| Edit/revert | Retained web chip | Ported separately |

Raster fixtures use the production Pill renderer under an isolated Linux Xvfb
display, matching the repository's parity capture approach. They establish
raster appearance, not macOS focus retention, compositor behavior, microphone
permission or actual paste acceptance. No visible desktop window or simulated
input is required for the targeted model/pipe tests.


## Re-entrant update correction

The original test called window.draw while Pill was leased by Entity::update.
Drawing renders the root, requiring a second lease of that entity. Native
setFrame/display presentation was also inside a typed WindowHandle<Pill>::update,
so synchronous AppKit drawing could reach the same problem. Rendering and native
presentation now run with the model lease returned. State ingress always defers
on the window/App context; its regression injects a state event inside a Pill
update, checks that application and acknowledgement wait until the outer update
returns, then draws the updated state. Notifications only enqueue effects.

The app-owned panel class overrides canBecomeKeyWindow and canBecomeMainWindow
to return NO. GPUI's existing nonactivating PopUp panel and acceptsFirstMouse
implementation remain unchanged. Only the capsule hit rectangle takes clicks
while listening; other states and transparent margins remain click-through.
Physical focus retention is reserved for the lead's live check.

## Live acceptance

1. Use a binary built from this branch in the existing server-owned development
   window. Its parent pipe must be bound; a standalone CLI window falls back.
2. Set native_dictation_pill = true in the experimental section of settings.toml.
   In Voice Settings > Settings > Live dictation, select Off
   (dictation_partials_surface = off) for a dock-routed test; caret and HUD feedback remain separate surfaces.
3. Focus an editable field in another application. Hold Fn and speak to check
   listening, the level bars and timer. Release Fn to check transcribing,
   polishing, pasted words and retirement to hidden idle.
4. Start another hold and click the native capsule before releasing Fn. It
   should finish through the existing owner and paste into the original field
   without the keyboard focus changing to o8.
5. Deny microphone access through the system permission settings, then start
   a fresh dictation to check the error state. Restore that permission afterward.
   Transcribing and polishing can be brief for short speech; the attached
   deterministic captures cover every distinct state.
6. Trigger an existing Ask or edit/revert flow to confirm its retained web
   controls appear without a second dictation waveform. Check each display
   arrangement, including changing the primary screen and a notched screen.
7. Set the flag false and repeat a dock-routed session to verify web behavior.

Gradient/shimmer, the squiggle loader and the spring geometry morph are follow-up
visual work; the distinct native states do not depend on those effects.
