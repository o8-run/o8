# Native dictation HUD

Part of #6145. This is the caret-local dictation feedback (or the saved legacy
bottom-centre HUD): listening with measured levels, processing, the delivered
text held briefly, dismissal and errors. The default remains the web HUD
(`/agent-partials`). In settings.toml:

    [experimental]
    native_dictation_hud = true

The equivalent operator-defaults field is nativeDictationHud. It is independent
of native_dictation_pill: either, both or neither may be on. The existing
server-owned native process must be running; a standalone process without the
parent pipe stays on the web HUD. macOS only; other platforms reject frames and
keep the web HUD.

## Which sessions show it

Only sessions routed to the caret or HUD surface: Voice Settings > Settings >
Live dictation set to At caret (`dictation_partials_surface = caret`, the
default) or Screen bar (`hud`), for plain Fn dictation and for the agent
lane. With Live dictation Off, the dock owns feedback (see dictation-pill.md)
and this surface draws nothing.

## Ownership

The web HUD page keeps every owner it had: the session-fenced `o8:stt-event`
stream, the 300 ms (agent) / 32 ms (dictation) paint grace, the composer claim,
the 900 ms delivered-text hold, the 2.5 s error hold and the 60 s safety. It
builds one frame per render and feeds it through the dock's hook
(useNativeDictationPill with surface `hud`) and route (`surface: "hud"`), so the
contract is the dock's: prepare before web drawing yields, one request in
flight with latest-wins coalescing, a 500 ms request deadline (450 ms on the
pipe), a 100 ms keep-alive, a 750 ms native lease, quiet-mode release, and
session-named releases. The route reads nativeDictationHud for these requests
and sends them as `dictation-hud` frames over the same owned child pipe; the
native process puts them on the dock's queue and serves them from the same
loop, in a second panel. HUD frames report no clicks.

Exactly one surface draws. The page paints only while the native panel does not
own the HUD (webHudPaints). If a frame misses its deadline or the native side
answers anything but ok, the page paints the same session at once and sends a
best-effort release; if that release is lost the native panel hides itself
when its 750 ms lease runs out (without the exit fade). The next session
prepares again.

A composer claim (`o8:agent-partials-claim` or its `-fwd` relay) makes the
frame idle, which releases the native panel exactly as it hides the web bar;
the claim safety and release are unchanged.

## Placement

The classic shell still computes the anchor: the caret rectangle from
Accessibility when known, the pointer's screen otherwise, or the legacy
window/screen anchor when the screen bar is selected. After applying it to its
own window, it emits `o8:agent-partials-placement` (surface, x, y, width,
height in top-left desktop points) to the HUD page, which passes it in each
frame. The native panel takes exactly that frame, converted to AppKit
coordinates against the primary screen, so the right monitor follows from the
shell's choice; the window binary makes no Accessibility query. A placement
for the other surface is ignored. Until one arrives (normally a few
milliseconds after the start event, inside the paint grace) the panel uses the
legacy bottom-centre of the primary screen.

## Window posture

A nonactivating GPUI pop-up whose class refuses key and main (the dock's
class), ignoring mouse events on its whole frame, level 25, not hidden on
deactivate, and CanJoinAllSpaces | Stationary | IgnoresCycle |
FullScreenAuxiliary as the classic HUD. It is ordered front without
activation, so the paste target never changes. It does not keep the shell alive.

## Visual parity

| Web HUD | Native | Remaining difference |
| --- | --- | --- |
| Caret: 420 wide, radius 14, padding 10/14; legacy: 680 wide, radius 22, padding 16/26, bottom-centred | Same geometry inside the shell's 460×138 or 820×220 frame | None known |
| Glass: rgba(9,10,13,0.82) with a 22 px backdrop blur; Solid: rgb(20,22,28) | Same tint and solid fill | No backdrop blur behind the glass tint |
| 1 px white 12% border, two-layer shadow | Same | None known |
| Symon mark (active ring while listening), uppercase `Symon · …` label at 10 px | Same mark asset and wording (computed by the page) | No letter spacing |
| 30-bar Symon waveform at 90 px from the measured level | Same bars, weights, gain and gradient colours | No 70 ms bar easing |
| Polishing squiggle with a travelling 2.1 s stroke | 96 px track with a travelling Symon segment, same period | Straight track instead of the squiggle |
| Transcript 14/19 px, line height 1.4, bottom-anchored, dim placeholder | Same; the page sends the newest 600 characters | No top fade mask on the legacy bar |
| Legacy elapsed m:ss from 10 s while listening | Same | None known |
| 160 ms fade with a 4 px rise; reduced motion drops the rise | Same; reduced motion also stops the polishing travel | None known |

## Tests

- native_hud_tests.rs: phases and visibility, malformed and dock-shaped frames,
  lease expiry without a fade, stale releases, AppKit placement conversion and
  fallback, and an off-screen draw of every phase on both surfaces with glass,
  solid and reduced motion.
- native-hud-feed.test.ts: phase mapping and wording, claim and grace yield,
  single-surface ownership, placement filtering, the flag-off probe, native
  frames carrying the HUD detail, release on a claim, and web takeover after
  the native side stops acknowledging.
- route.test.ts: the HUD uses only its own flag and frame type.

## Live acceptance

1. Use a build from this branch with the existing server-owned native window
   process running.
2. Set native_dictation_hud = true in the experimental section of settings.toml
   and restart o8 (the HUD page reads the flag once when it loads).
3. In Voice Settings > Settings > Live dictation, choose At caret.
4. Focus a text field in another application. Hold Fn and speak: the native
   HUD appears beside the caret with Symon · Listening, live bars and your
   words. Release: Transcribing/Polishing, then the pasted words for about a
   second, then it fades. The words paste into that field and keyboard focus
   never moves to o8. Only one HUD is visible throughout.
5. Click where the HUD is drawn while it is visible: the click reaches the app
   underneath.
6. Repeat in a full-screen app and on another Space, and with the caret on a
   second display: the HUD appears on the caret's display.
7. Choose Screen bar for Live dictation and repeat: the HUD is
   bottom-centred (above the o8 window's bottom chrome when o8 is focused) and
   shows m:ss after 10 s of listening.
8. Switch the o8 appearance between Glass and Solid: the bar switches between glass
   and solid on the next session. With the system Reduce motion setting on, it
   fades without the rise and the polishing track does not travel.
9. Hold Right-Option with the o8 canvas composer visible: the composer claims
   the partials and neither HUD paints.
10. Deny microphone access and dictate: Symon · Dictation stopped with the error
    shows for about 2.5 s. Restore the permission afterward.
11. Quit the native window process mid-dictation: the web HUD appears within
    about half a second and the session finishes normally.
12. Set the flag false, restart o8 and repeat steps 4 to 10 to confirm the web
    HUD is unchanged.
