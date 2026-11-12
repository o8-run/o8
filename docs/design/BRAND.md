# o8 brand, v1

Status: **v1, locked 2026-11-12 by Q.** This is the single source of truth for how o8 looks, moves and talks on every surface: the desktop app, o8.run and the phone. It will get better from here; change it on purpose, in a PR, and bump the version line.

It replaces the earlier brand docs. Where they disagree, this file wins:

| Older doc | What happens to it |
| --- | --- |
| `docs/design/BRAND.md` "Cortex Brand System" (Glass Light, blue primary) | Replaced by this file |
| `brand/o8-logo.md` (glass ribbon monogram) | Retired. Keep for history, mark it retired |
| `brand/o8-mark/` (striped circle and traced wordmark) | Retired as the logo |
| `docs/design/hurttlocker.md` and `DESIGN.md`, the rule "system font only, never Inter or a webfont" | Overridden for the typeface only. Everything else in them (row geometry, weights on chrome, icon rules, review gating) still stands |

Assets live in `brand/` (see `brand/README.md`). Plain tokens to copy are in `brand/tokens/`. The build brief for agents is `docs/design/BRAND-IMPLEMENT.md`.

---

## 1. The idea

o8 is the review and merge layer for coding agents. The brand should feel like a precise instrument on warm paper: calm, exact, one spark of orange.

The one line: **"Your agents write the code. o8 reviews it, sends it back until it's right, and merges it."**

Test for any surface: cover the logo. Would you still know it's o8? If not, it's borrowing too many effects.

## 2. Name

- It's **o8**: lowercase, no space, no period. Never "O8", "o8 AI", "the o8 app". o8.run is the website, not the product name.
- It stays lowercase at the start of a sentence: "o8 reviews the diff."
- **The agent is o8 too.** "o8 reviewed this", "ask o8", "o8 sent it back". No second name anywhere in the UI.
- Roles are plain words: reviewer, author, worker. Features are plain nouns: Review queue, Missions, Receipts, Voice, Mobile.
- Retired in public copy: **Symon**, **opr8**, **"o8 next"** (fine as an internal codename and in code), Tern, gate8, hurttlocker (say "o8 theme"). Crate and binary names (o8d, tern) can stay in code.
- No persona name. If a voice character is ever wanted, Hachi is the idea on file. Not Otto.

## 3. Logo: Ring

The main logo. A heavy lowercase o with an orange review point set into its shoulder. Read long enough, it says o8. There is **no 8 or infinity sign** in any mark; "o8" stays a word.

Geometry, on a 100×100 box:

| Part | Value |
| --- | --- |
| Outer radius | 40 (centre 50,50) |
| Inner radius | 22 |
| Review point | radius 7.4, on the ring's mid-line (radius 31) at −45° (upper right) |
| Gap around the point | 3.4, cut out of the ring (a real cut, not a paper-coloured disc) |

Rules:

- Ink ring on light, paper ring on dark. The point is always orange (`#FF5A1F`). One-colour use (print, a monochrome tray icon) drops the orange and keeps the cut.
- Flat always. No glass, gradient, bevel, shadow or outline on the mark itself.
- Clear space: one inner radius (22 units) on every side. Minimum size 16px.
- Ring is the dock icon, the download button, the X avatar, the favicon and the About screen. Glance is never locked up next to it as one logo.
- Wordmark: "o8" set in Inter Tight 500, tracking −4.5%, always lowercase. Lockup: Ring on the left, wordmark on the right, Ring about the wordmark's cap height, gap about 0.28em. The exact lockup isn't drawn yet (open).

Files: `brand/ring/` (light, dark, mono, `currentColor`, PNGs), app icon in `brand/app-icon/`, favicon in `brand/favicon/`.

### App icon

Flat Ring on a tile. Light: paper tile, ink ring. Dark: graphite (`#242424`) tile, paper ring. The macOS file follows Apple's grid (824px rounded tile inside 1024, radius 185, soft drop). Square full-bleed versions are for iOS, Windows and Linux. Glass on the icon is allowed later as the one place glass goes, but v1 ships flat.

## 4. The loop (the brand's story)

o8's real review loop, in six steps, in this order:

1. **Arrive** 2. **Review** 3. **Send back** 4. **Re-review** 5. **Merge** 6. **Learn**

- Each step has a fixed spot for the Ring's point: step 1 is the logo's home (−45°), then every 60° clockwise. Files: `brand/ring/loop/ring-step-1..6.svg`.
- The **era** is the step o8 is making real right now. Today: **Re-review** (#5835). The loop working end to end is 1.0.
- App: the six words are the status words for a piece of work; Glance wears the matching face; About shows the Ring at the current step.
- Site: one strip of six steps under the hero (solid = works on main, orange point = being built, outline = ahead).
- Release posts lead with the step: "o8 0.1.82x · Re-review". A release only claims a step once it works on main.

## 5. Glance (o8's face)

Glance is o8 inside the product: a soft ink pebble with two eyes reading sideways, like a reviewer reading a diff, and one orange dot for a mouth. The second pair of eyes on every change. A careful colleague, not a cartoon.

Geometry (100×100 box; the body is a superellipse, see `brand/src/glance.py`):

| | Full (48px and up) | Small cut (under 48px) |
| --- | --- | --- |
| Body | a 42, b 36, centre (50,53) | a 46, b 41, centre (50,52) |
| Eyes | (40,50) and (63.5,50), rx 8.6, ry 10.4 | (37,48) and (65,48), rx 11.5, ry 13.5 |
| Pupils | r 5.0, offset (+3.5, +1.4), looking right | r 7.4, offset (+4.0, +1.6) |
| Dot | (58.5,72), r 4.0 | (58,75), r 6.0 |

### Fog

Glance's body is always **fog**: solid in the middle, fading evenly to nothing at the edge, so it sits on any surface. Eyes and the dot stay crisp. It's built from stacked copies of the body at solved opacities, not a blur filter, so it renders the same in a browser, in exports and in native code.

| Tier | Size | File |
| --- | --- | --- |
| Fog | 48px and up: hero, release art, empty states, reviewer header | `glance-fog-*.svg` |
| Tight | 24–40px, small cut: avatars, 30px rows, the composer indicator | `glance-tight-*.svg` |
| Hairline | 16–20px, small cut. Reads as nearly flat | `glance-hair-*.svg` |
| Mist | Big backdrops only | `glance-mist-*.svg` |

Never below 16px. Where layered SVG can't render, use the flat fallback in `brand/glance/flat/`.

### Color states

Four states only. The face always carries the state too, so colour is never the only signal.

| State | Body | Eyes | Dot | Face |
| --- | --- | --- | --- | --- |
| Reviewing (default) | ink | paper, pupils right | orange | reading |
| Working | ink | closed line (blink) | grey `#A8A398` | resting |
| Sent back | orange | flat lids, looking at you | ink | level |
| Approved | green `#15803D` | happy closed arcs | paper | pleased |

In dark mode the reviewing and working body turns paper with graphite eyes; sent back and approved keep their colours. Colour states stay in fog, including the avatars in the o8 window. Files: `brand/glance/states/`.

### Glance rules

- Eyes look right (reading direction) by default.
- No brows, hands, body, accessories or extra expressions. Only the four faces above.
- Never recolour the pebble outside the states above, never put it on a photo or gradient without a solid plate.
- It looks a little like a Ghibli soot sprite. Keep it distinct: smooth (never fuzzy), flat-bottomed, side-glancing, with the orange dot.

## 6. Motion

UI motion is calm and quick: **150–250ms, ease-out `cubic-bezier(0.22, 1, 0.36, 1)`** (already `motion::ease_out` in native). No confetti, particles, animated gradients or bouncing. Every Glance loop starts and ends on Glance and respects reduced motion (hold the first frame).

The signature motion is Glance changing shape to act out the job. Locked:

| Motion | What it shows | Edge rule | File |
| --- | --- | --- | --- |
| **Wake** (intro) | Ring holds, softens into a half-asleep Glance, the point drops last | Flat Ring at start and end, fog only while it's Glance | `motion/intro-wake.svg` |
| **Approve** | Glance stamps into a seal with a check | Fog while it's Glance, hard edge once it's the seal | `motion/approve.svg` |
| **Fan out** | Work splits into lanes and merges back | Hard edges | `motion/fan-out.svg` |
| **Read the diff** | Glance becomes a page of lines being read | Hard edges | `motion/read-the-diff.svg` |
| **Many in, one out** | Several pieces go in, one comes out | Fog on the in side, sharp on the out side | `motion/many-in-one-out.svg` |
| **Branch review** | Glance rides a branch and its fix back | Hard edges, no fog | `motion/branch-review.svg` |
| **Color states** | Cycles the four states | Fog | `motion/color-states.svg` |

Open (not locked): **Glance to Merge** (`motion/glance-to-merge-OPEN.svg`), used by the Merging state below.

The files are animated SVG (SMIL). Browsers play them as-is. Native code can't, so the brief covers frame exports.

## 7. Working indicator (v1)

One Glance in the composer at **40px (tight fog)** with **one status line** and a **timer** (`m:ss · esc to stop`). It changes motion with what o8 is doing, the way Claude Code's spinner word changes, but it acts the job out.

| State | Example line | Motion | Loop |
| --- | --- | --- | --- |
| Thinking | Thinking about what changed | Thinking (resting loop: fog breathes, eyes read a line) | 4s |
| Taking in work | Taking in 3 changes from Codex and Claude Code | Many in, one out | 6.5s |
| Reviewing | Reviewing #5938 · 14 files | Read the diff | 7.5s |
| Sending back | Sending 2 findings back to Codex | Sent back (turns orange, two findings slide out left) | 6s |
| Waiting on CI | Waiting on CI · 3 checks running | Fan out | 7s |
| Re-reviewing | Re-reviewing the fix against 2 saved findings | Branch review | 8s |
| Merging | Merging #5938 into main | Glance to Merge (open) | 7s |
| Approved | Approved and merged · a3f9c21 · receipt saved | Approve | 7s |

Rules:

- **Switch only when the current loop finishes**, then cross-fade **0.3s** (new layer on top, old one fades out). Never cut mid-loop.
- The status line changes with the state (fade 180ms). Numbers over adjectives; first person is fine ("I'm reviewing 14 files" or the plain form above, pick one per surface and keep it).
- Each state keeps its motion's edge rule.
- Reduced motion: hold the first frame, keep the line and timer.
- When the turn ends, the indicator leaves; the last state's result stays in the transcript, not in the composer.
- A big version (96px, full fog) exists for empty states and previews: `brand/working/stage/`.

Data: `brand/working/states.json`. Web reference: `brand/working/o8-working.js` + `.css`. Native frames: `brand/working/frames-80/` (40px at 2x, 20fps, transparent PNG).

## 8. Color

| Token | Hex | Use |
| --- | --- | --- |
| paper | `#F4F2EC` | Default background everywhere. Never pure white |
| paper-deep | `#EEEBE2` | Nested surfaces, sidebars, code |
| card | `#FDFCFA` | Raised cards and windows |
| hairline | `#CFCAC0` | 1px borders (or ink at 9%) |
| ink | `#17140F` | Text and marks. Never pure black |
| ink-muted | `#5C584F` | Secondary text |
| ink-faint | `#706C64` | Labels, meta |
| graphite | `#242424` | Dark brand surface (dark icon tile, dark marketing) |
| orange | `#FF5A1F` | The one accent: the review point, a status dot, one highlight |
| orange-ink | `#B73A0B` | Orange for small text on paper |
| link | `#2563EB` | Links, focus rings, selection. One blue only |
| success / danger | `#16A34A` / `#EF4444` | Status only, never decoration |

Rules: **one orange event per screen or fold.** No purple or violet. No gradients between tokens. Photos and shaders only as a backdrop behind a window, never behind text.

## 9. Type

**Inter Tight** for everything, **JetBrains Mono** for code. Both are free under the SIL Open Font License; the files and licences are in `brand/fonts/`. Söhne, Geist and Hanken Grotesk are dropped.

| Role | Weight | Notes |
| --- | --- | --- |
| Display | 300 | Headlines, tight tracking (−2%) |
| Body | 400 | 15–17px on the site, 13–14px in the app |
| Emphasis | 500 max | No bold anywhere |
| Mono | 400 | Hashes, commit ids, timestamps, receipts, code. Never body copy |

Ships on all three surfaces: bundled in the desktop app, self-hosted on the site, loaded in o8-mobile. An editorial serif is allowed for long-form notes only, never in the product.

Known risk: an earlier webfont pass in the app was rolled back because SF Pro's hinting at light weights looked better. Inter Tight is the decision; verify it with screenshots at 13px, and don't run Inter Tight below 400 in app chrome.

## 10. Surfaces

- **Paper** (light) is the default look everywhere. Every screenshot, clip and OG image uses Paper. Blackout is the default dark theme.
- Ember, Tidewater and Aurora stay as optional desktop themes, never in marketing.
- **Glass is a texture used twice:** the app icon (later) and the hero product window on o8.run. Cards, nav, settings and inner pages are flat paper with hairlines.
- Windows float with one soft warm shadow `0 30px 80px rgba(40,30,20,0.16)`. Everything else uses 1px hairlines.
- Radius: 8px controls, 12px cards, 16px windows. Nothing larger.

## 11. Icons

One stroke set (Lucide). 1.5px at 24px, 1.25px at 16px, square caps. No filled icons except status dots.

## 12. Voice

1. The first sentence says the thing.
2. Short sentences, plain words, numbers over adjectives.
3. No hype: powerful, seamless, revolutionary, unified.
4. No exclamation marks or emoji in the product.
5. In the app, o8 can speak in the first person, plainly ("I reviewed 3 files").

## 13. Hard bans

Purple or violet. The 8 or infinity sign as a logo. Gradients between palette tokens. Glass on cards. Robot, brain or node stock art. More than one orange per fold. Bold weights. Radius above 16px. "Symon", "opr8" or "o8 next" in public copy.

## 14. How to update the brand

Everything here is editable source, so later rounds build on v1 instead of starting over.

- **Vector first.** Every mark is SVG: Ring, the app icon, the favicon, every Glance size and state, every motion and every working-indicator state. PNGs (icons, the indicator frames) are exports for places that can't draw SVG. Never edit a PNG by hand.
- **Edit the source, not the output.** The shapes come from scripts in `brand/src/` (Python 3 with `cairosvg`):

| To change | Edit | Then run (from `brand/src`) |
| --- | --- | --- |
| Ring, loop steps, app icon, favicon | `logos.py` (geometry), `build_v1.py` (colours, sizes) | `python3 -I build_v1.py "$PWD" ../..` |
| Glance shape, faces, fog | `glance.py`, `fog.py` | same as above |
| A motion | `studies.py` (and `working.py` for the two indicator-only loops) | `python3 -I motions.py "$PWD"`, then `build_v1.py` for the indicator SVGs |
| Indicator frames for native | after any motion or indicator change | `python3 -I frames.py "$PWD" ../working/frames-80 20 80 tight` |
| The studies page | `studies_page.py` and `page*.css` | `python3 -I studies_page.py "$PWD" ../studies/o8-mark-studies.html` |

- **Explore on the studies page.** `brand/studies/o8-mark-studies.html` is the page every v1 decision was made on (open it in a browser). Try new options there first, then move the winner into this file.
- **Bump the version.** Change the status line at the top (v1.1 for a tweak, v2 for a new direction), say what changed and why in the PR, and keep the old values in git history rather than in this file.
- **Keep the locked rules** unless the change is a deliberate decision by Q: Ring as the logo, plain "o8" for the agent, Glance in fog with the edge rules, the six-step loop, Inter Tight, one orange per screen, and the hard bans. A change to one of those is a new version, not a fix.
- After any change, re-check BRAND-IMPLEMENT.md for paths or steps it affects.
