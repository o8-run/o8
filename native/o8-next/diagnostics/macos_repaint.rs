//! Native AppKit check. Never run through cargo's test/example feature graph.
#![allow(unexpected_cfgs)] // objc's older macros inspect a cargo-clippy cfg.
#[cfg(target_os = "macos")]
mod check {
    use cocoa::foundation::{NSPoint, NSRect, NSSize};
    use gpui::{
        App, Application, Context, FocusHandle, Keystroke, Render, Window, WindowOptions, canvas,
        div, prelude::*, px,
    };
    use objc::{
        class, msg_send,
        runtime::{BOOL, NO, Object, YES},
        sel, sel_impl,
    };
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use serde_json::{Value, json};
    use std::{
        cell::Cell,
        path::PathBuf,
        rc::Rc,
        time::{Duration, Instant},
    };

    struct Probe {
        value: u64,
        painted: Rc<Cell<(u64, Instant)>>,
        focus: FocusHandle,
        resize_event: Option<(u64, Instant)>,
        _bounds_subscription: gpui::Subscription,
    }
    impl Probe {
        fn new(
            painted: Rc<Cell<(u64, Instant)>>,
            window: &mut Window,
            cx: &mut Context<Self>,
        ) -> Self {
            let focus = cx.focus_handle();
            focus.focus(window);
            let bounds = cx.observe_window_bounds(window, |this, window, _| {
                if this.resize_event.is_none() {
                    this.resize_event = Some((window.frame_present_count(), Instant::now()));
                }
            });
            Self {
                value: 1,
                painted,
                focus,
                resize_event: None,
                _bounds_subscription: bounds,
            }
        }
    }
    impl Render for Probe {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let value = self.value;
            let painted = self.painted.clone();
            div()
                .size_full()
                .track_focus(&self.focus)
                .on_key_down(cx.listener(|this, _, _, cx| {
                    this.value += 1;
                    cx.notify();
                }))
                .child(format!("Repaint generation {value}"))
                .child(
                    canvas(
                        |_, _, _| (),
                        move |_, _, _, _| painted.set((value, Instant::now())),
                    )
                    .size(px(1.)),
                )
        }
    }
    fn require(ok: bool, message: &str) {
        if !ok {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
    // The App owns the GPUI window throughout the probe. Native messages use
    // this pointer only on the foreground executor while that window is alive.
    fn native(window: &Window) -> *mut Object {
        let RawWindowHandle::AppKit(handle) =
            HasWindowHandle::window_handle(window).unwrap().as_raw()
        else {
            panic!("AppKit handle required")
        };
        unsafe { msg_send![handle.ns_view.as_ptr() as *mut Object, window] }
    }
    fn invisible(window: *mut Object) {
        // Safety: this is the live NSWindow returned by our own GPUI context.
        unsafe {
            let _: () = msg_send![window, setAlphaValue: 0.0_f64];
            let _: () = msg_send![window, setIgnoresMouseEvents: YES];
            let _: () = msg_send![window, setAnimationBehavior: 2_isize];
            let alpha: f64 = msg_send![window, alphaValue];
            require(alpha == 0.0, "Probe must remain fully transparent");
            let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
            let active: BOOL = msg_send![app, isActive];
            require(active == NO, "Probe must never activate its application");
        }
    }
    fn transition(window: *mut Object, name: &str) -> Value {
        invisible(window);
        // Safety: only our transparent, non-activating window receives these
        // AppKit messages. No HID events, other apps or global activation APIs.
        unsafe {
            match name {
                "occluded" | "unhide" => {
                    let _: () = msg_send![window, orderBack: std::ptr::null_mut::<Object>()];
                }
                "hide" => {
                    let _: () = msg_send![window, orderOut: std::ptr::null_mut::<Object>()];
                }
                "resize" => {
                    let _: () = msg_send![window, setContentSize: NSSize::new(740.0, 520.0)];
                }
                "display" => {
                    let screens: *mut Object = msg_send![class!(NSScreen), screens];
                    let count: usize = msg_send![screens, count];
                    if count > 1 {
                        let current: *mut Object = msg_send![window, screen];
                        for index in 0..count {
                            let screen: *mut Object = msg_send![screens, objectAtIndex: index];
                            if screen == current {
                                continue;
                            }
                            let frame: NSRect = msg_send![screen, frame];
                            let own: NSRect = msg_send![window, frame];
                            let point = NSPoint::new(
                                frame.origin.x + (frame.size.width - own.size.width) / 2.0,
                                frame.origin.y + (frame.size.height - own.size.height) / 2.0,
                            );
                            let _: () = msg_send![window, setFrameOrigin: point];
                            let moved: *mut Object = msg_send![window, screen];
                            require(
                                moved == screen,
                                "Transparent window must reach the other display",
                            );
                            invisible(window);
                            return json!({"displays":count,"method":"native transparent move"});
                        }
                    }
                    let _: () =
                        msg_send![window, windowDidChangeScreen: std::ptr::null_mut::<Object>()];
                    let _: () = msg_send![window, windowDidChangeOcclusionState: std::ptr::null_mut::<Object>()];
                    return json!({"displays":count,"method":"screen-change and occlusion notifications"});
                }
                "minimize-notification" | "restore-notification" => {}
                _ => return Value::Null,
            }
            // Alpha-zero windows remain occluded. Deliver the native delegate
            // notification explicitly as well as actual hide/order operations.
            let _: () =
                msg_send![window, windowDidChangeOcclusionState: std::ptr::null_mut::<Object>()];
        }
        invisible(window);
        json!({"method":name,"alpha":0,"activated":false})
    }
    pub fn run() {
        require(
            !Window::uses_test_frame_driver(),
            "Native probe refuses GPUI test-support's manual draw loop",
        );
        let output = PathBuf::from(
            std::env::args()
                .nth(1)
                .expect("Pass an absolute receipt file"),
        );
        require(output.is_absolute(), "Pass an absolute receipt file");
        Application::headless().run(move |cx: &mut App| {
            let painted = Rc::new(Cell::new((0, Instant::now())));
            let target = painted.clone();
            let handle = cx.open_window(WindowOptions { show:false, focus:false, ..Default::default() }, |window, cx| cx.new(|cx| Probe::new(target, window, cx))).unwrap();
            cx.spawn(async move |cx| {
                let mut stages=vec![];
                cx.background_executor().timer(Duration::from_millis(250)).await;
                let own=handle.update(cx, |_,window,_| native(window)).unwrap();
                invisible(own);
                let initial_presents=handle.update(cx,|_,window,_| window.frame_present_count()).unwrap();
                let initial=painted.get().0==1 && initial_presents>0;
                stages.push(json!({"stage":"initial","expected":1,"painted":painted.get().0,"presents":initial_presents,"passed":initial}));
                let mut ok=initial;
                for (index,name) in ["hidden-data","input","resize","occluded","hide","unhide","display","minimize-notification","restore-notification","next-frame"].into_iter().enumerate() {
                    let expected=index as u64+2;
                    let prior_presents=handle.update(cx,|probe,window,_| {
                        probe.resize_event=None;
                        window.frame_present_count()
                    }).unwrap();
                    let sent=Instant::now();
                    let details=transition(own,name);
                    let transition_ms=sent.elapsed().as_secs_f64()*1000.0;
                    let data_presents=handle.update(cx,|_,window,_| window.frame_present_count()).unwrap();
                    let data_sent=Instant::now();
                    if name=="input" {
                        gpui::AnyWindowHandle::from(handle).update(cx, |_,window,cx| {
                            window.dispatch_keystroke(Keystroke::parse("a").unwrap(),cx);
                        }).unwrap();
                    } else {
                        handle.update(cx, |probe,window,cx| {
                            probe.value=expected;
                            if name=="next-frame" { window.on_next_frame(|window,_| window.refresh()); }
                            else { cx.notify(); }
                        }).unwrap();
                    }
                    cx.background_executor().timer(Duration::from_millis(40)).await;
                    let (value,paint_at)=painted.get();
                    let submitted=handle.update(cx,|_,window,_| window.frame_present_time(data_presents)).unwrap();
                    let at=submitted.unwrap_or(paint_at);
                    let presents=handle.update(cx,|_,window,_| window.frame_present_count()).unwrap()-prior_presents;
                    let latency=at.saturating_duration_since(data_sent).as_secs_f64()*1000.0;
                    let first=handle.update(cx,|_,window,_| window.frame_present_time(prior_presents)).unwrap();
                    let first_ms=first.map(|at| at.saturating_duration_since(sent).as_secs_f64()*1000.0);
                    let hz: isize=unsafe { let screen:*mut Object=msg_send![own,screen]; msg_send![screen,maximumFramesPerSecond] };
                    let budget=1000.0/(hz.max(1) as f64);
                    // Time the actual delivered bounds event. AppKit's setter
                    // can do platform work before delivering that notification.
                    // The later data update has its own independent deadline.
                    let resize_ms=handle.update(cx,|probe,window,_| {
                        probe.resize_event.and_then(|(count,event)| {
                            window.frame_present_time(count).filter(|at| *at>=event)
                                .map(|at| at.duration_since(event).as_secs_f64()*1000.0)
                        })
                    }).unwrap();
                    let resize_ok=name!="resize" || resize_ms.is_some_and(|ms| ms<=budget);
                    let passed=value==expected && submitted.is_some() && at>=data_sent && latency<=budget && presents>0 && resize_ok;
                    ok &= passed;
                    cx.background_executor().timer(Duration::from_millis(180)).await;
                    let before=handle.update(cx,|_,window,_| window.frame_request_count()).unwrap();
                    cx.background_executor().timer(Duration::from_millis(120)).await;
                    let after=handle.update(cx,|_,window,_| window.frame_request_count()).unwrap();
                    ok &= before==after;
                    stages.push(json!({"stage":name,"expected":expected,"painted":value,"dataSubmitted":submitted.is_some(),"paintMs":latency,"resizeEventToFrameMs":resize_ms,"firstTransitionFrameMs":first_ms,"nativeTransitionMs":transition_ms,"presents":presents,"frameBudgetMs":budget,"idleFrameChecks":after-before,"passed":passed && before==after,"details":details}));
                    invisible(own);
                }
                let retired=cx.update(|cx| cx.open_window(WindowOptions{show:false,focus:false,..Default::default()},|window,cx|cx.new(|cx| {
                    Probe::new(Rc::new(Cell::new((0,Instant::now()))),window,cx)
                })).unwrap()).unwrap();
                retired.update(cx,|_,window,cx| {window.refresh();cx.notify();window.remove_window();}).unwrap();
                cx.background_executor().timer(Duration::from_millis(150)).await;
                let retained=cx.update(|cx|cx.windows().len()).unwrap();
                ok &= retained==1;
                stages.push(json!({"stage":"close-with-queued-frame","remainingWindows":retained,"passed":retained==1}));
                std::fs::write(output,serde_json::to_vec_pretty(&json!({"testSupport":false,"showInitially":false,"alphaWhenOrdered":0,"focus":false,"passed":ok,"stages":stages})).unwrap()).unwrap();
                require(ok,"Native repaint, latency or idle-driver assertion failed");
                cx.update(|cx|cx.quit()).unwrap();
            }).detach();
        });
    }
}
fn main() {
    #[cfg(target_os = "macos")]
    check::run();
    #[cfg(not(target_os = "macos"))]
    panic!("This diagnostic requires macOS");
}
