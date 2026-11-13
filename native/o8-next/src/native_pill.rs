//! Passive dictation drawing. Capture and all interactive dock surfaces keep their owners.
#[cfg(test)]
use gpui::TestAppContext;
use gpui::{
    App, Application, Bounds, Context, IntoElement, Render, Window, WindowBackgroundAppearance,
    WindowBounds, WindowHandle, WindowKind, WindowOptions, div, point, prelude::*, px, size,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};

static FRAMES: Mutex<VecDeque<Value>> = Mutex::new(VecDeque::new());
pub(crate) fn enqueue(frame: Value) {
    let mut queue = FRAMES.lock().unwrap();
    if queue.len() < 32 {
        queue.push_back(frame);
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
    pub audio_level: f32,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub partial_transcript: String,
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
}
impl Default for Pill {
    fn default() -> Self {
        Self {
            snapshot: Snapshot::default(),
            heard: Instant::now(),
            motion: crate::motion::Transition::new(160),
            shown: false,
            target: false,
        }
    }
}
impl Pill {
    fn expire(&mut self) {
        if self.heard.elapsed() > Duration::from_millis(750) && self.target {
            self.apply(Snapshot::default());
        }
    }
    fn apply(&mut self, snapshot: Snapshot) {
        self.motion.set(snapshot.visible());
        self.target = snapshot.visible();
        if self.target {
            self.snapshot = snapshot;
        }
        self.heard = Instant::now();
    }
}
impl Render for Pill {
    fn render(&mut self, w: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
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
                    .text_color(t.text)
                    .text_size(px(12.))
                    .font_family(t.font_ui)
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

/// One window, no activation or keyboard/input handlers. A lost feed expires locally.
pub(crate) fn install(cx: &mut App) {
    #[cfg(target_os = "macos")]
    cx.spawn(async move |cx| {
        let mut handle: Option<WindowHandle<Pill>> = None;
        loop {
            cx.background_executor()
                .timer(Duration::from_millis(16))
                .await;
            let frames: Vec<_> = FRAMES.lock().unwrap().drain(..).collect();
            for frame in frames {
                let id = frame["id"].as_str().unwrap_or_default();
                let expired = frame["expiresAt"].as_u64().unwrap_or(0)
                    < std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                if expired {
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
                let ok = handle.is_some_and(|h| {
                    h.update(cx, |pill, w, cx| {
                        match frame["args"]["action"].as_str() {
                            Some("prepare") => {
                                pill.apply(Snapshot::default());
                                pill.motion = crate::motion::Transition::settled(160, false);
                            }
                            Some("frame") => {
                                let Ok(snapshot) = serde_json::from_value::<Snapshot>(
                                    frame["args"]["snapshot"].clone(),
                                ) else {
                                    return false;
                                };
                                pill.apply(snapshot);
                            }
                            Some("release") => pill.apply(Snapshot::default()),
                            _ => return false,
                        }
                        let show = pill.target || pill.motion.value().1;
                        macos::present(w, show);
                        pill.shown = show;
                        cx.notify();
                        true
                    })
                    .unwrap_or(false)
                });
                crate::app_parent::browser_result(id, json!({"ok":ok}));
            }
            if let Some(h) = handle {
                let _ = h.update(cx, |pill, w, cx| {
                    let was_active = pill.target;
                    pill.expire();
                    if was_active != pill.target {
                        cx.notify();
                    }
                    let show = pill.target || pill.shown && pill.motion.value().1;
                    if show || pill.shown {
                        macos::present(w, show);
                    }
                    pill.shown = show;
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
    use objc::{class, msg_send, sel, sel_impl};
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
    pub(super) fn present(window: &Window, visible: bool) {
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
                let _: () = msg_send![panel, orderFrontRegardless];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pill_feed_lease_and_idle_retire_drawing() {
        let mut pill = Pill::default();
        pill.apply(Snapshot {
            state: "recording".into(),
            ..Default::default()
        });
        pill.expire();
        assert!(pill.target);
        pill.heard = Instant::now() - Duration::from_secs(1);
        pill.expire();
        assert!(!pill.target);
        pill.apply(Snapshot {
            state: "polishing".into(),
            ..Default::default()
        });
        assert!(pill.target);
        pill.apply(Snapshot {
            state: "idle".into(),
            ..Default::default()
        });
        assert!(!pill.target);
    }
    #[gpui::test]
    fn pill_states_draw_offscreen_without_input(cx: &mut TestAppContext) {
        let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
        for state in [
            "requesting-mic",
            "recording",
            "transcribing",
            "polishing",
            "success",
            "error",
        ] {
            pill.update_in(visual, |pill, _, cx| {
                pill.apply(Snapshot {
                    state: state.into(),
                    audio_level: 0.6,
                    ..Default::default()
                });
                pill.motion = crate::motion::Transition::settled(160, true);
                cx.notify();
            });
            visual.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear();
            });
            assert!(
                visual.debug_bounds("native-dictation-pill").is_some(),
                "{state}"
            );
        }
    }
    #[test]
    fn pill_states_and_idle_visibility() {
        for (state, label) in [
            ("requesting-mic", "Connecting…"),
            ("recording", "Listening"),
            ("transcribing", "Transcribing"),
            ("polishing", "Polishing"),
            ("success", "Pasted"),
            ("error", "Mic error"),
        ] {
            let snapshot = Snapshot {
                state: state.into(),
                ..Default::default()
            };
            assert!(snapshot.visible(), "{state}");
            assert_eq!(snapshot.label(), label);
        }
        assert!(!Snapshot::default().visible());
        assert!(
            !Snapshot {
                state: "idle".into(),
                ..Default::default()
            }
            .visible()
        );
        assert!(
            !Snapshot {
                state: "foreign".into(),
                ..Default::default()
            }
            .visible()
        );
        let delivered = Snapshot {
            state: "success".into(),
            pasted_text: Some("Delivered words".into()),
            ..Default::default()
        };
        assert_eq!(delivered.label(), "Delivered words");
        let failed = Snapshot {
            state: "error".into(),
            error: Some("Microphone denied".into()),
            ..Default::default()
        };
        assert_eq!(failed.label(), "Microphone denied");
    }
    #[test]
    fn pill_placement_follows_primary_changes_and_notch_without_scaling() {
        assert_eq!(
            placement([0., 0., 1440., 900.], 0.),
            Some([460., 780., 520., 120.])
        );
        assert_eq!(
            placement([-1920., -200., 1920., 1080.], 32.),
            Some([-1220., 724., 520., 120.])
        );
        assert_eq!(
            placement([0., 0., 300., 100.], 0.),
            Some([0., 0., 300., 100.])
        );
        assert!(placement([0., 0., f64::NAN, 900.], 0.).is_none());
        assert!(placement([0., 0., 1440., 900.], f64::NAN).is_none());
        assert!(placement([0., 0., 0., 900.], 0.).is_none());
    }
    #[test]
    fn pill_pipe_fixture() {
        if std::env::var("O8_PILL_PIPE_FIXTURE").as_deref() != Ok("1") {
            return;
        }
        crate::app_parent::watch();
        loop {
            if let Some(frame) = FRAMES.lock().unwrap().pop_front() {
                let snapshot: Snapshot =
                    serde_json::from_value(frame["args"]["snapshot"].clone()).unwrap();
                let mut pill = Pill::default();
                pill.apply(snapshot);
                println!(
                    "pill-model:{}:{}",
                    pill.snapshot.state, pill.snapshot.audio_level
                );
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn dictation_event_reaches_pill_model_through_real_parent_pipe() {
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["pill_pipe_fixture", "--nocapture"])
            .env("O8_PILL_PIPE_FIXTURE", "1")
            .env("O8_NEXT_PARENT_PIPE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        writeln!(child.stdin.as_mut().unwrap(), "{}", json!({"type":"dictation-pill","id":"fixture","args":{"action":"frame","snapshot":{"state":"recording","audioLevel":0.625}}})).unwrap();
        let out = BufReader::new(child.stdout.take().unwrap());
        let mut received = false;
        for line in out.lines() {
            if line.unwrap().contains("pill-model:recording:0.625") {
                received = true;
                break;
            }
        }
        assert!(child.wait().unwrap().success());
        assert!(received);
    }
}

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
