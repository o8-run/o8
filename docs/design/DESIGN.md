# o8 Desktop — Design Language (v1)

**Scrollbar rule:** no visible scrollbar tracks anywhere in the app. Preserve
scrolling and keyboard access, keep focus visible, and reserve no scrollbar
gutter. See [`STYLEGUIDE.md`](./STYLEGUIDE.md) for the shared interaction rules.

The sidebar header holds the app mark, priority bell and search. The bell toggles
between a compact normal list and a preview-rich priority list; its dot reflects
pending attention from actual conversations and workers. Pinned and recent chats
provide hierarchy without a redundant Chats label or an empty attention message.
Keep additional grouping choices in the section's secondary menu. The icon rail
stays visible when the list collapses; workspace back/forward and collapse controls
remain available in the header. Preserve the status squares and worker motion.

Inline code uses theme text tokens, with a restrained cyan for calls and shell
snippets. Clickable file references use the accent blue. Avoid hardcoded bright
code colors that compete with links, failures, or the surrounding prose.

Contextual chat grows from its composer inside the current panel. Keep the document
in view and let it scroll behind the bottom composer. Collapse retains the
conversation; incoming answers do not reopen it. Use the existing frosted overlay
tokens in All Glass and opaque palette tokens in other appearances. Avoid launching
a second popup for the same conversation.

The authoritative reference for styling every surface in the o8 desktop app. A sister spec to the marketing site's THEME.md — shared lineage, different medium.

If you are building or touching any surface in this app, read this first. If a choice is not covered here, derive it from the principles. If a rule here is wrong, update this file before you ship the exception.

**Desktop app context** — native macOS Tauri v2 shell + Next.js 16. Different constraints than the marketing site: this one runs inside a vibrancy-backed NSWindow, reloads on file change, and renders through a WKWebView that has its own quirks.

---

## Table of contents

- [00 — Where this fits](#00--where-this-fits)
- [01 — Palette](#01--palette)
- [02 — Typography](#02--typography)
- [03 — Space & rhythm](#03--space--rhythm)
- [04 — Layout primitives](#04--layout-primitives)
- [05 — Vibrancy & surfaces](#05--vibrancy--surfaces)
- [06 — Motifs](#06--motifs)
- [07 — Components](#07--components)
- [08 — Copy voice](#08--copy-voice)
- [09 — Motion](#09--motion)
- [10 — Accessibility](#10--accessibility)
- [11 — Hard invariants](#11--hard-invariants)
- [12 — Theme switching](#12--theme-switching)
- [13 — Bridge to o8-site](#13--bridge-to-o8-site)
- [14 — Canonical examples](#14--canonical-examples)

---

## 00 — Where this fits

### Two design surfaces, one brand

| | o8-site (marketing) | o8 desktop (product) |
|---|---|---|
| Medium | Static web | Native macOS app |
| Backdrop | Paper (`#F4F2ED`) full bleed | macOS vibrancy passthrough |
| Type | Inter, 400/500 only | System stack (SF Pro), 260–500 per hurttlocker |
| Chrome | Hairlines + whitespace | Glass over vibrancy |
| Content surfaces | Paper | Paper (light) / ink (midnight) |
| Layout | Single-column scroll | Panels + tiles |

Both share: the `#FF5A1F` orange accent, the `#B8C8D8` structural blue, the copy voice (numbered sections, bracketed labels, no hype), the accessibility floor.

### The "is this chrome or content" test

Before picking colors for any new surface, ask:

- **Chrome** — nav rail, sidebar, title bar, tab bar, panel frames, command palette, popovers, menus, status bar. These pass the macOS vibrancy through. Glass tokens. Transparency.
- **Content** — chat transcripts, code in the canvas, terminal output, orchestrator chat, file diff viewer. These are reading surfaces. Solid paper (light) or solid ink (midnight). No transparency.

Chrome bleeds. Content doesn't.

---

## 01 — Palette

### Desktop workspace frame

The desktop navigation column is 60 px wide. The header band is 40 px
high across the chat list, workspace and right panel. These controls
sit on one continuous outer frame, without header or rail separator borders.
The reading surfaces begin below that band, with a 4 px outer rim. Light and
dark modes join adjacent panels with straight, one-pixel seams and Lisse curves
only on the exposed workspace perimeter. Resize targets remain generous; the
straight seam glows on hover, focus and drag. Compact-shell behavior is preserved.

Dark mode matches the sidebar (`--t-sidebar-bg`) to the almost-black
reading surface shared by chats and tools inside a translucent black glass frame on macOS. Its even tint and native
diffusion material soften bright wallpaper within the rounded window mask.
Browser and non-macOS shells keep the opaque neutral frame (`--t-shell-frame-bg`).
All Glass keeps its existing single window material, separated cards, and curved
middle workspace. Theme consumers use the displayed surface while the saved
solid/glass preference remains available when All Glass is turned off.
Spacing comes from the shared shell geometry, not per-column optical offsets.

### Content surfaces (solid)

These are the reading surfaces — workspace canvas, chat panels, terminal output. They NEVER pass vibrancy through.

| Token | Light | Midnight | Role |
|---|---|---|---|
| `--t-canvas-bg` | `#F4F2ED` | `#1a1e24` | Workspace / code viewer |
| `--t-chat-surface-bg` | `#F4F2ED` | `#1a1e24` | LLM chat, orchestrator chat |
| `--t-terminal-bg` | `#F4F2ED` | `#16191e` | PTY terminals |
| `--t-chat-surface-text` | `#0f172a` | `#e8ecf2` | Primary text on content |
| `--t-chat-surface-text-secondary` | `#475569` | `#b7bfca` | Secondary text on content |
| `--t-chat-surface-text-muted` | `#64748b` | `#8a93a0` | Tertiary labels on content |

**Light-mode content surfaces use paper (`#F4F2ED`) — not `#ffffff`.** Matches the landing's paper tone so the brand feels continuous between the marketing site and the product.

### Chrome (translucent)

Surrounding panels, nav rails, tab bars, popovers. These pick up the vibrancy.

| Token | Light | Midnight | Role |
|---|---|---|---|
| `--t-chrome` | `transparent` | `transparent` | Forced transparent in Tauri; vibrancy shows through |
| `--t-panel` | `rgba(255, 255, 255, 0.58)` | `rgba(62, 68, 78, 0.36)` | Glass panels |
| `--t-bg` | `rgba(250, 251, 253, 0.62)` | `rgba(22, 25, 30, 0.56)` | Secondary glass |
| `--t-bg-card` | `rgba(255, 255, 255, 0.74)` | `rgba(62, 68, 78, 0.48)` | Card surfaces over chrome |
| `--t-border` | `rgba(15, 23, 42, 0.08)` | `rgba(255, 255, 255, 0.08)` | Hairline dividers |

**Never hardcode `rgba(255, 255, 255, 0.xx)` as a chrome surface.** Use `--t-panel` / `--t-bg-card`. The rgba-white approach looks correct in light but becomes a bright blob over midnight's vibrancy. See commit `929ffdf` for the repo-wide sweep that fixed this.

### Accent

| Token | Value | Use |
|---|---|---|
| `--t-accent` | `#2563eb` (legacy brand blue) | Primary interaction blue in product |
| `--t-brand-orange` | `#FF5A1F` | Status LEDs, merge-success dots, focus rings (matches landing) |
| `--t-brand-red` | `#ef4444` | Error states, destructive confirmations |

The product currently uses `#2563eb` blue as its primary action color. The landing's `#FF5A1F` orange is imported as `--t-brand-orange` for surfaces where the two should visually align (e.g. an `o8` wordmark, a status LED on the UpdateBanner).

### Structure (diagrams)

| Token | Value | Use |
|---|---|---|
| `--t-structure` | `#B8C8D8` | Diagram fills, empty-state halftones, glow trails |

Matches the landing's structural blue. Already in light use on empty states; formalizing as a token makes it tokenized.

---

## 02 — Typography

### Font — LOCKED (system stack; supersedes the old Plus Jakarta Sans lock)

> **Superseded 2026-11-12:** o8 Branding v1 sets Inter Tight and JetBrains Mono ([BRAND.md](BRAND.md) §9). The system stack stays until step 4 of [BRAND-IMPLEMENT.md](BRAND-IMPLEMENT.md) lands.

**System stack via `var(--font-sans-system)`** — `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", …`. The Plus Jakarta Sans pass was rolled back (2026-05): SF Pro's hinting at the light weights we run beats any webfont we tested. Never hard-code `'Inter'` or any webfont on chrome.

Mono remains SF Mono / Menlo / Consolas fallback chain.

**[`hurttlocker.md`](./hurttlocker.md) is the typography authority** — locked sizes/weights/tracking for every chrome role (row title 13.5/300, row meta 9.5/260, section labels 10/300, etc.). The summary below only sketches the shape; when they disagree, hurttlocker wins.

### Weight scale

| Weight | Use |
|---|---|
| 260 | Row meta lines (timestamps, path sublines) — see hurttlocker |
| 300 | Default chrome weight: row titles, labels, tab pills, section labels |
| 400 | Markdown headings, body emphasis ceiling for content surfaces |
| 500 | Inline `<strong>` only — the hard cap on chrome. Active state NEVER bumps weight. |

Weights 600+ do not appear on chrome. (Display/hero surfaces like onboarding may go heavier deliberately — those are content, not chrome.)

### Size scale

| Token | Size | Use |
|---|---|---|
| `display` | `44–72px` | Dashboard hero / onboarding |
| `h1` | `28px` | Settings page section heads |
| `h2` | `20px` | Panel heads, modal titles |
| `h3` | `16px` | Card titles, tab labels |
| `body` | `14px` | Chat messages, transcript lines, terminal output |
| `body-s` | `13px` | Nav labels, tooltip text, button copy |
| `meta` | `12px` | Status bar, port chips, timestamps |
| `micro` | `11px` | Numbered section labels (in widgets that adopt landing rhythm) |

### Landing-style label primitives

When a surface wants to borrow the editorial rhythm from the landing (settings page, first-run wizard, empty states), use:

- **Section label** — small-caps wide-tracked `00 — LABEL` (11px, `letterSpacing: 0.22em`, `--t-text-muted`)
- **Bracketed micro-label** — mono parenthesized `(FEATURE)` (11px mono, `letterSpacing: 0.04em`)
- **Mono stamp** — `v0.1.7` / `2026-04-17 13:00 UTC` (11px mono, `letterSpacing: 0`)

Use sparingly. This is the landing's rhythm, not the default app chrome.

---

## 03 — Space & rhythm

### Base unit

8px. All padding, gap, and margin values are multiples of 8. Exceptions are explicit: 14px card radii, 1px hairlines.

### Radius scale

Apple HIG-aligned:

| Radius | Use |
|---|---|
| 8px | Tags, pills, small badges |
| 10px | Buttons, containers |
| 12px | Secondary cards |
| 14px | Primary cards (chat card, repo card, settings card) |
| 16px | Modals, full-screen overlays |

### Touch targets

**44px minimum** for all interactive elements (Apple HIG). Hover zones may expand beyond the visible element.

---

## 04 — Layout primitives

The dashboard composition, from top to bottom:

```
┌─────────────────────────────────────────────────────┐
│ TitleBar (44px, drag region, traffic lights)        │
├─────────────────────────────────────────────────────┤
│ SessionTimeline (36px — OFF by default, epic #1089)  │
├───────────────┬───────────────────┬─────────────────┤
│ AgentPanel    │  TileContainer    │  O8Panel        │
│ (left card,   │  (WorkspaceTermi- │  (right, 440px  │
│  resizable)   │   nal tiles)      │   default)      │
├───────────────┴───────────────────┴─────────────────┤
│ DesktopStatusBar (settings · ports · branch · term) │
└─────────────────────────────────────────────────────┘
```

Desktop navigation uses `CompactNavigationRail` beside the retained
`ChatListColumn`. The rail stays visible when the chat list collapses or a
destination opens. List width and collapse preference are independent of the
rail. Keep the existing compact mobile shell below the desktop breakpoint.

### Key containers

| Element | File | Notes |
|---|---|---|
| Main layout | `src/app/dashboard/page.tsx` | Layout orchestrator — do not expand, keep as thin composer |
| Agent panel | `src/components/desktop/AgentPanel.tsx` | Left-side repo/agent view |
| Navigation rail | `src/components/desktop/shell/CompactNavigationRail.tsx` | Permanent desktop destinations; transparent in native glass |
| Chat list column | `src/components/desktop/shell/ChatListColumn.tsx` | Retained, independently collapsible and resizable |
| Workspace terminal | `src/components/desktop/workspace-terminal/` | Center tabbed workspace |
| Orchestrator tab | `workspace-terminal/OrchestratorTab.tsx` | Full-width orchestrator surface |
| LLM chat | `src/components/desktop/LLMChat.tsx` | Assistant surface |

### Asymmetry

The active workspace uses a firm left edge (the AgentPanel card). Panels on the right (Changes) float over vibrancy. Focused setup and connection flows use a centered, stable content frame; their width and reading order follow [`STYLEGUIDE.md` §4](./STYLEGUIDE.md#4--screen-structure-and-layout). Keep dense navigation geometry separate from full-window task layout.

---

## 05 — Vibrancy & surfaces

### macOS vibrancy

The Tauri sidecar applies `NSVisualEffectMaterial::HudWindow` unconditionally at startup (`src-tauri/src/lib.rs`). HudWindow is a dark-tinted material — it makes light-tinted rgba panels look silver-grey rather than white, which is intentional for the midnight aesthetic.

### Forced transparency

The `ThemeProvider` forces these tokens to `transparent` regardless of theme, so the vibrancy passes through:

- `--t-chrome`
- `--t-bg-gradient`
- `--t-chrome-nav`

This is a hard rule. Never override them with a hex color.

### Solid content surfaces

The three "paper" surfaces paint on top of the vibrancy with a solid fill:

- `--t-chat-surface-bg` — chat reading surfaces
- `--t-canvas-bg` — code/file viewer
- `--t-terminal-bg` — PTY output

These are NEVER transparent. They use paper (`#F4F2ED`) in light and ink (`#1a1e24` / `#16191e`) in midnight. Text needs a stable background to read.

### When in doubt

If you're painting a new surface, ask: "is this something the user READS for 30+ seconds, or is this chrome around the reading?" Reading → solid. Chrome → glass.

---

## 06 — Motifs

The desktop app has its own motif vocabulary, distinct from the landing's 7 figures. Don't try to render a spectrum slider in the app.

### 06.1 Card

Primary container for everything that isn't chrome. Rounded 14px, paper/ink fill, 1px hairline border, soft shadow. See `RepoCard`, chat cards, settings cards.

### 06.2 Pill label

Small rounded rectangle, ink fill, paper text. Used for status chips, session state badges. 28px height, `rx: 14`, uppercase text at 11px.

### 06.3 Hairline divider

1px at 8% opacity. Between sections, between list rows, between columns. Never borders or elevations.

### 06.4 Status dot (LED)

3–4px filled circle. Colored by state:
- `#22c55e` — running, live
- `#9ca3af` — idle, paused
- `#ef4444` — error, blocked
- `#FF5A1F` — attention required

Paired with text, never standalone.

### 06.5 Phosphor raw-SVG icons

Icons are raw `<svg>` elements. Never use `@phosphor-icons/react` or `lucide-react` React components — they don't render correctly in the Tauri webview. Extract path data from `@phosphor-icons/react/dist/defs/` and inline the SVG. For simple glyphs (plus, minus, check), prefer HTML entities.

See `src/components/desktop/title-bar/icons.tsx` and
`src/components/desktop/workspace-terminal/icons.tsx` for established patterns.

### 06.6 Session timeline

Horizontal strip above the workspace showing day-level activity (coding / thinking / testing / error). 36px tall. Muted colors, no bold. See `SessionTimeline.tsx`.

### 06.7 Flat icon button — LOCKED (the button language)

Every icon-shaped control across the app uses one visual language. Operator locked it 2026-05-23 after the floating-card refactor. The template is `SidebarTogglePill` (commit `0bf0d592`), generalized as `HeaderIconPill` (commit `690c7e40`).

**Geometry**

- `height: 26`, `minWidth: 26` (icon-only) or `paddingLeft/Right: 9-11` (icon + label)
- `borderRadius: 7`
- `border: none`, `boxShadow: none`
- Icon size 13–16 (use 13–14 for chrome rows, 16 inside cards)

**State + motion**

- **Rest**: `background: transparent`, `color: var(--t-text-secondary)`
- **Hover**: `background: var(--t-hover)`, `color: var(--t-text)`
- **Active** (selected tab / open panel): `background: var(--t-input-bg)`, `color: var(--t-text)` — only when the surrounding UI doesn't already signal state. If the panel itself shows/hides on click, the bg stays transparent (no boxy "this button is active" feedback).
- **No scale, no translate, no shadow on hover**. The button stays anchored. Motion happens *inside* the button — bg + color crossfade only. Use framer-motion variants with `transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}`.
- **No tap scale**. The click effect is the bg snap and the resulting UI change. Don't shrink the whole button.

**What we never do**

- ❌ `var(--t-chrome-btn-bg)` / `var(--t-chrome-btn-shadow)` / `var(--t-chrome-btn-active-shadow)` — these paint chunky boxy bgs and inset borders that read as a toolbar pill against the floating card. The chrome-btn token family is deprecated for new code; the few remaining consumers (footer status badges) override the tokens to `transparent` / `none` at their parent boundary.
- ❌ Scale-on-hover (`scale: 1.06`) — "moves the whole button". Locked out.
- ❌ Inset borders / outlines on the active state. State is communicated by the action's *result*, not the button chrome.

**Vertical position in column header strips**

Pills use `marginTop` to keep their window-y identical across the sidebar-open ↔ sidebar-closed toggle:
- `LeftHeaderStrip` (32px strip inside the floating card, paddingTop=5): `yNudge={-2}` (default)
- `WorkspaceHeaderStrip` / `PanelHeaderStrip` (36px strips at window-y=4): `yNudge={-3}`

See `HeaderIconPill.tsx` for the canonical implementation.

---

## 07 — Components

### TitleBar
44px tall. Drag region for the Tauri window. Traffic lights left. Agents / Alerts buttons (the NavRail survivors).

### Workspace terminal
Tab pills across each tile's own column strip (`WorkspaceHeaderStrip.HeaderPill` divs). Tab kinds: `orchestrator / terminal / chat / llm-chat / canvas` (`workspace-terminal/types.ts`). The Orchestrator tab is a single chat surface (`ThoughtsChatPanel` + `SessionVisualizer` strip when agents run) — the old three-pane layout is gone.

### RepoCard
The primary branch / agent grouping in the AgentPanel. 14px rounded, paper/ink surface, hairline border. Expanded state shows branch rows + commit history.

### Chat panel (LLM / orchestrator)
Solid content surface (paper in light, ink in midnight). Messages left-aligned, bubble style. User messages right-aligned with accent tint. Message composer at the bottom with a hairline top border.

### Terminal (PTY)
Full-height solid surface. Monospace. Matches `--t-terminal-bg`. Thin scrollbar styled to match the theme.

### Settings page
Sectioned with the landing's editorial rhythm. Uses section labels (`01 — ACCOUNT`), bracketed micro-labels, hairline dividers. Controls are inline-style React inputs; no native `<select>` in packet cards.

---

## 08 — Copy voice

Same rules as the landing (the site theme spec §08).

- Thesis-first. Short sentences. No exclamation marks.
- No hype adjectives ("powerful", "seamless", "revolutionary").
- Numbered sections when the content has a rhythm.
- Bracketed mono labels `(FEATURE)` `(STATUS)` `(SESSION)` for structural callouts.
- Monospace for timestamps, hashes, version stamps.

### Console logging

Every console log gets a `[feature-name]` prefix. See CLAUDE.md for examples: `[memory-recall]`, `[compaction]`, `[reconcile]`, `[orchestrator-session]`.

### Commit prefixes

`feat:` `fix:` `refactor:` `perf:` `chore:` `docs:` `design:` — these are the surviving prefixes after the public changelog filter scrubs. If you want a commit to land on the public log, use `feat:` / `perf:` / `design:`.

---

## 09 — Motion

Framer Motion with restrained curves.

- Spring: `stiffness: 400, damping: 30` — the default for all interactive transitions
- Duration-based: 150ms for hover states, 200ms for panel slides, 300ms for tab switches
- No bounce. No scale-on-hover > 1.02. No parallax.

First-run step and disclosure changes use the pointer-only 180 ms contract in
[`STYLEGUIDE.md` §4](./STYLEGUIDE.md#optional-setup-and-sensory-feedback). A
predetermined opacity/transform transition may use the Web Animations API without
adding a motion dependency. Keyboard navigation and reduced-motion mode stay
instant. Optional sound cues follow the same section's explicit opt-in contract.

### Specifically banned

- Loading spinners on fast operations (< 500ms)
- Typewriter text reveals
- Confetti, particles, celebratory animations
- Auto-advancing carousels
- Any motion that re-triggers on scroll

---

## 10 — Accessibility

### Contrast

All text-on-surface combinations must meet WCAG AA on both themes:

- `--t-text` on content surface: ≥ 14:1 (pass)
- `--t-text-muted` on content surface: ≥ 4.8:1 (pass)
- `--t-brand-orange` on paper: 3.9:1 — non-text only

### Focus states

Every interactive element has a visible `:focus-visible`:

```css
*:focus-visible {
  outline: 2px solid var(--t-accent);
  outline-offset: 2px;
  border-radius: 2px;
}
```

### Keyboard

All dispatch / merge / approval actions are keyboard reachable. Tab order follows visual order (left to right, top to bottom). No mouse-only affordances.

### Reduced motion

`@media (prefers-reduced-motion: reduce)` — framer-motion respects this via `useReducedMotion()`. All spring transitions fall back to 0ms.

---

## 11 — Hard invariants

Rules that are permanent. No exceptions, no grandfather clauses.

### NEVER

- **Never use CSS classes.** Inline styles only (`style={{ }}` props). iOS Safari reliability issue. This is permanent.
- **Never hardcode rgba colors for surfaces.** Use `var(--t-bg-card)`, `var(--t-panel)`, `var(--t-input-bg)`. Hardcoded `rgba(255, 255, 255, 0.xx)` becomes a light-gray blob in midnight. See commit `929ffdf`.
- **Never hardcode port 3001 or 3002.** Use `getApiBase()` from `@/lib/panel/api-port`. The Tauri sidecar picks ports dynamically.
- **Never hardcode absolute user paths.** Use `process.cwd()`, `os.homedir()`, `process.env.HOME`.
- **Never use emoji.** Raw SVG only. Phosphor path data via `@phosphor-icons/react/dist/defs/`.
- **Never use React icon components in Tauri webview.** Neither `@phosphor-icons/react` nor `lucide-react` render correctly. Raw SVG via the shim system.
- **Never use dropdown overflow menus ("...")** — use inline actions with confirmation strips.
- **Never put early `return null` before hooks** — React rules of hooks, all hooks run in the same order every render.
- **Never use CSS shorthand for padding/margin** — use `paddingTop` / `paddingLeft`, not `padding: "8px 16px"`. React 19 warns on mixed shorthand/longhand.
- **Never throw in API routes** — return structured error responses via `buildErrorPayload`.
- **Never bypass the middleware in `src/middleware.ts`** — gates all dangerous API routes on loopback + ws-token.
- **Never use Material Design patterns** — no borderLeft accents as emphasis, no MD elevation tiers.
- **Never reintroduce retired orchestrator tile kinds** — `thoughts`, `mission-control`, `orchestrator-history` are deleted. The Orchestrator is a tab inside `WorkspaceTerminal`.
- **Keep destination launchers in the permanent desktop rail** — reuse existing routing and workspace handlers. The status bar remains reserved for workspace status, ports, and alerts.
- **Never use native `<select>` or `<input>` inside packet cards** — custom popover rows only.

### ALWAYS

- `npm run typecheck:fast` before every commit. Use `npm run typecheck:tsc` for the slower TypeScript 5.8.2 cross-check.
- Respect the 800-line file ceiling — decompose before adding more lines. `page.tsx` and `ws-server.ts` are waived.
- Apple HIG: 44px touch targets, 14px card radii, spring curves
- `as React.CSSProperties` when using vendor-prefixed or non-standard CSS props
- Build against the runtime capability contract, not a Codex/Claude special case. Every dispatchable runtime must remain truthful about the capabilities it supports.
- Console logging prefix `[feature-name]`
- Commit prefix `feat:` / `fix:` / `refactor:` / `perf:` / `chore:`

Full list lives in `CLAUDE.md`. This doc summarizes; that file is authoritative for invariants.

---

## 12 — Theme switching

### Current state

Two palettes ship: **light** and **dark** (`PaletteId` in `src/lib/theme/registry.ts`). The legacy `midnight` id auto-remaps to `dark` via `LEGACY_THEME_IDS` in `src/lib/theme/context.tsx`. "Midnight" in older docs means today's `dark`.

### How tokens are applied

`ThemeProvider` applies CSS variables to the `<html>` root. Components reference `var(--t-*)` tokens inside inline styles:

```tsx
<div style={{ background: "var(--t-bg-card)", color: "var(--t-text)" }}>
```

Components never import palette hex values directly. All palette access flows through tokens.

### Persistence

The palette choice persists to `localStorage` under `cortex-theme-palette`;
`cortex-theme` is read only as a legacy migration key.

### When adding a new surface

1. Pick the two-theme values from the palette table (§01)
2. Define tokens in `src/lib/theme/registry.ts`
3. Reference in component via `var(--t-your-new-token)`
4. Verify both themes render correctly
5. Check contrast ratios hit AA

Never hardcode. Never inline a hex outside the token system.

---

## 13 — Bridge to o8-site

When a surface in the app wants to reference the marketing site's aesthetic, follow these rules:

### Keep (shared)
- `#FF5A1F` orange accent — same token both places
- `#B8C8D8` structural blue
- Paper `#F4F2ED` on content surfaces in light mode
- Numbered section labels
- Bracketed mono labels
- Copy voice

### Translate (different context)
- Font: site uses Inter 400/500, app uses the system stack (SF Pro) at hurttlocker weights (260–500)
- Backdrop: site is full-paper, app is glass-over-vibrancy
- Layout: site is single-column scroll, app is panel+tile composition
- Motifs: site has 7 editorial figures, app has cards + pill labels + timeline

### Canonical coherence moments
- The `o8` wordmark + crosshair in `SiteNav` → matches the app's title bar wordmark when that surface is updated
- Landing's `(TRUST)` strip tone → the app's first-run wizard should echo the same bracketed-label rhythm
- Landing's download CTA typography → the app's UpdateBanner download prompt should mirror the mono-meta line underneath

If you're ever unsure whether a treatment is shared or diverges, ask. Don't guess.

---

## 14 — Canonical examples

### Content surface (chat panel)

```tsx
<div style={{
  background: "var(--t-chat-surface-bg)",
  color: "var(--t-chat-surface-text)",
  paddingTop: "16px",
  paddingBottom: "16px",
  paddingLeft: "20px",
  paddingRight: "20px",
  borderRadius: "14px",
}}>
  {/* chat messages */}
</div>
```

### Chrome surface (panel chrome)

```tsx
<nav style={{
  background: "var(--t-panel)",
  borderRight: "1px solid var(--t-border)",
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
}}>
  {/* icons */}
</nav>
```

### Status LED

```tsx
<span
  aria-hidden
  style={{
    display: "inline-block",
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: isRunning ? "#22c55e" : "#9ca3af",
  }}
/>
```

### Section label + bracketed micro-label (landing rhythm)

```tsx
<div style={{ display: "flex", alignItems: "baseline", gap: "20px" }}>
  <span style={{
    fontSize: "11px",
    fontWeight: 500,
    letterSpacing: "0.22em",
    textTransform: "uppercase",
    color: "var(--t-text-muted)",
  }}>
    01 — Workspace
  </span>
  <span style={{
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
    fontSize: "11px",
    letterSpacing: "0.04em",
    color: "var(--t-text-muted)",
  }}>
    (SESSION)
  </span>
</div>
```

---

## Provenance

- **v1** locked 2026-04-17 — alongside the landing site's THEME.md v1 Light lock.
- Palette update: content surfaces in light mode switched from `#ffffff` to `#F4F2ED` (paper). Chrome unchanged.
- Typography re-locked 2026-06-11 — system stack per hurttlocker.md (Plus Jakarta Sans rolled back 2026-05).
- Sister spec: the marketing site's THEME.md — marketing side.
- Authoritative implementation: `src/lib/theme/` — token definitions live there.

If this doc conflicts with the code, **the doc wins** and the code is a bug. File an issue, fix it.

If this doc conflicts with `CLAUDE.md`, `CLAUDE.md` wins — it's the single source of truth for hard invariants. This doc summarizes and explains.
<!-- Last reviewed: 2026-04-28 -->
