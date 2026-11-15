# Native dictation drawing

Part of #6130. The default remains the web dock. In settings.toml:

    [experimental]
    native_dictation_pill = true

The equivalent operator-defaults field is nativeDictationPill. Set it to false
to restore web drawing. The existing server-owned native process must be running.
A standalone process without the existing parent pipe remains on the web fallback.
Runtime panel takeover is macOS-only in this PR; other platforms retain the web
fallback. Linux raster fixtures exercise the production renderer separately.
Use a session routed to the dock for acceptance; caret/HUD-routed sessions keep
their separate feedback surface, which has its own flag (native_dictation_hud,
see dictation-hud.md).

The dock continues receiving the original session-fenced STT events and owns the
same snapshot lifecycle, watchdog and completion timing. It prepares the native
window through the existing authenticated API and owned child pipe, commits its
hidden dictation render, then sends snapshots. Only preparation acknowledged by
a running native process suppresses web drawing. No listening port is added.
Only a session-correlated click-to-finish intent returns to the existing dock owner.
Audio, providers, paste and approval authority retain their existing owners.

The same panel also draws three dock capsules: speech playback, live voice and
agent working (batch 2). They use the same frame request, 500 ms deadline,
single in-flight request with latest-wins coalescing, session fallback, 750 ms
lease, quiet-mode release and 100 ms keep-alive cadence; no second channel,
listener or timer is added. A capsule frame carries `state` (`speaking`,
`working` or `voice`) and only what the capsule draws: `paused` and `speed`;
`tool` and `startedAt` (epoch ms, sent unchanged on every frame of the session);
or `connecting`. The working timer is computed natively from `startedAt`: the
visible 16 ms maintenance tick redraws when the shown second changes, and frames
never carry elapsed time. Each capsule session is numbered at its idle-to-active
edge (working uses its start time).

Capsule clicks are intents, not commands. The panel queues each click with the
capsule's session and state (at most 8 between frames) and returns them in the
reply to the next frame; the queue is cleared whenever the session or state
changes, on release and on lease expiry, and a hidden or expired capsule queues
nothing. The dock runs each reported click once, only if the hook still owns
the native panel, is not in quiet mode and the click names the session and
state on screen, calling the same handler the web control calls: pause and
resume `tts_toggle_pause`, stop `tts_stop`, speed `tts_set_speed`, working stop
`agent_interrupt`, live voice stop the `o8:realtime-toggle` emit (ignored while
connecting, as on the web). The API route forwards only well-formed intents.

Batch 3 adds the fleet capsule (the resting worker orbit and its expanded
worker/ready capsule, state `workers`), the live voice capsule's in-flight
worker count, and the edit/revert chip and glints drawn below the capsule
(native_pill_extras.rs). A frame may carry `edit` (`id`, `app`, `status`,
`until`), `glint` (`text`, `tone`, `fadeAt`, `until`) and `workers` (`count`,
`working`, `waiting`, `label`, `repos`), plus `expanded` for the fleet capsule.
Timestamps are epoch ms from the web timers that already dismiss these
surfaces, sent unchanged on every frame; the native panel hides the chip at
`until` and fades the glint from `fadeAt` to `until` on its own visible tick,
so no frame carries progress. A frame with only the chip and/or glint has the
state `extras`.

Static frames. `workers` and `extras` draw nothing that changes between events,
so they do not use the 100 ms keep-alive. Each carries `holdMs`, and the native
lease for that frame is `holdMs` clamped to 750 ms..5 s (staticMs in
pill-timing.json); every other state keeps the 750 ms lease and ignores it. A
static frame whose content ends inside 5 s (a glint, 4.8 s) is sent once and
retired by one release; one that outlasts it (the orbit, or a 20 s chip on its
own) is refreshed every 4 s. A content change (count, expansion, chip status, a
new glint) wakes the feed at once. Measured through the real hook with fake
timers: a lone glint is 1 frame and 1 release; a lone orbit is 15 to 16 frames
a minute (0.25 per second) instead of 600; a tap that expands it sends one
frame at once. The native loop is unchanged: it parks while hidden and ticks
every 16 ms while visible, which also keeps mouse pass-through current, so a
long-lived orbit keeps that tick running (see the #6145 CPU follow-up).

Visibility and an unknown flag. The fleet orbit or capsule and a chip or
glint with nothing above them show only when origin/main would show the web
dock for them: with the top-pill preference (dictation_top_pill), or while live
voice (or another visibility reason) keeps the dock up. Otherwise neither dock
draws them; beside any capsule or dictation they show as before. These static
states never start a request until a reply has said the flag is on. If the
startup probe times out, errors or returns a server error, they send nothing
(as with the flag off); the next dictation or capsule session retries the
preparation exactly as origin/main does, and once that reply says the flag is
on they may go native.

Clicks. The fleet capsule and orbit report `workers-expand`; the web runs the
same handler as its own sliver tap (show the capsule for 5 s, re-armed by
another tap; there is no collapse click on the web either). The chip reports
`revert` with the frame's session and state plus the chip's `edit` id; the web
runs the chip's own revert (`agent_edit_revert`) at most once per reply and
only while that chip is on screen and still offers Revert. The native side
queues one revert per chip until the web shows its next status. Both are
allow-listed in the API route and dropped, never replayed, on any mismatch,
fallback, quiet mode or expiry, like the batch 2 clicks.

Ask (#6145). The Ask conversation panel is drawn natively too
(native_pill_ask.rs), as state `ask`. The frame carries `ask`: `rev` (a number
that changes whenever the web thread changes), `listening` (the compact 248×40
capsule shown while the first question is heard), `turns` (the newest turns
that fit a 4.5 KB budget, each with its thread `index`, `role`, `text` and the
web's sources line), `pending` (an agent dictation that is a pending You turn
inside the open panel: `phase` and the live words), `working` (`tool` and
`startedAt` while the agent runs) and `copied` (the answer whose copy the web
just confirmed). Ask is interactive, so it keeps the 100 ms keep-alive and the
750 ms lease; it is not a static frame. The native window grows from 120 to
452 points for the 420×380 panel and the chip and glint rows below it.

Precedence is the shared order: Ask wins over everything except a real
dictation, a confirmation and a drop, and an agent dictation that is a pending
turn inside the open panel is drawn inside the native panel (with its level
bars), as on the web. A plain dictation over an open Ask hides Ask on both
surfaces, as the web dock does with the flag off (it was drawn beside native
dictation by the retained web dock before). While native draws Ask the web
dock draws no Ask panel, its window is neither shown nor expanded (the Ask
flow's own resize requests are routed through the native extent owner), and on
fallback the web panel returns expanded.

Ask clicks are intents named `ask-close`, `ask-copy` (with the answer's thread
index as `value`) and `ask-active` (pointer movement over the panel, at most
one per reply), each carrying the thread `rev` as `ref`. The web runs them only
for the Ask session on screen and only when `ref` is the thread it still shows;
a copy also needs that index to be an answer in the frame. Close runs the
page's own close (which still refuses while a turn is pending or the agent is
working); copy runs the panel's own clipboard write and shows Copied only after
it succeeds; activity re-arms the 45 s idle collapse as the web wrapper's
pointer movement does. A click on the panel body while the pending turn is
recording finishes that dictation through the existing finish channel, as the
web panel's body click does. The API route forwards an Ask intent only with a
numeric `ref`, and a copy only with an integer index.

Confirmation cards (#6145). The action or plan confirmation card is drawn
natively too (native_pill_confirm.rs), as state `confirm`, at the web card's
fixed 420×96 footprint with the review scrolling inside it and Cancel and
Allow (Run plan for a plan) pinned. The frame carries `confirm`: `id` (the
confirmation id), `task` (the task id), `kind` (`action` or `plan`),
`summary` (at most 1,500 bytes) and, for a plan, up to five `steps`. It is
interactive, so it keeps the 100 ms keep-alive and the 750 ms lease. Each card
is its own session (the session number changes with the card's identity), so a
decision queued for one card is cleared, never sent, when the next card
arrives. A real dictation holds the card back on both surfaces, as the web
dock does with the flag off (it was drawn beside native dictation by the
retained web dock before).

A click is a `confirm-allow` or `confirm-deny` intent carrying the exact card it
was drawn for (`ref` is the confirmation id, `task` the task id). The panel
queues at most one decision per card. The web runs the page's own decision
(`agent_confirm_exact`, which also clears the card) only while the frame on
screen names that same confirmation and task in the same session, and at most
one decision per reply; a click for a card that has changed, been dismissed or
expired does nothing. The API route forwards a decision only with a non-empty,
bounded, printable confirmation id and task id.

File drop and staged files (#6145). The drop target (state `drop`, 320×64,
Drop files for Symon / THEY RIDE YOUR NEXT QUESTION, accent ring) and the
staged-file chips (state `staged`, 420×56, at most three chips with the web's
size label and a `+N` chip, STAGED — HOLD ⌥ AND ASK) are drawn natively
(native_pill_drop.rs). The drag, the drop, reading and staging the files
(agent_files_stage) and the 6 s chip timer stay in the web dock: neither
native state takes clicks, so the panel stays mouse-transparent and drags
reach the web dock window under it. Both are static frames (no keep-alive
inside the 5 s hold, one refresh every 4 s after that); the staged session
changes with each new set of chips. They show only when origin/main would show
the web dock for them (the top-pill preference or another visibility reason),
which closes the batch 1 divergence where they showed without it, and a real
dictation, a confirmation or Ask holds them back on both surfaces as on the
web. There is no remove control: the web chips have none either.

With these, no dock surface is drawn by the retained web dock beside or in
place of a native frame; the web draws only on fallback, quiet mode or with
the flag off (and the idle sliver, below).

Releases now name the session and kind (dictation, speaking, working, voice, ask, confirm, drop or staged)
they retire, so a late fallback release can no longer hide a newer session that
is already drawn, including another kind with the same session number (closes
that #6145 item).

A reported click is dropped, never delayed or replayed, when the reply that
would carry it is a release, or arrives after the hook moved to a new
generation (a new session, kind or owner); it is also dropped on fallback,
quiet mode and lease expiry. When a frame is dropped (deadline), there can be a
window of up to the 500 ms request deadline with no capsule drawn before the
web capsule returns. When a still-web surface takes the dock, the web draws it
immediately and the native capsule hides when the immediate release lands, so
both can be visible for about one pipe round trip.
When a still-web surface takes the dock, the release is marked immediate and
the native capsule hides without the 160 ms exit fade.
For a static frame (fleet orbit, chip or glint) the same windows apply, except
that if both the frame and its fallback release are lost, the native panel can
stay up beside the web one until its hold ends (at most 5 s, the chip or glint
also at its own `until`), instead of 750 ms.

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
accepts clicks (and, in batch 2, the speaking, working and live capsules). AppKit orders it front without making it key, at the same level and
primary-screen notch offset as the web dock. Geometry is recomputed in logical
points while shown, including when displays change. The owner’s live quiet-mode event
(including temporary overrides) suppresses the native feed and retained web
controls; no resize request reasserts the web window during suppression.

The retained web window hosts the following surfaces. This is the follow-up
port order; source references name the current implementation.

| Surface | Source | Trigger | Shell commands | Disposition |
| --- | --- | --- | --- | --- |
| Dictation requesting/listening/levels, transcribing, polishing, done, error | src/app/dictation-pill/page.tsx:196; native/o8-next/src/native_pill.rs:1 | System STT events and existing session fence | Presentation API only; capture/finish stay with their existing owners | native (batch 1) |
| Edit/revert chip | src/app/dictation-pill/EditRevertChip.tsx:19; native/o8-next/src/native_pill_extras.rs:1 | edit-applied and edit-revert-settled; timed dismissal from `until` | agent_edit_revert, run by the web dock from a reported click | native (batch 3) |
| Action and plan confirmation cards | src/components/desktop/dictation/useAgentConfirmations.ts:47; src/components/desktop/dictation/DockNotchSurface.tsx:843; native/o8-next/src/native_pill_confirm.rs:1 | agent-confirm and agent-confirm-dismissed, exact confirmation/task identity | agent_confirm_exact, run by the web dock from a reported decision naming the exact card | native (#6145) |
| Ask conversation, pending user turn, answers, errors and sources | src/app/dictation-pill/page.tsx:530; src/components/desktop/dictation/DockAskPanel.tsx:214; native/o8-next/src/native_pill_ask.rs:1 | ask-open/answer/error and agent-task-event; pending agent dictation while panel is open; thread, timers and idle collapse stay in the web dock | close, copy (browser clipboard) and idle re-arm run by the web dock from reported `ask-*` intents | native (#6145) |
| Speech playback, pause, stop and speed | src/app/dictation-pill/page.tsx:399; native/o8-next/src/native_pill_capsules.rs:1 | tts-state playing/paused | tts_toggle_pause, tts_stop, tts_set_speed, run by the web dock from a reported click | native (batch 2) |
| Live voice presence and stop | src/app/dictation-pill/page.tsx:427; native/o8-next/src/native_pill_capsules.rs:1 | realtime-status connecting/live/off; safety timer stays in the web dock | Emits o8:realtime-toggle (dock-tap) from a reported click; no direct shell command | native (batch 2) |
| Agent working/synthesizing capsule, current tool and elapsed timer | src/app/dictation-pill/page.tsx:700; native/o8-next/src/native_pill_capsules.rs:1 | running task set and tool_call/done/failed task events stay in the web dock | agent_interrupt, run by the web dock from a reported click | native (batch 2) |
| File drop target and staged-file chips | src/components/desktop/dictation/useDockFileDrop.ts:33; src/app/dictation-pill/page.tsx:830; native/o8-next/src/native_pill_drop.rs:1 | drag/drop over the web dock window, staged chip timeout; both stay in the web dock | agent_files_stage, run by the web dock on drop (no click is reported) | native (#6145) |
| Worker orbit and expanded worker/ready capsule (and the live voice worker count) | src/app/dictation-pill/page.tsx:616; native/o8-next/src/native_pill_capsules.rs:1 | worker-status, parked-lanes-status and the stale-snapshot sweep stay in the web dock; idle tap reported as `workers-expand` | No direct action command | native (batch 3) |
| Memory/progress/task-result glints | src/app/dictation-pill/DockGlint.tsx:11; native/o8-next/src/native_pill_extras.rs:1 | agent-task-event glint/plan progress/handoff; fade from `fadeAt` to `until` | No direct action command | native (batch 3) |
| Idle sliver and Voice settings shortcut | src/app/dictation-pill/page.tsx:495,955; src/components/desktop/dictation/DockNotchSurface.tsx:783 | top-pill preference, resting dock double click | open_voice_settings | still web |
| Window hit testing, expanded geometry and presentation suppression | src/app/dictation-pill/page.tsx:855; src-tauri/src/dock_window.rs:366 | ResizeObserver, dock visibility, Ask open/close | dock_set_hit_rect, dock_set_expanded, presentation_quiet_mode_get; o8_dock_log instrumentation | still web |

## Dock precedence

The web dock draws one surface at a time. Its order, read from the
DockNotchSurface flags and body order and now shared by both docks through
src/components/desktop/dictation/dockPrecedence.ts, is:

1. Dictation (any non-idle state), except an agent dictation that is a pending
   turn inside the open Ask panel
2. Action or plan confirmation card
3. Ask conversation panel
4. File drop target
5. Speech playback (playing or paused)
6. Agent working
7. Staged-file chips
8. Worker detail capsule
9. Live voice (connecting or live)
10. Idle sliver

The native frame follows the same order: the Ask panel when Ask wins
(including a pending turn inside it), dictation when it is active, otherwise
the confirmation card, drop target or staged chips when they win, otherwise
the winning capsule (5, 6, 8 or 9). No surface in the order is still web. When nothing wins (10) and workers exist, the frame is the
resting fleet orbit; with no workers but a chip or glint, it is `extras`. While the native panel draws the winner, the web dock does not
draw speech, working or live voice under it; with a native capsule the web
notch surface is not drawn at all (the edit/revert chip and glints remain,
below the capsule). On fallback the web dock draws everything as before.
A test renders DockNotchSurface for every combination of these states and
checks it draws the surface the shared order names.

The edit/revert chip and glints are not in the order: the web draws them below
whatever the dock shows (chip first, then glint). They go with the dock
surface, so they are never drawn twice and never hidden by a surface they
belong under:

| Dock state | Drawn by | Chip and glint |
| --- | --- | --- |
| Dictation, nothing still-web beside it | native | native, below the dictation capsule |
| Speaking, working, live voice | native | native, below the capsule |
| Ask panel (or its listening capsule) | native | native, below the panel |
| Confirmation card | native | native, below the card |
| Drop target, staged chips (with the top-pill preference or another visibility reason) | native | native, below them |
| Fleet orbit or capsule | native | native, below it |
| Nothing (10) | native `extras` | native, alone at the capsule position |
| Flag off, fallback, quiet mode | web | web, as today |

While native, the web never draws the fleet orbit or capsule (native draws
them, or dictation hides them, as on the web); before batch 3 the web orbit
could show below native dictation. On origin/main the resting orbit is never
drawn alongside staged-file chips (they are earlier branches of the same body
chain), so staged chips are a handoff and the orbit returns natively after
them; a reference-test case checks both. When the native panel hands a glint
it was drawing back to the web (fallback), the native wiring marks it
explicitly and the web glint skips its fade-in; every other web glint,
including any with the flag off, enters exactly as on origin/main. The web chip
still replays its 0.3 s slide on a hand-back. The second sweep in
native-dock-capsules.test.ts states this rule without the helpers and checks
the frame state and the chip/glint owner for every combination.

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
| Speaking capsule | 280×40, radius 20, label, speed track, pause/resume and stop buttons | Speed is set by clicking one of 11 steps on the 58 pt track; dragging the knob is not ported. Theme surface instead of the frosted glass and blur |
| Working capsule | 248×40, radius 20, ring, Working…/Synthesizing…, elapsed timer; hover shows Stop | Static ring instead of the spinning orbit; hover swap needs the live check on a non-key panel |
| Live voice capsule | 268×40, radius 20, success dot and Voice live; ring and Connecting…; 348 wide with · ring · N working while live with workers in flight | No ambient waveform or pulsing dot |
| Fleet orbit (resting) | Only with the top-pill preference, as on the web; 128×16 sliver, ring (or warning dot when all are waiting), count (99+) and fleet/work/ready/waiting | Theme surface instead of the brand gradient; static ring; no hover tooltip |
| Fleet capsule (expanded) | 320×44, ring or dot, DockNotchSurface wording, repos dimmed; tap re-arms the 5 s timer | No hover tooltip; static ring |
| Edit/revert chip | 248×24 below the capsule (alone at the capsule position otherwise), Rewrote in App — Revert, Reverting…, Reverted, Original copied | Fixed width with truncation (the web chip sizes to its text); no enter slide |
| Glint | Below the chip, uppercase, tone colour from theme tokens, 0.5 s fade from `fadeAt`, gone at `until` | Theme surface instead of the dark gradient; no enter slide |
| Confirmation card | 420×96, radius 24; SYMON WANTS TO or SYMON’S PLAN, the summary or numbered steps scrolling, Cancel and Allow/Run plan pinned right | Theme surface instead of the frosted card; Allow uses the theme text colour as its fill |
| Drop target | 320×64, radius 24, two lines, accent border for the web's inset ring | Theme surface; a full accent border instead of the soft inset glow |
| Staged chips | 420×56, radius 22, up to three 22-high chips (name truncated at 150, size label) and +N | Theme surface |
| Ask listening | 248×40 capsule with the bars at rest | Static bars instead of the ambient gradient waveform |
| Ask panel | 420×380, radius 26; header (mark, Symon, close); scrolling thread of You/Symon turns, paragraphs and bullet/numbered items, sources line, Copy/Copied per answer; pending You turn (words or Listening…, level bars, Polishing…); pending Symon turn (ring, Working…/Synthesizing…, timer); follows the newest turn | Theme surface instead of the frosted panel; accent dot instead of the gradient mark; inline `code` and **bold** drawn as plain text; Copy always visible (the web shows it on hover); only the newest turns within 4.5 KB are scrollable; Escape does not close it (the panel never takes keyboard focus) |

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
while listening, speaking, working or live (not while connecting), sized to the
capsule on screen; other states and transparent margins remain click-through.
In batch 3 the fleet orbit and capsule take clicks at their footprint, and the
chip takes clicks at its 248×24 footprint below the capsule whatever its
status, as the web hit rectangle does; glints never take clicks.
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
6. Trigger an existing edit/revert flow to confirm its retained web
   controls appear without a second dictation waveform. Check each display
   arrangement, including changing the primary screen and a notched screen.
7. Speech playback: ask Symon something that is answered aloud. The native
   speaking capsule appears at the dock position with Speaking, the speed track
   and two buttons, and the web dock shows no second capsule. Click pause:
   speech pauses once and the label reads Paused; click again to resume. Click
   a speed step: the value label changes once and the next utterance uses it.
   Click stop: speech stops and the capsule retires. Keyboard focus stays in
   the front application throughout.
8. Hold Fn while speech plays: the native panel switches to dictation and back
   to the speaking capsule after the paste. Open an Ask answer while speech
   plays: the native panel switches to the Ask panel and no web panel shows.
9. Live voice: double-tap right Command. Connecting… shows natively and a click
   does nothing; once Voice live shows, one click ends the session through the
   main window and the capsule retires.
10. Agent working: give an agent instruction that runs a tool. Working… (or
    Synthesizing… for a Brain lookup) shows with a timer that counts seconds,
    then m:ss after a minute. Hover shows Stop; one click interrupts the task.
11. Toggle quiet mode during each capsule: it hides and returns on exit. Quit
    the native window process mid-capsule: the web capsule returns within
    about half a second and its controls work.
12. Fleet: start agent work that reports workers (or parked review lanes). The
    native orbit shows the count and fleet/work/ready at the dock position with
    no web sliver. Click it: the 320 capsule names the work and repos and
    returns to the orbit after 5 s; a second click inside that time keeps it.
    Start live voice while workers run: the voice capsule widens to 348 and
    shows N working.
13. Edit chip: run a voice edit that rewrites text in another app. The chip
    shows below whatever the dock shows (or alone) for 20 s. Click Revert once:
    the text is restored once, the chip reads Reverted and leaves after 1.8 s.
    Keyboard focus stays in that app. Open Ask (or hold Fn with Ask open) while
    the chip is up: the chip moves to the web below the Ask panel, never both.
14. Glint: trigger a memory glint or plan progress with nothing else showing.
    It shows alone, fades for half a second and is gone at about 4.8 s; repeat
    during speech and dictation to see it below the capsule.
15. Quit the native window process with each of steps 12 to 14 showing: the web
    orbit, chip or glint returns within about half a second.
16. Ask: hold Option and ask a question. The native compact capsule shows while
    it listens, then the 420×380 panel with You and Symon turns, and no web
    panel or second window appears. Move the pointer over the panel for more
    than 45 s: it stays open; leave it alone for 45 s: it closes. Click Copy on
    an answer: the answer is on the clipboard and the button reads Copied for
    about 1.4 s. Click the close button: the panel retires. Keyboard focus stays
    in the front application throughout.
17. With the panel open, hold Option and speak a follow-up: the pending You
    turn shows the words and level bars inside the native panel; click the
    panel to finish, or release. Polishing… shows, then the working row with a
    timer, then the answer, and the thread scrolls to it. Scroll the thread
    with the trackpad while the panel is not focused.
18. Quit the native window process with the panel open: the web panel returns
    expanded within about half a second and its controls work.
19. Confirmation: give an agent instruction that needs approval (an action, then
    a multi-step plan). The native card shows the summary (or numbered steps,
    scrolling if long) with Cancel and Allow (Run plan); no web card shows.
    Click Allow once: the action runs once and the card retires; repeat with
    Cancel. Click several times quickly: one decision. Hold Fn while a card is
    up: the card hides for the dictation and returns after it. Keyboard focus
    stays in the front application.
20. With a card up, trigger a second confirmation (or let the agent dismiss
    the first) and click immediately: nothing is decided for the old card.
    Quit the native window process with a card up: the web card returns within
    about half a second and its buttons work.
21. Drop: with the top-pill preference on, drag files from Finder over the
    dock. The native drop target shows with no web zone; drop four files: the
    native chips show three names with sizes and +1 for 6 s, and the next
    Option ask carries them. Drag again with the preference off: neither dock
    shows anything (as with the flag off). Hold Fn during a drag: dictation
    shows instead. Quit the native window process while chips show: the web
    chips return within the 4 s keep-alive plus half a second.
22. Set the flag false and repeat a dock-routed session and steps 7 to 21 to
    verify web behavior.

Gradient/shimmer, the squiggle loader and the spring geometry morph are follow-up
visual work; the distinct native states do not depend on those effects.
