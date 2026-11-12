# Published GPUI 0.2.2 with local macOS scheduling changes

Source: the crates.io `gpui` 0.2.2 package, Apache-2.0, checksum
`979b45cfa6ec723b6f42330915a1b3769b930d02b2d505f9697f8ca602bee707`.
The original `LICENSE-APACHE` and package metadata are retained.

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

- Per-window interface zoom. GPUI's own zoom (`Window::set_rem_size`) only
  scales rem lengths, and o8 next sizes everything in fixed `px`, so the
  toolkit scales the window instead of the app converting every length.
  The zoom multiplies the scale factor and divides the layout viewport, so
  every primitive, glyph and image paints and rasterizes larger.
  - `src/window/zoom.rs` (new, the whole mechanism): `Window::zoom`,
    `Window::set_zoom` (bounds observers are deferred until after the
    caller's update, so a key handler inside an entity update can zoom),
    `read_platform_metrics`, the conversions `to_platform`,
    `point_to_platform` and `from_platform`, `input_from_platform` (pointer positions, pixel scroll
    deltas and file-drop positions), and the test-support
    `painted_quad_bounds`.
  - `src/window.rs`: `mod zoom;`, the `zoom` field and its `1.` initializer,
    `bounds_changed` calls `read_platform_metrics`, `dispatch_event`
    matches on `input_from_platform(event)`, `show_window_menu` passes
    `point_to_platform(position)` and `set_client_inset` passes the inset
    times the zoom (Wayland and X11 client-side decorations; `set_zoom`
    re-sends a set inset).
  - `src/platform.rs` (`PlatformInputHandler`): `bounds_for_range` and
    `selected_bounds` return `to_platform` bounds, and
    `character_index_for_point` reads a `from_platform` point, for IME.
  The app converts the coordinates it hands AppKit itself (native web view
  frames, `Window::resize`).

Other platforms keep the default no-op platform hooks. No GPL/AGPL application
source or patches were copied. Regression policy tests and the native AppKit
probe live in the parent crate.
