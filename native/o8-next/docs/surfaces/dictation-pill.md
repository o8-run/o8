# Native dictation drawing

Part of #6130. The default remains the web dock. In settings.toml:

    [experimental]
    native_dictation_pill = true

The equivalent operator-defaults field is nativeDictationPill. Set it to false
to restore web drawing. The existing server-owned native process must be running.
A standalone process without the existing parent pipe remains on the web fallback.\nUse a session routed to the dock for acceptance; caret/HUD-routed sessions retain\ntheir separate feedback owner until that surface is ported.

The dock continues receiving the original session-fenced STT events and owns the
same snapshot lifecycle, watchdog and completion timing. It prepares the native
window through the existing authenticated API and owned child pipe, commits its
hidden dictation render, then sends snapshots. Only preparation acknowledged by
a running native process suppresses web drawing. No listening port is added.
No audio, provider, paste, approval or capture authority crosses this path.

A stalled feed expires after 750 ms and exits over 160 ms. Web fallback waits
one second after an unconfirmed response before drawing again. Unknown states
never become visible. The native window is a click-through nonactivating GPUI
popup. AppKit orders it front without making it key, at the same level and
primary-screen notch offset as the web dock. Geometry is recomputed in logical
points while shown, including when displays change.

The retained web window hosts the following surfaces. This is the follow-up
port order; source references name the current implementation.

| Surface | Source | Trigger | Shell commands | Disposition |
| --- | --- | --- | --- | --- |
| Dictation requesting/listening/levels, transcribing, polishing, done, error | src/app/dictation-pill/page.tsx:205; native/o8-next/src/native_pill.rs:1 | System STT events and existing session fence | Presentation API only; capture/finish stay with their existing owners | native in this PR |
| Edit/revert chip | src/app/dictation-pill/EditRevertChip.tsx:25 | edit-applied and edit-revert-settled; timed dismissal | agent_edit_revert | still web |
| Action and plan confirmation cards | src/components/desktop/dictation/useAgentConfirmations.ts:47; src/components/desktop/dictation/DockNotchSurface.tsx:843 | agent-confirm and agent-confirm-dismissed, exact confirmation/task identity | agent_confirm_exact | still web |
| Ask conversation, pending user turn, answers, errors and sources | src/app/dictation-pill/page.tsx:539; src/components/desktop/dictation/DockAskPanel.tsx:214 | ask-open/answer/error and agent-task-event; pending agent dictation while panel is open | dock_set_expanded; agent_interrupt via shared stop control; clipboard copy and source links use browser APIs | still web |
| Speech playback, pause, stop and speed | src/app/dictation-pill/page.tsx:408; src/components/desktop/dictation/DockNotchSurface.tsx:568 | tts-state playing/paused | tts_toggle_pause, tts_stop, tts_set_speed | still web |
| Live voice presence and stop | src/app/dictation-pill/page.tsx:436 | realtime-status connecting/live/off; safety timer | Emits o8:realtime-toggle (dock-tap); no direct shell command | still web |
| Agent working/synthesizing capsule, current tool and elapsed timer | src/app/dictation-pill/page.tsx:709; src/components/desktop/dictation/DockNotchSurface.tsx:972 | running task set and tool_call/done/failed task events | agent_interrupt | still web |
| File drop target and staged-file chips | src/components/desktop/dictation/useDockFileDrop.ts:33; src/app/dictation-pill/page.tsx:839 | drag/drop over dock, staged chip timeout | agent_files_stage | still web |
| Worker orbit and expanded worker/ready capsule | src/app/dictation-pill/page.tsx:647; src/components/desktop/dictation/DockNotchSurface.tsx:1304 | worker-status, parked-lanes-status; idle tap; stale-snapshot expiry | No direct action command | still web |
| Memory/progress/task-result glints | src/app/dictation-pill/page.tsx:623; src/app/dictation-pill/DockGlint.tsx:9 | agent-task-event glint/plan progress/handoff, timed fade | No direct action command | still web |
| Idle sliver and Voice settings shortcut | src/app/dictation-pill/page.tsx:504,963; src/components/desktop/dictation/DockNotchSurface.tsx:783 | top-pill preference, resting dock double click | open_voice_settings | still web |
| Window hit testing and expanded geometry | src/app/dictation-pill/page.tsx:867; src-tauri/src/dock_window.rs:366 | ResizeObserver, dock visibility, Ask open/close | dock_set_hit_rect, dock_set_expanded; o8_dock_log instrumentation | still web |

When native owns dictation, the web snapshot is idle and its pending dictation
waveform is suppressed. Other controls can still make the web dock visible.
The idle sliver alone does not make it visible under native ownership.

| Web behavior | Native counterpart | Remaining difference |
| --- | --- | --- |
| Idle | Hidden | No persistent idle sliver for dictation |
| Requesting microphone | Connecting label | No browser microphone prompt changes |
| Listening | Live level bars and timer | Native theme accent; original gradient/shimmer and click-to-finish are not reproduced; Fn release still finishes |
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
