//! Native regression probe, executed on the OS main thread by Cargo's example entry.
//! Uses only owned windows outside the visible desktop; never posts global input.
#[cfg(target_os = "macos")]
#[path = "../src/shell_material.rs"]
mod material;
#[cfg(target_os = "macos")]
#[path = "../src/theme.rs"]
mod theme;
#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use cocoa::{
        appkit::NSView,
        base::id,
        foundation::{NSPoint, NSRect, NSSize},
    };
    use gpui::{prelude::*, *};
    use objc::{class, msg_send, sel, sel_impl};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::{cell::Cell, ffi::c_void, path::PathBuf, rc::Rc, time::Duration};

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

    fn click(window: &mut Window, cx: &mut App) {
        let position = point(
            window.viewport_size().width / 2.,
            window.viewport_size().height / 2.,
        );
        let RawWindowHandle::AppKit(handle) =
            HasWindowHandle::window_handle(window).unwrap().as_raw()
        else {
            panic!("AppKit window")
        };
        unsafe {
            let content = handle.ns_view.as_ptr() as id;
            let parent = NSView::superview(content);
            let point: NSPoint = msg_send![content, convertPoint:NSPoint::new(f32::from(position.x) as f64, f32::from(position.y) as f64) toView:parent];
            let hit: id = msg_send![parent, hitTest:point];
            let reaches_content: cocoa::base::BOOL = msg_send![hit, isDescendantOf:content];
            assert!(
                reaches_content != cocoa::base::NO,
                "system material must not intercept the native hit test"
            );
        }
        window.dispatch_event(
            MouseDownEvent {
                button: MouseButton::Left,
                position,
                modifiers: Modifiers::default(),
                click_count: 1,
                first_mouse: false,
            }
            .into(),
            cx,
        );
        window.dispatch_event(
            MouseUpEvent {
                button: MouseButton::Left,
                position,
                modifiers: Modifiers::default(),
                click_count: 1,
            }
            .into(),
            cx,
        );
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
            for y in 2..height - 2 {
                for x in 2..width - 2 {
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
        let directory = PathBuf::from(
            std::env::var("O8_NEXT_OCCLUSION_DIR").expect("explicit output directory"),
        );
        assert!(directory.is_absolute() && directory.is_dir());
        assert!(theme::glass(), "run with O8_NEXT_APPEARANCE=glass");
        let reduced = std::env::args().any(|arg| arg == "--reduced");
        let painted = Rc::new(Cell::new(false));
        let clicked = Rc::new(Cell::new(0));
        Application::headless().run(move |cx: &mut App| {
            let bounds = Some(WindowBounds::Windowed(Bounds::new(point(px(-10000.),px(-10000.)), size(px(768.),px(576.)))));
            let _backdrop = cx.open_window(WindowOptions { focus:false, show:true, titlebar:None, window_bounds:bounds, ..Default::default() }, |_,cx| cx.new(|_|Backdrop)).unwrap();
            let background = if reduced { material::background_for(false, true) } else { material::background(false) };
            let handle = cx.open_window(WindowOptions { focus:false, show:true, titlebar:None, window_bounds:bounds, window_background:background, ..Default::default() }, |window,cx| {
                let glass = if reduced { material::apply_for(window, false, true) } else { material::apply(window, false) };
                assert_eq!(glass, !reduced, "native material install or fallback");
                cx.new(|_| Proof { glass, painted:painted.clone(), clicked:clicked.clone() })
            }).unwrap();
            cx.spawn(async move |cx| {
                for _ in 0..250 {
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                    if painted.get() { break; }
                }
                assert!(painted.get(), "real GPUI scene must paint");
                cx.background_executor().timer(Duration::from_millis(200)).await;
                let ink = handle.update(cx, |_,window,cx| {
                    assert!(!window.is_window_active(), "probe must never activate");
                    assert!(window.window_bounds().get_bounds().origin.x < px(-9000.), "probe remains outside the visible desktop");
                    let ink = capture(window, &directory.join(if reduced {"reduced.png"} else {"glass.png"}), reduced);
                    click(window,cx); ink
                }).unwrap();
                assert_eq!(clicked.get(),1,"native hit testing and GPUI dispatch must reach the action");
                std::fs::write(directory.join(if reduced {"reduced.json"} else {"glass.json"}), format!("{{\"contrastTextPixels\":{ink},\"clicks\":1,\"reducedPolicyFixture\":{reduced},\"activated\":false}}\n")).unwrap();
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
