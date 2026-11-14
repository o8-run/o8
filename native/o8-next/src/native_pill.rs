//! Passive dictation drawing. Capture and all interactive dock surfaces keep their owners.
#[cfg(test)]
use gpui::TestAppContext;
use gpui::{
    AnyWindowHandle, App, Application, Bounds, Context, Entity, IntoElement, Render, Window,
    WindowBackgroundAppearance, WindowBounds, WindowHandle, WindowKind, WindowOptions, div, point,
    prelude::*, px, size,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

static FRAMES: Mutex<VecDeque<Value>> = Mutex::new(VecDeque::new());
static WAKE: LazyLock<(async_channel::Sender<()>, async_channel::Receiver<()>)> =
    LazyLock::new(|| async_channel::bounded(1));

pub(crate) fn enqueue(frame: Value) {
    #[cfg(not(target_os = "macos"))]
    {
        crate::app_parent::browser_result(
            frame["id"].as_str().unwrap_or_default(),
            json!({"ok":false}),
        );
        return;
    }
    #[cfg(target_os = "macos")]
    enqueue_supported(frame);
}

#[cfg(any(target_os = "macos", test))]
fn enqueue_supported(frame: Value) {
    let mut queue = FRAMES.lock().unwrap();
    if queue.len() < 32 {
        queue.push_back(frame);
        let _ = WAKE.0.try_send(());
    } else {
        crate::app_parent::browser_result(
            frame["id"].as_str().unwrap_or_default(),
            json!({"ok":false}),
        );
    }
}
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub state: String,
    #[serde(default)]
    pub session: u64,
    #[serde(default)]
    pub audio_level: f32,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub pasted_text: Option<String>,
}
impl Snapshot {
    pub fn visible(&self) -> bool {
        matches!(
            self.state.as_str(),
            "requesting-mic" | "recording" | "transcribing" | "polishing" | "success" | "error"
        )
    }
    fn label(&self) -> &str {
        match self.state.as_str() {
            "requesting-mic" => "Connecting…",
            "recording" => "Listening",
            "transcribing" => "Transcribing",
            "polishing" => "Polishing",
            "success" => self
                .pasted_text
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("Pasted"),
            "error" => self.error.as_deref().unwrap_or("Mic error"),
            _ => "",
        }
    }
}
/// AppKit logical points, primary screen only, exactly as the web dock. Scale never enters placement.
pub(crate) fn placement(screen: [f64; 4], notch: f64) -> Option<[f64; 4]> {
    if !screen.into_iter().all(f64::is_finite)
        || screen[2] <= 0.
        || screen[3] <= 0.
        || !notch.is_finite()
        || notch < 0.
    {
        return None;
    }
    let width = 520_f64.min(screen[2]);
    let height = 120_f64.min(screen[3]);
    Some([
        screen[0] + (screen[2] - width) / 2.,
        screen[1] + screen[3] - notch - if notch > 0. { 4. } else { 0. } - height,
        width,
        height,
    ])
}

pub(crate) struct Pill {
    snapshot: Snapshot,
    heard: Instant,
    motion: crate::motion::Transition,
    shown: bool,
    target: bool,
    finish_pending: bool,
    finish_sent: bool,
}
impl Default for Pill {
    fn default() -> Self {
        Self {
            snapshot: Snapshot::default(),
            heard: Instant::now(),
            motion: crate::motion::Transition::new(160),
            shown: false,
            target: false,
            finish_pending: false,
            finish_sent: false,
        }
    }
}
impl Pill {
    fn expire(&mut self) {
        if self.heard.elapsed() > Duration::from_millis(750) && self.target {
            self.apply(Snapshot::default());
        }
    }
    fn finish(&mut self) {
        if self.target && self.snapshot.state == "recording" && !self.finish_sent {
            self.finish_pending = true;
            self.finish_sent = true;
        }
    }
    fn apply(&mut self, snapshot: Snapshot) {
        if snapshot.session != self.snapshot.session || snapshot.state != self.snapshot.state {
            self.finish_pending = false;
            self.finish_sent = false;
        }
        self.motion.set(snapshot.visible());
        self.target = snapshot.visible();
        if self.target {
            self.snapshot = snapshot;
        }
        self.heard = Instant::now();
    }
}
impl Render for Pill {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = crate::theme::current();
        let (opacity, moving) = self.motion.value();
        let listening = self.target && self.snapshot.state == "recording";
        if moving || listening {
            w.request_animation_frame();
        }
        let level = if self.snapshot.audio_level.is_finite() {
            self.snapshot.audio_level.clamp(0., 1.)
        } else {
            0.
        };
        div()
            .size_full()
            .flex()
            .justify_center()
            .items_start()
            .pt(px(8.))
            .child(
                div()
                    .id("native-dictation-pill")
                    .debug_selector(|| "native-dictation-pill".into())
                    .on_click(cx.listener(|pill, _, _, cx| {
                        pill.finish();
                        cx.notify();
                    }))
                    .when(listening, |d| {
                        d.cursor_pointer()
                            .hover(|s| s.bg(t.hover))
                            .active(|s| s.opacity(0.85))
                    })
                    .w(px(
                        if self.snapshot.state == "success" || self.snapshot.state == "error" {
                            420.
                        } else {
                            248.
                        },
                    ))
                    .h(px(44.))
                    .px(px(16.))
                    .rounded(px(22.))
                    .overflow_hidden()
                    .bg(t.surface_raised)
                    .border_1()
                    .border_color(t.border)
                    .text_color(match self.snapshot.state.as_str() {
                        "error" => t.danger,
                        "success" => t.success,
                        _ => t.text,
                    })
                    .text_size(px(12.))
                    .font_family(t.font_ui)
                    .font_weight(gpui::FontWeight::LIGHT)
                    .opacity(opacity)
                    .flex()
                    .items_center()
                    .justify_center()
                    .gap(px(8.))
                    .child(if listening {
                        let mut bars = div().flex().items_center().gap(px(3.)).h(px(22.));
                        for i in 0..26 {
                            let weight = 1. - ((i as f32 - 12.5) / 13.).abs();
                            bars = bars.child(
                                div()
                                    .w(px(2.))
                                    .h(px(2. + 18. * level * weight))
                                    .rounded(px(1.))
                                    .bg(t.accent),
                            );
                        }
                        bars.into_any_element()
                    } else {
                        div()
                            .child(self.snapshot.label().chars().take(100).collect::<String>())
                            .into_any_element()
                    })
                    .when(listening, |d| {
                        d.child(format!(
                            "{:02}:{:02}",
                            self.snapshot.duration_ms / 60000,
                            self.snapshot.duration_ms / 1000 % 60
                        ))
                    }),
            )
    }
}

fn expired(frame: &Value) -> bool {
    frame["expiresAt"].as_u64().unwrap_or(0)
        < std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
}

/// Queue events even if delivered by an observer while Pill is already leased.
/// AppKit presentation runs after the model lease is returned: setFrame can
/// synchronously invoke drawing, which needs to lease the same root entity.
fn dispatch(
    view: &Entity<Pill>,
    frame: Value,
    window: &Window,
    cx: &mut App,
    reply: impl FnOnce(Value) + 'static,
) {
    let view = view.downgrade();
    window.defer(cx, move |window, cx| {
        if expired(&frame) {
            reply(json!({"ok":false}));
            return;
        }
        let args = &frame["args"];
        let Some(view) = view.upgrade() else {
            reply(json!({"ok":false}));
            return;
        };
        let result = view.update(cx, |pill, cx| {
            match args["action"].as_str() {
                Some("prepare") => {
                    pill.apply(Snapshot::default());
                    pill.motion = crate::motion::Transition::settled(160, false);
                }
                Some("frame") => {
                    let Ok(snapshot) = serde_json::from_value::<Snapshot>(args["snapshot"].clone())
                    else {
                        return None;
                    };
                    pill.apply(snapshot);
                }
                Some("release") => pill.apply(Snapshot::default()),
                _ => return None,
            }
            let show = pill.target || pill.motion.value().1;
            pill.shown = show;
            cx.notify();
            let finish = if std::mem::take(&mut pill.finish_pending) {
                Some(pill.snapshot.session)
            } else {
                None
            };
            Some((
                show,
                pill.target && pill.snapshot.state == "recording",
                finish,
            ))
        });
        if let Some((show, interactive, finish)) = result {
            #[cfg(target_os = "macos")]
            macos::present(window, show, interactive);
            #[cfg(not(target_os = "macos"))]
            let _ = (window, show, interactive);
            let _ = WAKE.0.try_send(());
            reply(json!({"ok":true, "finishSession":finish}));
        } else {
            reply(json!({"ok":false}));
        }
    });
}

pub(crate) fn has_real_windows(cx: &App) -> bool {
    cx.windows()
        .iter()
        .any(|window| window.downcast::<Pill>().is_none())
}

async fn wait_for_work(
    visible: bool,
    receiver: &async_channel::Receiver<()>,
    executor: &gpui::BackgroundExecutor,
) {
    if visible {
        let mut timer = executor.timer(Duration::from_millis(16));
        crate::wake::next(receiver, &mut timer).await;
    } else {
        let _ = receiver.recv().await;
    }
}

/// One window, no activation or keyboard/input handlers. A lost feed expires locally.
pub(crate) fn install(cx: &mut App) {
    #[cfg(target_os = "macos")]
    cx.spawn(async move |cx| {
        let mut handle: Option<WindowHandle<Pill>> = None;
        let mut visible = false;
        loop {
            wait_for_work(visible, &WAKE.1, cx.background_executor()).await;
            let frames: Vec<_> = FRAMES.lock().unwrap().drain(..).collect();
            for frame in frames {
                let id = frame["id"].as_str().unwrap_or_default();
                if expired(&frame) {
                    crate::app_parent::browser_result(id, json!({"ok":false}));
                    continue;
                }
                if handle.is_none() && frame["args"]["action"] == "release" {
                    crate::app_parent::browser_result(id, json!({"ok":true}));
                    continue;
                }
                if handle.is_none() {
                    handle = cx
                        .update(|cx| {
                            cx.open_window(
                                WindowOptions {
                                    titlebar: None,
                                    focus: false,
                                    show: false,
                                    kind: WindowKind::PopUp,
                                    is_movable: false,
                                    is_resizable: false,
                                    is_minimizable: false,
                                    window_background: WindowBackgroundAppearance::Transparent,
                                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                        point(px(0.), px(0.)),
                                        size(px(520.), px(120.)),
                                    ))),
                                    ..Default::default()
                                },
                                |_, cx| cx.new(|_| Pill::default()),
                            )
                        })
                        .ok()
                        .and_then(Result::ok);
                }
                let id = id.to_string();
                if let Some(h) = handle {
                    let _ = AnyWindowHandle::from(h).update(cx, |root, window, cx| {
                        if let Ok(view) = root.downcast::<Pill>() {
                            dispatch(&view, frame.clone(), window, cx, move |ok| {
                                crate::app_parent::browser_result(&id, ok);
                            });
                        }
                    });
                } else {
                    crate::app_parent::browser_result(&id, json!({"ok":false}));
                }
            }
            visible = false;
            if let Some(h) = handle {
                let _ = AnyWindowHandle::from(h).update(cx, |root, window, cx| {
                    let Ok(view) = root.downcast::<Pill>() else {
                        return;
                    };
                    let (show, was_shown, interactive) = view.update(cx, |pill, cx| {
                        let was_active = pill.target;
                        pill.expire();
                        if was_active != pill.target {
                            cx.notify();
                        }
                        let show = pill.target || pill.shown && pill.motion.value().1;
                        let was_shown = pill.shown;
                        pill.shown = show;
                        (
                            show,
                            was_shown,
                            pill.target && pill.snapshot.state == "recording",
                        )
                    });
                    visible = show;
                    if show || was_shown {
                        macos::present(window, show, interactive);
                    }
                });
            }
        }
    })
    .detach();
    #[cfg(not(target_os = "macos"))]
    let _ = cx;
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use cocoa::{
        base::{NO, YES, id, nil},
        foundation::{NSPoint, NSRect, NSSize},
    };
    use objc::{
        class,
        declare::ClassDecl,
        msg_send,
        runtime::{Class, Object, Sel},
        sel, sel_impl,
    };
    use std::sync::OnceLock;
    // tree-sitter-rust 0.24 (theme_tests) cannot parse `unsafe extern "C"` blocks,
    // so the declaration reaches the parser only as macro token trees.
    macro_rules! panel_abi {
        ({ $($declaration:tt)* }) => {
            unsafe extern "C" { $($declaration)* }
        };
    }
    panel_abi! {
        {
            fn object_setClass(object: id, class: *const Class) -> *const Class;
        }
    }
    extern "C" fn never_key(_: &Object, _: Sel) -> cocoa::base::BOOL {
        NO
    }
    fn nonactivating_class(panel: id) -> *const Class {
        static CLASS: OnceLock<usize> = OnceLock::new();
        *CLASS.get_or_init(|| unsafe {
            let mut class =
                ClassDecl::new("O8DictationPanel", (&*panel).class()).expect("unique panel class");
            class.add_method(
                sel!(canBecomeKeyWindow),
                never_key as extern "C" fn(&Object, Sel) -> cocoa::base::BOOL,
            );
            class.add_method(
                sel!(canBecomeMainWindow),
                never_key as extern "C" fn(&Object, Sel) -> cocoa::base::BOOL,
            );
            class.register() as *const Class as usize
        }) as *const Class
    }
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Insets {
        top: f64,
        left: f64,
        bottom: f64,
        right: f64,
    }
    unsafe impl objc::Encode for Insets {
        fn encode() -> objc::Encoding {
            unsafe { objc::Encoding::from_str("{NSEdgeInsets=dddd}") }
        }
    }
    pub(super) fn present(window: &Window, visible: bool, interactive: bool) {
        let Ok(handle) = HasWindowHandle::window_handle(window) else {
            return;
        };
        let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
            return;
        };
        // GPUI owns this content view and NSPanel; calls stay on the UI thread.
        unsafe {
            let view = handle.ns_view.as_ptr() as id;
            let panel: id = msg_send![view, window];
            object_setClass(panel, nonactivating_class(panel));
            let _: () = msg_send![panel, setIgnoresMouseEvents: YES];
            let _: () = msg_send![panel, setHidesOnDeactivate: NO];
            let _: () = msg_send![panel, setLevel: 25_i64];
            if !visible {
                let _: () = msg_send![panel, orderOut: nil];
                return;
            }
            let screens: id = msg_send![class!(NSScreen), screens];
            let count: usize = msg_send![screens, count];
            if count == 0 {
                let _: () = msg_send![panel, orderOut: nil];
                return;
            }
            let screen: id = msg_send![screens, objectAtIndex: 0_usize];
            let rect: NSRect = msg_send![screen, frame];
            let insets: Insets = msg_send![screen, safeAreaInsets];
            if let Some([x, y, width, height]) = placement(
                [
                    rect.origin.x,
                    rect.origin.y,
                    rect.size.width,
                    rect.size.height,
                ],
                insets.top,
            ) {
                let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
                let _: () = msg_send![panel, setFrame: frame display: YES];
                let mouse: NSPoint = msg_send![class!(NSEvent), mouseLocation];
                let hit = interactive
                    && mouse.x >= x + (width - 248.) / 2.
                    && mouse.x <= x + (width + 248.) / 2.
                    && mouse.y >= y + height - 52.
                    && mouse.y <= y + height - 8.;
                let _: () = msg_send![panel, setIgnoresMouseEvents: if hit { NO } else { YES }];
                let _: () = msg_send![panel, orderFrontRegardless];
            }
        }
    }
}

#[cfg(test)]
#[path = "native_pill_tests.rs"]
mod tests;

/// Explicit fixture entry point for the isolated Linux display capture harness.
/// It uses the production renderer, no server, capture device or input simulation.
pub(crate) fn try_fixture(args: &[String]) -> Result<bool, String> {
    if args.first().map(String::as_str) != Some("--pill-fixture") {
        return Ok(false);
    }
    #[cfg(not(target_os = "linux"))]
    return Err("Pill raster fixtures require an isolated Linux display".into());
    #[cfg(target_os = "linux")]
    {
        let state = args
            .get(1)
            .filter(|_| args.len() == 2)
            .ok_or("Expected a pill fixture state")?
            .clone();
        if ![
            "idle",
            "requesting-mic",
            "recording",
            "transcribing",
            "polishing",
            "success",
            "error",
        ]
        .contains(&state.as_str())
        {
            return Err("Unknown pill fixture state".into());
        }
        Application::new().run(move |cx| {
            cx.open_window(
                WindowOptions {
                    focus: false,
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        point(px(0.), px(0.)),
                        size(px(520.), px(120.)),
                    ))),
                    titlebar: None,
                    ..Default::default()
                },
                |_, cx| {
                    cx.new(|_| {
                        let mut pill = Pill::default();
                        pill.apply(Snapshot {
                            state,
                            audio_level: 0.7,
                            duration_ms: 6500,
                            pasted_text: Some("Delivered fixture words".into()),
                            error: Some("Microphone unavailable".into()),
                            ..Default::default()
                        });
                        pill.motion = crate::motion::Transition::settled(160, pill.target);
                        pill
                    })
                },
            )
            .unwrap();
        });
        Ok(true)
    }
}
