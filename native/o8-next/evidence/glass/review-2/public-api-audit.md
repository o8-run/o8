# Pinned API audit for the occlusion probe

Inspected the Cargo.lock GPUI 0.2.2 source, rather than inferring visibility from
method names. All shared rendering/window construction now compiles on Linux as
part of the actual window-occlusion Cargo example, even though native capture
and native event delivery remain macOS-only.

| Boundary | Pinned source | Visibility and use |
| --- | --- | --- |
| Root exports | gpui-0.2.2/src/gpui.rs | Public reexports of app, geometry, platform, window, elements and styles; shared imports are checked by Linux compilation. |
| Application | src/app.rs, Application | Public struct and public headless/run methods. The macOS entry starts on the process main thread. |
| App/window construction | src/app.rs, App::open_window, primary_display | Public methods; primary_display returns Rc of public PlatformDisplay. |
| Display/frame | src/platform.rs, PlatformDisplay and DisplayId; src/geometry.rs, Bounds::centered | Public trait, public opaque DisplayId and public Bounds helper. Use display.id(), never its private tuple field. |
| Options/handles | src/platform.rs, WindowOptions and WindowBounds; src/window.rs, WindowHandle::update | Public types/methods; options include public display_id and window_bounds fields. |
| Actual geometry | src/window.rs, Window::bounds, viewport_size, is_window_active | Public methods returning public Bounds/Size/Pixels/bool. Capture validates the actual frame, not the requested negative origin. |
| Shared rendering | Render, Context, IntoElement, canvas/div/fill/style APIs | Public exports; compiled in the example on Linux. |
| CPU regression entry | src/app/test_context.rs, TestAppContext::update and VisualTestContext::from_window/update/simulate_click | Public test-support API. These tests exercise real shared GPUI windows and callbacks, not native AppKit delivery. |

The rejected path is Window::dispatch_event (src/window.rs:3581). Its method is
public but its DispatchEventResult return type is pub(crate) at line 1273.
PlatformInput is public, but MouseDownEvent/MouseUpEvent do not implement Into
for it. The actual example's Linux check reproduced both E0277 failures and,
with explicit variants, both private-return-type failures. Both red tails are
retained. No dispatch_event call remains in the probe.

Native input now uses the public AppKit mouseDown:/mouseUp: responder interface
on the hit-tested owned view. GPUI registers those selectors to its input handler
in src/platform/mac/window.rs; conversion/dispatch stays inside GPUI. The probe
never names GPUI's private handler or return type.

The window-local NSEvent factory signature was checked in pinned cocoa 0.26.0
src/appkit.rs (NSEvent trait). Its arguments use public NSEventType,
NSEventModifierFlags, NSPoint and NSInteger. The latter two are publicly reexported
through cocoa::foundation from cocoa-foundation. Raw AppKit view handles use the
public raw-window-handle 0.6.2 interface already used by the material adapter.

Events and their hit-tested view are retained until delivery and then released.
Delivery happens after WindowHandle::update returns: native input re-enters
GPUI's AppCell and must not run while the update holds its mutable app borrow.
No global event queue or activation API is used. Active state is asserted both
before and after delivery.

This is a source audit, not a macOS compile or execution claim. The native
Cocoa/CoreGraphics portion still needs the reviewer build and run.
