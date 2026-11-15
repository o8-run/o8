# Canvas, slice 1

`experimentalCanvas` in operator defaults enables **Open Canvas** in the native
global command palette (Cmd/Ctrl+Shift+P). The surface supplies **Add packet
diff**, **Reset zoom**, and **Fit all cards**. Reset and fit also appear as commands while Canvas is active.
Turning the setting off removes the surface's tabs and commands and retains its
saved layouts.

Drag the background or scroll over it to pan. Modifier-scroll and pinch zoom
around the pointer. Drag a card's header to move it, drag its bottom-right corner
to resize it, press it to raise it, and use its close control to remove it. Input
updates geometry directly. The header is one line with an ellipsis for long titles.

The canvas scales card positions and viewport sizes. The embedded native
`DiffSurface` reflows its existing virtualized rows at the current card viewport;
its text keeps its native size. Packet reads, syntax highlighting, file selection, split mode, and review behavior belong to
that existing entity, not to the canvas. This slice opens packet diffs only.

## Saved layout

The existing native shell-state writer saves `canvas_layouts`, keyed by project
ID, with a workspace fallback when no project is selected. Projects sharing a
repository keep separate layouts. Repository tabs within one project share the
same canvas entity. Each version 1 layout saves its camera and a back-to-front
`diff` array. Each diff saves `laneId`, `title`, and `x`, `y`, `w`, `h`.

Classic's `canvas-persistence.ts` stores `o8:canvas-layout:v1` in browser
localStorage, not on the server. Native retains the geometry and diff identity
field vocabulary but does not read that browser storage. No classic file changed.
The native writer coalesces snapshots off the input thread and flushes them on
window close. A write failure uses the existing shell notice and retry path.

Geometry is bounded to keep Fit all useful: card positions are within ±5000
logical pixels, dimensions within 320–4000 by 200–4000, and zoom within 1–200%.
There are at most 32 diff cards, one per packet. Restoring an unsupported layout
version starts an empty layout; invalid geometry is normalized.

## Verification boundaries

`canvas/tests.rs` drives the shell command palette, actual controls, pointer and
wheel events, production fixture routes, and disk-backed shell state.
`canvas/geometry.rs` tests coordinate transforms, pointer anchoring, size limits,
and fitting distant cards. The shell feature probe fails before registration.

GPUI's macOS event bridge forwards `magnifyWithEvent:` as a distinct normalized
pinch delta, with zero distance for ordinary scroll views. Its platform-independent
conversion and the canvas consumer are exercised headlessly. The selector registration and AppKit event conversion require a Mac
compile and hardware gesture check, along with macOS rendering screenshots.
