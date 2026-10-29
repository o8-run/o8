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

Other platforms keep the default no-op platform hooks. No GPL/AGPL application
source or patches were copied. Regression policy tests and the native AppKit
probe live in the parent crate.
