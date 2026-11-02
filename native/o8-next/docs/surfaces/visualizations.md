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
visualization control. Linux and Windows show the card title and this error and
retry row without loading a browser engine.

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
builds exclude the WebKit host.
