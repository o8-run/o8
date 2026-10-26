//! Native regression probe, executed on the OS main thread by Cargo's example entry.
//! Uses owned inactive windows on a known screen; never posts global input.
#[path = "../src/shell_material.rs"]
mod material;
#[path = "../src/theme.rs"]
mod theme;
use gpui::{
    App, Bounds, Context, IntoElement, Pixels, Render, Window, WindowBounds, WindowHandle,
    WindowOptions, canvas, div, fill, point, prelude::*, px, rgb, size,
};
use std::{cell::Cell, rc::Rc};

struct Backdrop;
impl Render for Backdrop {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        canvas(
            |bounds, _, _| bounds,
            |bounds: Bounds<Pixels>, _, window, _| {
                let colors = [rgb(0x17518b), rgb(0x8b245f), rgb(0x287150)];
                for y in 0..18 {
                    for x in 0..24 {
                        window.paint_quad(fill(
                            Bounds::new(
                                point(
                                    bounds.left() + px(x as f32 * 32.),
                                    bounds.top() + px(y as f32 * 32.),
                                ),
                                size(px(32.), px(32.)),
                            ),
                            colors[(x + y) % colors.len()],
                        ));
                    }
                }
            },
        )
        .size_full()
    }
}
struct Proof {
    glass: bool,
    painted: Rc<Cell<bool>>,
    clicked: Rc<Cell<usize>>,
}
impl Render for Proof {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let painted = self.painted.clone();
        let clicked = self.clicked.clone();
        div()
            .size_full()
            .relative()
            .flex()
            .items_center()
            .justify_center()
            .bg(if self.glass {
                theme::current().background
            } else {
                theme::plain_background()
            })
            .when(self.glass, |view| view.child(material::veil()))
            .child(
                div()
                    .id("proof-action")
                    .w(px(240.))
                    .h(px(80.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .font_family(theme::current().font_ui)
                    .text_size(px(24.))
                    .text_color(theme::current().text)
                    .child("Readable text · Continue")
                    .on_click(move |_, _, _| clicked.set(clicked.get() + 1)),
            )
            .child(
                canvas(|_, _, _| (), move |_, _, _, _| painted.set(true))
                    .absolute()
                    .size(px(1.)),
            )
    }
}

fn probe_bounds(cx: &App) -> Bounds<Pixels> {
    let display = cx
        .primary_display()
        .expect("native probe requires a screen");
    Bounds::centered(Some(display.id()), size(px(768.), px(576.)), cx)
}
fn open_probe(
    cx: &mut App,
    bounds: Bounds<Pixels>,
    offscreen: bool,
    reduced: bool,
    painted: Rc<Cell<bool>>,
    clicked: Rc<Cell<usize>>,
) -> WindowHandle<Proof> {
    let background = if reduced {
        material::background_for(offscreen, true)
    } else {
        material::background(offscreen)
    };
    cx.open_window(
        WindowOptions {
            focus: false,
            show: !offscreen,
            titlebar: None,
            display_id: cx.primary_display().map(|display| display.id()),
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_background: background,
            ..Default::default()
        },
        |window, cx| {
            let glass = if reduced {
                material::apply_for(window, offscreen, true)
            } else {
                material::apply(window, offscreen)
            };
            assert_eq!(
                glass,
                cfg!(target_os = "macos") && theme::glass() && !offscreen && !reduced,
                "native material install or fallback"
            );
            cx.new(|_| Proof {
                glass,
                painted,
                clicked,
            })
        },
    )
    .unwrap()
}
fn complete_frame<R>(window: &mut Window, complete: impl FnOnce(&mut Window) -> R) -> R {
    assert!(!window.is_window_active(), "probe must never activate");
    // AppKit can constrain or reposition requested bounds. Capture and native
    // hit testing use this window's actual frame and local coordinates.
    let bounds = window.bounds();
    assert!(
        [
            bounds.origin.x,
            bounds.origin.y,
            bounds.size.width,
            bounds.size.height
        ]
        .into_iter()
        .all(|value| f32::from(value).is_finite())
            && bounds.size.width >= px(600.)
            && bounds.size.height >= px(400.),
        "actual probe frame must have capturable dimensions: {bounds:?}"
    );
    complete(window)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Modifiers, TestAppContext, VisualTestContext};

    #[gpui::test]
    fn probe_window_starts_on_known_screen(cx: &mut TestAppContext) {
        let handle = cx.update(|app| {
            open_probe(
                app,
                probe_bounds(app),
                true,
                true,
                Rc::new(Cell::new(false)),
                Rc::new(Cell::new(0)),
            )
        });
        let mut visual = VisualTestContext::from_window(handle.into(), cx);
        visual.update(|window, app| {
            let screen = app.primary_display().unwrap().bounds();
            let actual = window.bounds();
            assert!(
                actual.left() >= screen.left()
                    && actual.right() <= screen.right()
                    && actual.top() >= screen.top()
                    && actual.bottom() <= screen.bottom(),
                "probe must start on the known screen: {actual:?} in {screen:?}"
            );
        });
    }

    #[gpui::test]
    fn adjusted_frame_reaches_capture_callback_and_click(cx: &mut TestAppContext) {
        for x in [-728., 0., 128.] {
            let painted = Rc::new(Cell::new(false));
            let clicked = Rc::new(Cell::new(0));
            let handle = cx.update(|app| {
                open_probe(
                    app,
                    Bounds::new(point(px(x), px(32.)), size(px(768.), px(576.))),
                    true,
                    true,
                    painted.clone(),
                    clicked.clone(),
                )
            });
            let mut visual = VisualTestContext::from_window(handle.into(), cx);
            let reached = Cell::new(false);
            visual.update(|window, app| {
                window.refresh();
                window.draw(app).clear();
                complete_frame(window, |window| {
                    assert_eq!(window.bounds().origin.x, px(x));
                    reached.set(true);
                });
            });
            assert!(
                painted.get() && reached.get(),
                "actual repositioned frame must reach the capture callback"
            );
            visual.simulate_click(point(px(384.), px(288.)), Modifiers::default());
            assert_eq!(
                clicked.get(),
                1,
                "public GPUI click helper must reach the real proof action"
            );
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use cocoa::{
        appkit::{NSEvent, NSEventModifierFlags, NSEventType, NSView},
        base::{id, nil},
        foundation::{NSInteger, NSPoint, NSRect, NSSize},
    };
    use gpui::{Application, prelude::*};
    use objc::{class, msg_send, sel, sel_impl};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::{cell::Cell, ffi::c_void, rc::Rc, time::Duration};

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGWindowListCreateImage(
            rect: NSRect,
            options: u32,
            window: u32,
            image_options: u32,
        ) -> *mut c_void;
        fn CGImageGetWidth(image: *mut c_void) -> usize;
        fn CGImageGetHeight(image: *mut c_void) -> usize;
        fn CGImageRelease(image: *mut c_void);
        fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
        fn CGColorSpaceRelease(space: *mut c_void);
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits: usize,
            stride: usize,
            space: *mut c_void,
            bitmap_info: u32,
        ) -> *mut c_void;
        fn CGContextDrawImage(context: *mut c_void, rect: NSRect, image: *mut c_void);
        fn CGContextRelease(context: *mut c_void);
    }

    struct NativeClick {
        target: id,
        events: [id; 2],
    }
    impl NativeClick {
        fn prepare(window: &Window) -> Self {
            let position = NSPoint::new(
                f32::from(window.viewport_size().width / 2.) as f64,
                f32::from(window.viewport_size().height / 2.) as f64,
            );
            let RawWindowHandle::AppKit(handle) =
                HasWindowHandle::window_handle(window).unwrap().as_raw()
            else {
                panic!("AppKit window")
            };
            unsafe {
                let content = handle.ns_view.as_ptr() as id;
                let parent = NSView::superview(content);
                let point: NSPoint = msg_send![content, convertPoint:position toView:parent];
                let hit: id = msg_send![parent, hitTest:point];
                let reaches_content: cocoa::base::BOOL = msg_send![hit, isDescendantOf:content];
                assert!(
                    reaches_content != cocoa::base::NO,
                    "system material must not intercept the native hit test"
                );
                let native: id = msg_send![content, window];
                let number: NSInteger = msg_send![native, windowNumber];
                let location: NSPoint = msg_send![content, convertPoint:position toView:nil];
                let events = [NSEventType::NSLeftMouseDown, NSEventType::NSLeftMouseUp].map(|kind| {
                    let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure_(
                        nil, kind, location, NSEventModifierFlags::empty(), 0., number, nil, 1, 1, 1.,
                    );
                    assert!(!event.is_null(), "window-local native event");
                    let _: id = msg_send![event, retain];
                    event
                });
                let _: id = msg_send![hit, retain];
                Self {
                    target: hit,
                    events,
                }
            }
        }
        fn send(&self) {
            // Called outside handle.update: native delivery re-enters GPUI's own
            // input callback. No global queue, focus change or private GPUI API.
            unsafe {
                let _: () = msg_send![self.target, mouseDown:self.events[0]];
                let _: () = msg_send![self.target, mouseUp:self.events[1]];
            }
        }
    }
    impl Drop for NativeClick {
        fn drop(&mut self) {
            unsafe {
                for event in self.events {
                    let _: () = msg_send![event, release];
                }
                let _: () = msg_send![self.target, release];
            }
        }
    }
    fn capture(window: &Window, output: &std::path::Path, reduced: bool) -> usize {
        let RawWindowHandle::AppKit(handle) =
            HasWindowHandle::window_handle(window).unwrap().as_raw()
        else {
            panic!("AppKit window")
        };
        unsafe {
            let native: id = msg_send![handle.ns_view.as_ptr() as id, window];
            let number: i64 = msg_send![native, windowNumber];
            let image = CGWindowListCreateImage(
                NSRect::new(
                    NSPoint::new(f64::INFINITY, f64::INFINITY),
                    NSSize::new(0., 0.),
                ),
                8,
                number as u32,
                1,
            );
            assert!(
                !image.is_null(),
                "owned hidden window must yield pixels; an unavailable capture is a failure"
            );
            let (width, height) = (CGImageGetWidth(image), CGImageGetHeight(image));
            assert!(width >= 600 && height >= 400);
            let mut rgba = vec![0u8; width * height * 4];
            let space = CGColorSpaceCreateDeviceRGB();
            let context = CGBitmapContextCreate(
                rgba.as_mut_ptr().cast(),
                width,
                height,
                8,
                width * 4,
                space,
                1 | 0x4000,
            );
            assert!(!context.is_null());
            CGContextDrawImage(
                context,
                NSRect::new(
                    NSPoint::new(0., 0.),
                    NSSize::new(width as f64, height as f64),
                ),
                image,
            );
            CGContextRelease(context);
            CGColorSpaceRelease(space);
            let mut ink = 0;
            for y in height / 3..height * 2 / 3 {
                for x in width / 4..width * 3 / 4 {
                    let pixel = &rgba[(y * width + x) * 4..][..3];
                    if pixel.iter().all(|v| *v > 175)
                        && [-2isize, 2].iter().any(|dx| {
                            rgba[(y * width + (x as isize + dx) as usize) * 4..][..3]
                                .iter()
                                .all(|v| *v < 140)
                        })
                    {
                        ink += 1;
                    }
                }
            }
            assert!(
                ink > 80,
                "readable high-contrast text pixels must survive material compositing: {ink}"
            );
            if reduced {
                let pixel = &rgba[((height / 2) * width + width - 20) * 4..][..3];
                assert!(
                    pixel
                        .iter()
                        .zip([28i32, 28, 30])
                        .all(|(actual, expected)| (*actual as i32 - expected).abs() <= 8),
                    "reduced-transparency root must be solid dark: {pixel:?}"
                );
            }
            let bitmap: id = msg_send![class!(NSBitmapImageRep), alloc];
            let bitmap: id = msg_send![bitmap, initWithCGImage:image];
            let properties: id = msg_send![class!(NSDictionary), dictionary];
            let png: id = msg_send![bitmap, representationUsingType:4u64 properties:properties];
            let bytes: *const u8 = msg_send![png, bytes];
            let length: usize = msg_send![png, length];
            assert!(!bytes.is_null() && length > 1000);
            std::fs::write(output, std::slice::from_raw_parts(bytes, length)).unwrap();
            let _: () = msg_send![bitmap, release];
            CGImageRelease(image);
            ink
        }
    }
    pub fn run() {
        let directory = std::fs::canonicalize(
            std::env::var("O8_NEXT_OCCLUSION_DIR").expect("explicit output directory"),
        )
        .expect("owned output directory");
        assert!(directory.is_dir());
        assert!(theme::glass(), "run with O8_NEXT_APPEARANCE=glass");
        let reduced = std::env::args().any(|arg| arg == "--reduced");
        let painted = Rc::new(Cell::new(false));
        let clicked = Rc::new(Cell::new(0));
        Application::headless().run(move |cx: &mut App| {
            let bounds = Some(WindowBounds::Windowed(probe_bounds(cx)));
            let _backdrop = cx.open_window(WindowOptions { focus:false, show:true, titlebar:None, display_id:cx.primary_display().map(|display|display.id()), window_bounds:bounds, ..Default::default() }, |_,cx| cx.new(|_|Backdrop)).unwrap();
            let handle = open_probe(cx, bounds.unwrap().get_bounds(), false, reduced, painted.clone(), clicked.clone());
            cx.spawn(async move |cx| {
                for _ in 0..250 {
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                    if painted.get() { break; }
                }
                assert!(painted.get(), "real GPUI scene must paint");
                cx.background_executor().timer(Duration::from_millis(200)).await;
                let (ink, click, frame) = handle.update(cx, |_,window,_| {
                    complete_frame(window, |window| {
                        let frame = window.bounds();
                        let ink = capture(window, &directory.join(if reduced {"reduced.png"} else {"glass.png"}), reduced);
                        (ink, NativeClick::prepare(window), frame)
                    })
                }).unwrap();
                click.send();
                drop(click);
                assert_eq!(clicked.get(),1,"native hit testing and GPUI dispatch must reach the action");
                handle.update(cx, |_,window,_| assert!(!window.is_window_active(), "native click must not activate the probe")).unwrap();
                let receipt = serde_json::json!({"contrastTextPixels":ink,"clicks":1,"reducedPolicyFixture":reduced,"activated":false,"actualFrame":[f32::from(frame.origin.x),f32::from(frame.origin.y),f32::from(frame.size.width),f32::from(frame.size.height)]});
                std::fs::write(directory.join(if reduced {"reduced.json"} else {"glass.json"}), serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
                cx.update(|cx|cx.quit()).unwrap();
            }).detach();
        });
    }
}
#[cfg(target_os = "macos")]
fn main() {
    macos::run();
}
#[cfg(not(target_os = "macos"))]
fn main() {
    println!("AppKit occlusion probe requires macOS");
}
