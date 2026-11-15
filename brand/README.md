# brand/

o8 Branding v1 assets. The rules for using them are in `docs/design/BRAND.md`; where each one goes in the app is in `docs/design/BRAND-IMPLEMENT.md`.

| Folder | What's in it |
| --- | --- |
| `ring/` | The main logo. `ring-light.svg` (ink, for light surfaces), `ring-dark.svg` (paper, for dark), `ring-mono-*.svg` (one colour), `ring-currentcolor.svg` (inherits text colour), 512 and 1024 PNGs. `loop/ring-step-1..6.svg`: the point at each loop step |
| `app-icon/` | Flat Ring on a tile. `icon-{light,dark}.svg` (macOS grid), `icon-{light,dark}-square.svg` (full bleed), `o8-{light,dark}.iconset/` (run `iconutil -c icns` on macOS), `png/` sizes 32 to 1024 |
| `favicon/` | `favicon.svg` (switches with the browser theme), 16/32/48 PNGs, `apple-touch-icon-180.png` |
| `glance/` | o8's face. `glance-{fog,mist,tight,hair}-{light,dark}.svg`, `states/` (reviewing, working, sent back, approved in fog and tight), `flat/` fallback, `core/` (Core treatment under test next to Fog, Fog stays default) |
| `motion/` | The locked motions as animated SVG: intro-wake, approve, fan-out, read-the-diff, many-in-one-out, branch-review, color-states. `glance-to-merge-OPEN.svg` is not locked |
| `working/` | The working indicator. `states.json` (states, lines, loops, rules), `composer/` (40px, tight fog) and `stage/` (96px, fog) animated SVGs, `frames-80/` (PNG frames for native code, 20fps), `o8-working.js` + `.css` (web reference) |
| `fonts/` | Inter Tight (Light, Regular, Medium as TTF and WOFF2, plus the variable font) and JetBrains Mono Regular, each with its OFL licence |
| `tokens/` | `tokens.json` and `tokens.css` (copy these values), `theme-paper.rs` (drop-in values for the native Paper theme) |
| `studies/` | `o8-mark-studies.html`, the page every v1 choice was made on. Start the next round from it |
| `src/` | The generators. `build_v1.py` rebuilds ring, app-icon, favicon, glance and working SVGs; `frames.py` rebuilds the PNG frames; `motions.py` exports the motions from `studies.py`. Needs Python 3 and `cairosvg`. `studies_page.py` with `page*.css` rebuilds the studies page. `marks.py` and `loopdial.py` hold retired concepts that the studies still import |

All colours are literal hex (no CSS variables) so the files render the same in browsers, resvg and GPUI. Animated files use SVG SMIL; browsers play them, native code uses the frames.

How to change any of this: BRAND.md §14.

Older marks in this folder (`o8-logo.md`, `o8-mark/`, `o8-icon-*.png`) are retired as of 2026-11-12.
