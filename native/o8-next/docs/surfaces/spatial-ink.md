# Native spatial ink

Part of #6145. This is the draw-on-screen ink for agent holds: while the
operator holds the voice-agent key they can draw on the screen, and the strokes
ride the agent turn with a screenshot of the marked monitor. The default
remains the web overlay (`/spatial-ink` in the classic shell's transparent
window). In settings.toml:

    [experimental]
    native_spatial_ink = true

The equivalent operator-defaults field is nativeSpatialInk. It is independent
of native_dictation_pill and native_dictation_hud. The existing server-owned
native process must be running; without it the web overlay keeps every hold.
macOS only; other platforms reject ink controls and keep the web overlay. The
visual-capture drawing (Shift and pointer from the capture controls) is not
part of this port and stays on the web.

## Behaviour today (web overlay)

- Arm: the shell's agent-hold start (`begin_agent_dictation`) arms the ink
  window before the dock and HUD show: it sizes the window to the monitor under
  the cursor (falling back to the primary, then the first monitor), turns mouse
  capture on (not click-through) and orders it front without activating o8.
  Quiet mode blocks the arm. The page latches on the `system-start` event with
  `lane: agent`.
- Capture: pointer events (coalesced) become strokes of CSS-pixel points with
  `t` in milliseconds since the stroke began. On the first stroke the page
  emits `o8:spatial-ink-first-stroke` and the shell captures that monitor at
  full resolution. On the `final` STT event (the key was released and the
  recognizer finished) the page emits `o8:spatial-ink-strokes` with every
  stroke normalized to 0..1 of its viewport (clamped), the viewport size and
  scale. At finalize the shell burns the strokes into the capture and cuts a
  full-resolution crop of the marked region for the agent turn; with no stroke
  or no capture the turn is text only. The shell accepts at most 128 strokes
  and 8192 points.
- Drawing: an ember (`--t-brand-orange`) comet trail, tapered from its tail,
  thinning with speed, with a glow, a warm-white hot core and a pulsing head
  while drawing. Strokes hold for the whole utterance; at `final` they flash
  for 200 ms and fade over 600 ms. Reduced motion draws a thinner stroke with
  no glow, core, pulse or fade.
- Disarm: every shell teardown (finalize, discard of a too-short hold, error,
  cancel, idle) restores click-through and emits `o8:spatial-ink-clear`; the
  page also asks for a disarm on any terminal STT event; a 90 s timer from the
  arm disarms if nothing else did.
- Escape: the window is never key, so it gets no key events. The shell's
  event tap cancels a long-form agent hold (double tap) on Escape, which
  discards it and disarms; during an ordinary held hold Escape does not touch
  the ink, and the mouse stays captured until the hold finalizes.
- Key release: `end_agent_dictation` stops the recognizer; the `final` event
  hands the strokes off, but the window keeps capturing until finalize disarms
  it (after transcription and polish).
- Space switch: the window joins all Spaces and full-screen apps (stationary,
  out of the window cycle), so it stays over the cursor's monitor.
- Display change: the window keeps the monitor chosen at arm time for the
  hold; nothing re-places it mid-hold.

## Ownership with the flag on

The shell is unchanged except for two events. Each agent arm emits
`o8:spatial-ink-armed` to the page with the arm generation and the covered
monitor in top-left desktop points (the same division by scale the window
placement uses). The page then asks the native panel to arm on that monitor,
through the dock's route (`surface: "ink"`, the nativeSpatialInk flag read at
each arm), child pipe (`spatial-ink` frames), queue and loop.

- The web always starts the hold and owns the pointer until the panel
  acknowledges. The panel orders front at level 24 above the web window and
  acknowledges; the page then emits `o8:spatial-ink-pointer` with owner
  `native` and the shell makes the web window click-through for the rest of
  the hold (only for the current generation). From then on the page paints and
  captures nothing.
- If the operator had already started drawing on the web, the web keeps the
  hold; the panel is released at once and any points it caught are added to
  the web strokes.
- While native owns the hold, a keep-alive frame every 100 ms renews the
  panel's 750 ms lease and returns the points it captured since the last
  receipt, as `[stroke, x, y, t]` normalized to the covered monitor. The page
  keeps them and emits `o8:spatial-ink-first-stroke` with the first ones. At
  `final` it releases the panel with `handoff` (the panel stops capturing and
  plays the 200 ms flash and 600 ms fade itself), takes the remaining points
  from that reply, and emits `o8:spatial-ink-strokes` in exactly the web shape,
  so the shell's composite and the agent turn are unchanged.
- If a keep-alive misses its 350 ms deadline, or the panel answers anything
  but ok (lease lost, display gone, unknown session), the page takes the hold
  back: owner `web` (the web window captures again), the points received so far
  are painted on the web canvas and shipped at `final`, and an immediate
  release is sent. A page-side deadline plus a cadence (450 ms) is shorter than
  the panel's lease, so the web reclaims before the panel lets go; during that
  overlap the panel is on top and the only window receiving events.
- With the flag off, each hold sends one arm request that answers
  `enabled: false`; nothing else changes.

## Every disarm path

Each is sufficient on its own; the panel is click-through whenever it is not
armed, and is ordered out when hidden.

| Trigger | Where | Effect |
| --- | --- | --- |
| Key release | shell `final` → page release with `handoff` | Capture ends at once (earlier than the web overlay, which waits for finalize); flash and fade |
| Shell teardown or terminal STT event | `o8:spatial-ink-clear` / terminal event → page immediate release | Capture ends, panel hidden |
| Escape | the panel reads Escape from the HID state on each 16 ms tick while armed (a long-form hold's Escape also discards it in the shell, which then releases as a teardown) | Capture ends; strokes stay drawn, click-through, until release; they still ship at `final` |
| Lease | no frame for 750 ms | Capture ends, panel hidden; the next frame reports `lease` and the page takes over |
| Error | malformed or expired control, failed placement, lost window | Capture ends, panel hidden |
| Time bound | 90 s after arm, even with frames arriving | Capture ends, panel hidden; the page stops keep-alives and leaves nobody capturing |
| Display change | the covered monitor no longer matches a screen at the next placement | Capture ends, panel hidden |
| Main thread stall | a watchdog thread sees no loop tick for 3 s while capturing | The native process exits, taking the panel with it; the page falls back |

The shell's own 90 s safety disarm and its click-through restore are
unchanged, so the web window can never be left capturing either.

## Window posture

A nonactivating GPUI pop-up panel with the dock's class that refuses key and
main, level 24 (below the dock and HUD at 25, as the web window), not hidden on
deactivate, and CanJoinAllSpaces | Stationary | IgnoresCycle |
FullScreenAuxiliary. It accepts the first mouse down without activating the
app, so keyboard focus and the held key stay with the operator's app. It
covers the AppKit frame of the screen that matches the shell's monitor (the
screen overlapping at least half of it), so negative origins and mixed scale
factors place it exactly; points are normalized to that frame. It does not
keep the native shell alive.

## Drawing and frames

Strokes are streamlined, tapered from the tail and thinned with speed, then
filled as outlines (non-zero, in chunks of 256 points) in four passes: two
soft ember halos standing in for the web glow, the 6 px ember body and the
2.2 px hot core; taps draw as dots and the live head pulses. Colours come from
`theme::ink_ember` and `theme::ink_core`. A frame builds a few paths per stroke
and no layout. The panel requests animation frames only while a stroke is
being drawn (the head pulse) or during the handoff fade; an armed panel at
rest, a held panel and a hidden panel request none, and the loop's 16 ms
maintenance tick runs only while the panel is on screen.

## Parity gaps

| Web overlay | Native | Gap |
| --- | --- | --- |
| perfect-freehand outline with simulated pressure | Same parameters approximated (streamline 0.45, thinning 0.4, eased start taper) | Outline shape differs slightly |
| 11 px canvas shadow blur glow | Two translucent halos | No true blur |
| Radial-gradient head pulse | Three concentric dots | Banded rather than smooth |
| Crosshair cursor over the window | Crosshair while armed | Needs a live check that a non-key panel shows it |
| Escape does nothing | Escape releases the pointer | New escape hatch, native only |
| Capture lasts until finalize | Capture ends at `final` | Native frees the mouse sooner |

## Tests

- native_ink_tests.rs: arm and refused arms; every disarm trigger (release,
  handoff with flash and fade, Escape with strokes kept, lease while drawing
  and while held, the 90 s bound with frames still arriving, error, display);
  stale sessions; normalization, order, clamping, repeat dropping, the reply
  page size and the 128-stroke and 8192-point caps; AppKit conversion with
  negative origins, a display above, an unplugged display and no screens; no
  frame requests at rest, held or hidden; outline taper and caps; the watchdog
  threshold; the shared timing file; and an off-screen draw through arm,
  drawing, fade and hidden.
- nativeInkFeed.test.ts: arm, pointer handover, points relayed in order with
  one first-stroke, all strokes returned at `final`; flag off or no answer
  stays web; a missed deadline and a lost lease give the hold back with every
  point; Escape keeps native drawing; the bound leaves nobody capturing; web
  ink before the acknowledgement keeps the web owner; a teardown during the arm
  never hands over the pointer.
- page-native.test.ts: the real event order (armed, start, pointer, frames,
  `final`, idle, clear) emits the same strokes payload; flag off draws on the
  web with one request; no acknowledgement keeps the web; a lost keep-alive
  hands the hold back and ships both surfaces' strokes.
- route.test.ts: the ink uses only its own flag and frame type, reads it at
  arm, validates requests and points.
- spatial_ink_window.rs: the armed monitor in desktop points for 1x and 2x
  displays and negative origins.

## Live acceptance

Run these on a Mac with two displays of different scale, one left of or above
the primary.

1. Use a build from this branch with the server-owned native window process
   running. Set native_spatial_ink = true (no restart: the next hold reads it).
2. Focus a text editor in another app. Hold Right-Option, draw a circle and
   speak, release. The ink appears under the pointer with no lag, no second
   copy and no web ink; keyboard focus and the caret stay in the editor; the
   strokes flash and fade at release; the agent turn shows the circle in its
   image at the right place.
3. Repeat with the cursor on the secondary display, and with the secondary as
   the arm display while o8 is on the primary: the ink covers the cursor's
   display and the composite marks the right spot.
4. Repeat in a full-screen app and after switching Spaces mid-hold.
5. Stuck-capture checks, each from a fresh hold, each followed by clicking a
   window under the ink to confirm the click lands:
   - release the key mid-stroke (button still down);
   - press Escape mid-hold: drawing stops, the ink stays, clicks pass through;
     release the key and the turn still carries the strokes (this also checks
     that the native process can read the key state without its own Input
     Monitoring grant; if it cannot, Escape has no effect and the other paths
     still apply);
   - quit the native window process mid-hold: the web overlay takes over
     within about half a second and drawing continues there;
   - unplug the covered display mid-hold;
   - hold for over 90 s: capture ends;
   - turn quiet mode on before a hold: neither surface arms.
6. Draw immediately on key down (before the panel can answer): the stroke
   completes on the web and the hold stays on the web.
7. With Reduce motion on: thin strokes, no glow or fade.
8. Watch CPU with the panel armed and idle, and while drawing.
9. Set the flag false and repeat step 2 to confirm the web overlay is unchanged.
