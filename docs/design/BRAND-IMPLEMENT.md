# Brand the o8 desktop app with Branding v1

A build brief for coding agents. The look itself is defined in `docs/design/BRAND.md`; this file says where it goes in the code and in what order. Read `AGENTS.md` and `.agents/skills/o8-ui/SKILL.md` first; every rule there still applies (focused commits, PRs, CI green, no self-merge, verify through the real entry point, report Outcome, Evidence, Residual and Decision).

Paths and line numbers were read from main at 635b9f8 (2026-11-12). Re-check them before you edit; they drift.

## What ships today, and what to brand first

- **macOS opens only the native GPUI app** (`native/o8-next`, #5860). Brand this first.
- Tauri (`src-tauri/`) is still the installer, updater, tray and server host, so the **app icon and tray icon live there**.
- Linux and Windows still open the web window (`src/`). Brand it second, with the same tokens.
- o8.run (`o8-site` repo) and o8-mobile are separate repos and separate PRs. Not in this brief.

## Ground rules

- One PR per step below. Each one small enough to review in one sitting.
- Copy values from `brand/tokens/`. Don't invent shades. One orange event per screen.
- Don't touch: the Ember, Tidewater, Aurora and Blackout palettes (only Paper changes); imported themes (`theme_import.rs`); terminal ANSI colours; syntax colours; row geometry, the 300/260 chrome weights and icon rules from `hurttlocker.md`, except where this brief says so; review-gating behaviour (`STYLEGUIDE.md`); crate and binary names (o8d, tern, o8-next stay in code).
- A user's saved theme or font choice always wins over a new default.
- Screens to screenshot for every UI PR: 900×700 and 1680×1050, light and dark (the STYLEGUIDE window-fit check), using `scripts/next/dev/dev.sh` (`build`, `launch`, `shot`; see `native/o8-next/docs/dev-loop.md`).
- Checks: `npm run typecheck:fast`, the native `o8-next-tests` job (`scripts/ci/native-changes.mjs`), and `npm run verify:ci` before push. Tests most likely to need updates: `theme_tests.rs`, `theme_font_tests.rs`, `shell_look_tests.rs`.

## Order of work

### 1. Land the brand files (docs only): done

Landed with the PR that added this file: BRAND.md, this brief and `brand/` assets; the old Cortex BRAND.md replaced; `brand/o8-logo.md` and `brand/o8-mark/` marked retired; the font lock in `hurttlocker.md` and `DESIGN.md` pointed at BRAND.md §9 (the app keeps the system stack until step 4); BRAND.md added to the o8-ui skill and the docs index; `brand/**/*.png` allowed in `.gitignore`.

### 2. App icon, tray icon and in-app logo (Ring)

- **App icon:** regenerate `src-tauri/icons/` from `brand/app-icon/icon-light.svg` (macOS tile) with `cargo tauri icon`, or copy the matching PNGs from `brand/app-icon/png/` and the macOS iconset (`iconutil -c icns brand/app-icon/o8-light.iconset`). Keep the file names `bundle.icon` in `src-tauri/tauri.conf.json` already lists. Use the square version for the Windows `Square*Logo.png` and `StoreLogo.png`.
- **Tray:** redraw `src-tauri/icons/tray-template.png` (44×44, black on transparent, template image) from `brand/ring/ring-mono-ink.svg`. Loaded at `src-tauri/src/lib.rs` (about line 9074).
- **Native in-app logo:** replace `native/o8-next/src/surfaces/sidebar/project_identity.png` (used by `project_identity.rs:51` and `shell_rail.rs:826`) with `brand/ring/ring-light-512.png`, and add a dark copy chosen with `crate::theme::light()` the way `symon_mark_sized` does.
- **Retire the Symon mark:** `symon_mark_{light,dark}.png` in `shell_rail.rs:841–860` (rail voice button, and `surfaces/setup/permissions.rs:563` at 32px). Replace it with Glance tight (`brand/glance/glance-tight-*.svg` rasterised to PNG at 2x) and rename the functions; voice is "talk to o8" (NAMING in BRAND.md §2). Remove `theme::symon_glow()` if nothing else uses it.
- **About:** `settings_about.rs` shows text only. Add the Ring (48px) above the name, with the current loop step: `brand/ring/loop/ring-step-4.svg` (Re-review) and the label "Re-review".
- **Web (Linux and Windows window):** `src/app/icon.png`, `public/icons/*` (PWA, maskable, apple-touch), `public/manifest.json`, `public/logos/o8-desktop.png` (used by `src/components/desktop/shell/SidebarBrand.tsx`). Use `brand/favicon/` and `brand/app-icon/png/`.
- **README header:** `assets/o8-icon.png` → `brand/ring/ring-light-512.png` at 256.
- Note on SVG in GPUI: `svg()` paints a single-tint mask (see `icon.rs` `Assets::load`), so multi-colour marks must go in as PNG through `Image::from_bytes(ImageFormat::Png, …)` (as `symon_mark_sized` and `profile_menu.rs:94` do) or `img()`. Rasterise from the SVG masters at 2x and 3x.
- Verify: dock icon, tray, sidebar identity, rail voice button and About in light and dark; the Linux web window's favicon and sidebar.

### 3. Paper colours

- In `native/o8-next/src/theme.rs`, `mod bespoke`, replace the `o8-paper` entry's values with `brand/tokens/theme-paper.rs`, and update `DESCRIPTIONS[4]`.
- Keep `brand_orange()` at `#ff5a1f` (it already matches).
- Don't change the Light, Dark or Glass built-ins in this step.
- Web side: copy `brand/tokens/tokens.css` variables into the Paper palette in `src/lib/theme/registry.ts` (`PALETTES`, about line 505) and keep `--t-brand-orange` as is.
- Verify: Paper in Settings › Appearance looks like BRAND.md §8; run the theme tests.

### 4. Inter Tight and JetBrains Mono

This overrides a lock in `hurttlocker.md` that came from a rolled-back webfont pass, so it needs proof in the PR.

- Bundle `brand/fonts/inter-tight/InterTight-{Light,Regular,Medium}.ttf` and `brand/fonts/jetbrains-mono/JetBrainsMono-Regular.ttf` next to the other native assets, with both `OFL.txt` files (as `caveat-OFL.txt` sits beside `caveat.ttf`).
- Load them once at start-up with `cx.text_system().add_fonts(...)`, the pattern in `files_panel/spec.rs:63`, inside the `.run(move |cx| …)` closure right after `.with_assets(crate::icon::Assets)` in `shell_view.rs` `launch()` (about line 186). Check `ui.rs:1156` for the second entry point.
- Point `UI_FONT` (theme.rs about line 1123) at "Inter Tight" and `MONO_FONT` at "JetBrains Mono" on every platform. Keep `ANNOTATION_FONT` (Caveat).
- Keep the Settings font picker (`set_font`, `installed_or_default`, `font_options`, theme.rs 619–702) working; system fonts stay selectable, and a saved choice wins.
- Weight: `TYPE.weight` is 300 and `meta_weight` 260 today. Inter Tight at 300 is thin at 13px. Start body text at 400 and meta at 300, then compare screenshots against main at 13–13.5px. Put both sets of screenshots in the PR and let Q decide.
- Web: add the `@font-face` rules from `tokens.css` to `src/app/globals.css` and set `--font-sans-system` to Inter Tight first in the stack.
- Verify: `theme_font_tests.rs`; screenshots of the sidebar, a transcript, Settings and the composer at both window sizes.

### 5. The working indicator in the composer

**Where:** `native/o8-next/src/conversation.rs`, the composer column (about line 764). Today it stacks `empty_chat_hero`, `shell_run_card`, `lineage_strip`, `changes_pill`, then `composer_card`. Add a new `working_strip` row **between `changes_pill` and `composer_card`**, so it sits directly above the input like Claude Code's spinner line. Show it only while `turn_running()` (`composer/send_menu.rs:12`).

**What it is:** a 40px Glance on the left, one status line, and on the right the timer `m:ss · esc to stop` in mono, ink-faint. Height ≤ one composer row; it must not push the transcript when it appears (reserve the height while a turn runs).

**How to draw it:** GPUI can't play the SMIL SVGs, so use the PNG frames in `brand/working/frames-80/<state>/000.png…` (40px at 2x, 20fps; counts in `frames.json`).
- Load each state's frames once into `OnceLock<Vec<Arc<Image>>>` (the `symon_mark_sized` pattern). The set is about 3MB; if that's too heavy, drop to 12fps by re-running `brand/src/frames.py`.
- Drive the frame index from the shared clock the trace header already uses (`trace.rs`, the clock set about line 1175, redraw via `request_animation_frame` about line 1440). Don't start a second timer.
- **Switch rule:** when the state changes, keep playing the current state until its loop ends (`frame == last`), then start the new state at frame 0 on a layer above and fade the old layer out over 300ms with `motion.rs` (`Transition`, `ease_out`). Never cut mid-loop.
- Reduced motion: show frame 0 of each state, keep the line and timer.
- Leave the existing trace header in the transcript (`trace.rs` `title()` and `shimmer()`) as is. The strip is a second, smaller signal near the input; the transcript keeps the record.

**Which state:** write one pure function, `fn working_state(signals) -> WorkingState`, with tests, and feed it from data that already exists. Phase A ships with what is wired today; add the rest as their signals land. Don't fake a state.

| State | Phase | Signal in the code today |
| --- | --- | --- |
| Thinking | A | `Trace.live && Trace.thinking` (`model.rs:65`) |
| Taking in work | A | `Trace.live`, tool steps running, no review packet yet (the "Working" case in `trace.rs:885`) |
| Reviewing | B | packet status `awaiting_review` / `reviewing` (`theme.rs activity::packet_tone`, `status_mark.rs` `State::Review`) |
| Sending back | B | `changes_requested` / `needs-revision` (`status_mark.rs:73`, `pull_requests/reviews.rs:31`) |
| Waiting on CI | B | a check is `pending` on the thread's PR (`pull_requests/detail.rs:699`) |
| Re-reviewing | B | Reviewing again after a Sending back on the same packet |
| Merging | B | merge gate `Submission` in flight (`surfaces/pull_requests/merge_gate.rs`, "Merging through gate…" in `surfaces/pull_requests/comparison.rs:462`) |
| Approved | B | `merged` / `released` (`status_mark.rs:84`). Play one loop, then the strip leaves |

Status line copy: the examples in BRAND.md §7, filled from real numbers (PR number, file count, finding count, short hash). If a number isn't known, drop it rather than guess.

**Verify:** a unit test for `working_state`; a `dev.sh shot` of each Phase A state in light and dark; a short screen recording of Thinking → Taking in work → end of turn. Check the transcript doesn't jump when the strip appears.

### 6. Glance in the product

- Review rows and the Review queue: the 30px avatar uses Glance tight with the colour state that matches the row (`brand/glance/states/glance-<state>-tight-*.svg`, rasterised). The four states map to `status_mark.rs` `State`: Review → reviewing, Rejected → sent back, Merged → approved, Running → working. Leave Blocked, Stopped and Snoozed on the existing status mark.
- Empty states (`composer/empty_overview.rs`): Glance fog at 96px, using `brand/working/stage/thinking.svg` frames or a still.
- Keep the animated 3×3 status mark in the sidebar (`surfaces/sidebar/status_mark.rs`) for now; it's a different, smaller job. Revisit after v1 ships.

### 7. Paper as the default look

- `theme.rs` `LAUNCH` (about line 48): when nothing is saved and no env override is set, default to `theme:o8-paper` instead of Dark (and instead of Glass under `--app-shell`). A saved choice and `O8_NEXT_APPEARANCE` still win.
- This changes what every new user sees on first launch. Ship it as its own PR, with screenshots, and get Q's yes.
- Then re-shoot README screenshots and clips in Paper.

### 8. Words (naming)

- Replace "Symon" in UI strings in the native app. Files that mention it today: `shell_features/voice.rs`, `shell_features/ui_commands.rs`, `shell_features/right_panel.rs`, `shell_session.rs`, `surfaces/scheduled/editor.rs`, `surfaces/setup/{view,home,permissions}.rs`, `shell_rail.rs`, `settings_voice_fields.rs`, `settings_render.rs`, `theme.rs`. Voice becomes "talk to o8". Update the matching tests.
- No "o8 next" in any user-facing string. Known ones: the window title in `shell_view.rs:270` and `ui.rs` (about line 1159), `composer/regions.rs:41`, `pane_grid.rs:452`, and "is not in o8 next yet" in `shell_features/right_panel.rs:1232`. Use "o8". The codename stays in paths, crate names, CLI help and logs.
- Out of scope here: o8-site (/symon page, nav, terms) and o8-mobile ("Agents" label). Separate repos.

## Done means

Every step above merged by a reviewer, CI green, screenshots in each PR, and a final check that the app shows: the Ring in the dock, tray, sidebar and About; Paper colours; Inter Tight; the working strip above the composer with at least Thinking and Taking in work; no "Symon" anywhere a user can see it.
