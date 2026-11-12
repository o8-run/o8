# Published GPUI 0.2.2 with local macOS scheduling changes

Source: the crates.io `gpui` 0.2.2 package, Apache-2.0, checksum
`979b45cfa6ec723b6f42330915a1b3769b930d02b2d505f9697f8ca602bee707`.
The original `LICENSE-APACHE` and package metadata are retained.

Rule: application code first. Before a new edit here, try it in o8 next's own
code through GPUI's public API. An edit lands only with an entry below that
says what changed and why application code could not do it; every entry is
redone by hand at each toolkit upgrade. A pull request that changes this
directory without changing this file fails the `o8 next surface boundary`
check, whatever its labels. To run it before pushing:
`node scripts/next/check-surface-boundary.mjs --base origin/main --head HEAD --select-only`.

Local changes:

- `src/platform/mac/frame_clock.rs`: a deterministic 100 ms idle policy.
- `src/platform/mac/window.rs`: pause idle links, wake on invalidation and
  occlusion transitions, recreate on screen changes and guard queued close work.
- `src/platform/mac/display_link.rs`: idempotent pause/resume with balanced
  dispatch-source suspension.
- `src/platform.rs`, `src/window.rs`: optional platform wake and completion hooks,
  plus feature-gated native frame counters.
- `src/platform/mac/metal_renderer.rs`: an opt-in counter incremented only after
  submitting the Metal command buffer, used by the native regression probe.
- `Cargo.toml`: the opt-in `frame-diagnostics` feature.
- `src/window.rs`, `src/platform/mac/window.rs`: macOS window-control drag
  areas. The view reports itself opaque through AppKit's private
  `_opaqueRectForWindowMoveWhenInTitlebar` (as WKWebView does), so AppKit no
  longer moves a transparent-titlebar window from its whole title band; a left press whose topmost hitbox is a
  `WindowControlArea::Drag` calls `performWindowDragWithEvent:`, and a double
  press runs the title bar double-click action. Tabs and buttons laid over the
  area keep their own presses and drags. Other platforms are unchanged.
- `src/elements/text.rs`: each text measure starts from the original runs.
  Truncation (`text_ellipsis`, `line_clamp`) shortened the captured runs in
  place, so a later measure paired short runs with the full text and a run
  boundary could fall inside a multibyte character, panicking in
  `layout_line` ("end byte index 13 is not a char boundary; it is inside '·'").
- `src/elements/text.rs`: a text measure that learns a truncation width shapes
  again. Unwrapped text (`whitespace_nowrap`) has no wrap width, so the layout
  from its first measure, taken with no width, was reused for every later one.
  `text_ellipsis` text kept its full length and its parent clipped it
  mid-letter. The layout now records the width it was truncated to and is
  reused only for that width, or when a later measure has none.
- `src/window.rs`: a cached view's paint reuse keeps input-handler slots aligned.
  A frame drawn while the platform still holds the input handler (inside text
  entry) leaves the rendered list without the entry the view's range recorded;
  `reuse_paint` sliced past the end ("range start index 1 out of range for
  slice of length 0", #5111). Missing slots are now empty entries, and `draw`
  skips an empty slot, so the platform keeps the handler it gets back.

- `src/text_system/line_layout.rs`: keep closing punctuation with its preceding
  text when computing soft-wrap boundaries, including emergency breaks inside
  long words. Spaces before a closing mark cannot orphan it on the next line.
  This matches classic WebKit wrapping in transcripts and file previews while
  retaining source text and glyph indices for selection and copying.

- `src/text_system/line_layout.rs`: keep closing punctuation with its preceding
  text during ordinary and emergency soft wrapping (9dafeae88). Hang breakable
  separator whitespace on the preceding line (7141929cc), without drawing an
  indent on the next line. No-break spaces U+00A0, U+2007 and U+202F retain
  their advance and glue both adjoining glyphs, including at emergency widths.
  This matches classic WebKit wrapping while preserving source text and indices.

- `src/scene.rs`, `src/window.rs`: native-view anchors. A native view such as a
  WKWebView draws above the whole window, so window content painted later
  (menus, tooltips, dialogs) used to fall beneath it. `paint_native_anchor`
  records an invisible marker in paint order, replayed with cached views;
  `native_anchor_cover` returns the visible quads the drawn frame placed above
  it; `on_drawn` runs a hook after each drawn frame, before presentation.

- `src/window.rs`: `Window::debug_selector_bounds`, a read-only accessor for
  the last frame's debug selector bounds, and `Window::dispatch_input_event`,
  which forwards to `dispatch_event`. It also adds
  `Window::topmost_hitbox_bounds`, so a press is refused when something else
  is on top of the named control, and `Window::dispatch_text_input`, which
  hands text to the focused input without a key event (the frame's press
  areas and the platform input handler are both crate-private). All four
  compile only in tests and with the `test-support` feature. The development driver (`src/driver.rs` in the parent
  crate, behind its `driver` feature) presses controls by name through them.
  Application code could not do this: the selector map is `pub(crate)` and a
  second naming mechanism would have to be added at about 745 call sites, and
  `dispatch_event` returns a crate-private type, so it cannot be called from
  outside the toolkit.

Other platforms keep the default no-op platform hooks. No GPL/AGPL application
source or patches were copied. Regression policy tests and the native AppKit
probe live in the parent crate.
