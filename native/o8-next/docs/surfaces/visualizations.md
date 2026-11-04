# Transcript visualization cards

Visualization tool results produce a `visualization` transcript node after the
message prose. This kind is separate from media and images. The existing
`/api/visualizations/<id>` read accepts a per-view `nativeNonce` and returns the
shared sealed document, including the chart and control runtime. Authorization
is the same as an ordinary document read.

On macOS, a WKWebView holds the document inside a dedicated clipping NSView.
The retained GPUI row reports the full card bounds and current transcript mask
on each prepaint. The native clip uses their intersection, while the web view
keeps the full document size and its offset within the clip. An empty
intersection hides the view. A GPUI element-state lease hides the view when its
row, pane, conversation or window leaves the rendered scene, including cached
scenes. Streaming prose retains the card instance.
WebKit handles controls and document scrolling first. Its unhandled-wheel
callback forwards remaining scroll input to the transcript without adding a
document message handler.

The reference supplies the initial height. Valid resize messages round upward
and clamp to the current chat's 80 through 1800 pixel bounds. Missing documents,
load failures and the 12 second readiness timeout show an error and a Retry
visualization control. Windows shows the card title and this error and retry row
without loading a browser engine.

On Linux, the same executable's private `--render-visualization` entry point
hosts the sealed document in an offscreen WebKitGTK view. The card passes the
document, width, theme and saved state over stdin. The helper returns a PNG,
reported height and any bounded presentation state over stdout. No document is
written to disk. GPUI paints the PNG inside the retained row's existing clip.
Width changes over four pixels and theme changes schedule a render after a
180 ms debounce, with at most one helper per card. An obsolete result cannot
replace a newer width or theme. The parent bounds startup, pipe I/O, rendering
and snapshotting to 12 seconds and kills the helper's private process group on
completion, timeout or cancellation. The helper also has a hard 12 second
watchdog. Dropping or retrying a card cancels its helper.
The helper retains the native session-bus address, or starts a private
`dbus-run-session` inside the same bounded process group when no address exists.

The Linux context uses ephemeral website data and enables the WebKit process
sandbox before creating the view. It keeps the sealed opaque frames and their
content policies, permits only the initial blank host and inert frame loads,
and refuses subsequent navigation, new windows, downloads and permissions.
File access, clipboard access, local storage, WebRTC and automatic popups are
disabled. A top-frame relay and isolated script world expose only height and
bounded state messages, validated by the shared Rust protocol. Application
credentials are absent from the helper environment. This mode is a static
picture: interaction, later page-driven resizing and live state remain open.
Linux builds require the WebKitGTK 4.1 and GTK 3 development packages; installed
applications require their runtime libraries. DEB and RPM metadata declare
those dependencies and the D-Bus daemon. AppImage hosts must provide them as
system prerequisites.

The system web view uses a nonpersistent website data store and a nil base URL.
The payload stays in the same opaque, scripts-only frame used by the current
chat. Its sealed scripts, WebRTC guard, content policies and no-referrer policy
remain in place. A navigation delegate permits only the initial blank host, the inert iframe bootstrap and
its initial opaque srcdoc, each once. It refuses later navigation and new
windows. No file URL or local-server origin is loaded by WebKit.

Exactly one script message handler accepts bounded string messages from the
trusted main frame. The nonce, message type, finite height and bounded JSON
state are validated again in Rust. The handler cannot invoke application routes
or start turns. Theme and state enter through JavaScript-dispatched messages
with the same names and nonce as the iframe protocol. The native relay uses a
separate event to avoid treating its own outbound state as new inbound state.

View state uses the reference's root ID across revisions. Small validated JSON
snapshots are saved atomically with private file permissions and restored before
sending state to the loaded document. `O8_NEXT_VIEW_STATE_DIR` can select a
disposable presentation-state directory for acceptance runs.

`visualization_tests.rs` exercises persisted history, message placement, sizing,
missing-document reads and retry. `tests/visualization_cli.rs` runs the production
WebKit host against the production visualization route. Its document attempts
network access, navigation, a popup, parent-document access and an unknown
message handler, then receives theme and restored control state. Non-macOS
builds exclude the macOS host. Linux-only tests in `visualizations/linux_tests.rs`
exercise policy and parsing without a display and drive a card through the real
helper under Xvfb, including saved state, theme and width refresh. They print a
skip reason when no display or WebKitGTK is available. CI's Linux shell job
provides a display and the built production binary for this test.
