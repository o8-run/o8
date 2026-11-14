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

Exactly one surface draws, and the web always starts the session. The page
paints every session from its first frame, as without the flag, so feedback
appears within the paint grace of Fn whatever the native side is doing. Its
first native frame of a session is sent unarmed: the panel acknowledges it and
stays hidden. On that acknowledgement the hook reports the session `drawn`, the
web bar is removed without its exit fade, and the next frame, sent only after
that render has committed, is armed; the panel then shows at full opacity
without its own entrance. So the handover never shows both bars, and costs one
pipe round trip during which only the web bar is on screen.

If a frame misses its deadline or the native side answers anything but ok,
the page paints the same session at once and sends a best-effort immediate
release naming the session, so a responsive panel hides without its exit fade.
If that release is lost the panel hides itself when its 750 ms lease runs out.
A native main thread hung with a frame on screen cannot be hidden from the web
(the dock shares this; tracked on #6145). The next session starts on the web
and prepares again.

The flag is checked at every session start, not latched for the page's
lifetime: with it off, each session sends one prepare request that answers
`enabled: false` and nothing else; turning it on or off takes effect at the
next session without restarting o8.

A composer claim (`o8:agent-partials-claim` or its `-fwd` relay) makes the
frame idle, which releases the native panel exactly as it hides the web bar;
the claim safety and release are unchanged.

## Placement

The classic shell still computes the anchor: the caret rectangle from
Accessibility when known, the pointer's screen otherwise, or the legacy
window/screen anchor when the screen bar is selected. After applying it to its
own window, it emits `o8:agent-partials-placement` (surface, x, y, width,
height in top-left desktop points) to the HUD page, which passes it in each
frame. The shell anchors each session in `show()` just before it emits the
start event, so the page keeps the newest anchor received up to 1 s before the
session started and drops an older one (from an earlier session). The native
panel takes exactly that frame, converted to AppKit coordinates against the
primary screen and clamped into the bounding box of the screens and to
2048×1024, so the right monitor follows from the shell's choice; the window
binary makes no Accessibility query. The route rejects a rectangle outside
±100000 points or larger than 2048×1024. A placement for the other surface is
ignored. Without an anchor for the session the frame stays idle and the web
keeps drawing; the native panel never shows an unplaced frame, so there is no
fallback position and no jump.

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
| Glass: rgba(9,10,13,0.82) with a 22 px backdrop blur; Solid: rgb(20,22,28) | Same tint and solid fill; glass blurs the backdrop with GPUI's own blurred-window view cut to the bar's painted bounds and corner radius and faded with it (no toolkit change) | The system material's blur radius and saturation, not exactly 22 px / 140%; needs the live check |
| 1 px white 12% border, two-layer shadow | Same | None known |
| Symon mark (active ring while listening), uppercase `Symon · …` label at 10 px | Same mark asset and wording (computed by the page), 0.4 px tracking | None known |
| 30-bar Symon waveform at 90 px from the measured level | Same bars, weights, gain and gradient colours; each level eases over 70 ms (none under reduced motion) | Ease curve (0.22, 1, 0.36, 1) instead of (0.16, 1, 0.3, 1) |
| Polishing squiggle with a travelling 2.1 s stroke | The same squiggle path at 96×18 over its faint track, the 36/64 dash travelling 36 → -36 → 36 over 2.1 s; full static stroke under reduced motion | Drawn as 72 short pieces with flat joins rather than one round-capped stroke |
| Transcript 14/19 px, line height 1.4, bottom-anchored, dim placeholder | Same; the page sends the newest 600 characters | No top fade mask on the screen bar (#6168 follow-up) |
| Legacy elapsed m:ss from 10 s while listening | Same | None known |
| 160 ms fade with a 4 px rise; reduced motion drops the rise | The web bar plays the entrance; the panel takes over at full opacity and plays the 160 ms exit (rise dropped under reduced motion) | None known |

## Tests

- native_hud_tests.rs: phases and visibility, malformed and dock-shaped frames,
  unarmed and unplaced frames staying hidden, takeover at full opacity, lease
  expiry without a fade, stale releases, AppKit conversion and clamping, the
  squiggle dash, the 70 ms level easing, and an off-screen draw of every phase
  on both surfaces with glass, solid and reduced motion, with the measured bar
  bounds the blur follows.
- native-hud-feed.test.ts: phase mapping, wording and level clamping, claim and
  grace yield, placement filtering, freshness and limits, the per-session flag
  check, web-first handover with a delayed acknowledgement, release on a claim,
  and web takeover with an immediate release after acknowledgements stop.
- page-placement.test.ts: the real event order (placement, then start) reaches
  the native frame.
- route.test.ts: the HUD uses only its own flag and frame type, and
  out-of-range placements are rejected.

## Live acceptance

1. Use a build from this branch with the existing server-owned native window
   process running.
2. Set native_dictation_hud = true in the experimental section of settings.toml
   (no restart needed: the next session picks it up).
3. In Voice Settings > Settings > Live dictation, choose At caret.
4. Focus a text field in another application. Hold Fn and speak: the native
   HUD appears beside the caret with Symon · Listening, live bars and your
   words. Release: Transcribing/Polishing, then the pasted words for about a
   second, then it fades. The words paste into that field and keyboard focus
   never moves to o8. Only one HUD is visible throughout, with no jump or
   flicker when the native panel takes over a few milliseconds in.
5. Click where the HUD is drawn while it is visible: the click reaches the app
   underneath.
6. Repeat in a full-screen app and on another Space, and with the caret on a
   second display: the HUD appears on the caret's display.
7. Choose Screen bar for Live dictation and repeat: the HUD is
   bottom-centred (above the o8 window's bottom chrome when o8 is focused) and
   shows m:ss after 10 s of listening.
8. Switch the o8 appearance between Glass and Solid: the bar switches between glass
   and solid on the next session. In glass, the app behind the bar is blurred
   only inside the rounded bar, and the blur fades out with it. With the system Reduce motion setting on, it
   fades without the rise and the polishing track does not travel.
9. Hold Right-Option with the o8 canvas composer visible: the composer claims
   the partials and neither HUD paints.
10. Deny microphone access and dictate: Symon · Dictation stopped with the error
    shows for about 2.5 s. Restore the permission afterward.
11. Quit the native window process mid-dictation: the web HUD appears within
    about half a second and the session finishes normally.
12. Set the flag false and repeat steps 4 to 10 to confirm the web HUD is
    unchanged.
