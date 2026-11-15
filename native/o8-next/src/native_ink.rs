//! Draw-on-screen ink for agent holds (Symon Spatial Context), behind
//! `native_spatial_ink`. It shares the dock's frame queue, wake channel, pipe
//! receipts and loop, in its own panel. Unlike the dock and HUD it captures
//! the mouse while armed, but it is the dock's never-key, never-main,
//! nonactivating panel, so keyboard focus and the held key stay with the
//! operator's app. The web page keeps the session events and relays the
//! captured points to the classic shell; the shell picks the monitor.
//!
//! A stuck capture would leave the operator's mouse dead, so capture ends on
//! any one of: the page's release (key release, `final`, any terminal event or
//! shell disarm), Escape, the lease running out without a frame, a malformed
//! control or failed placement, the 90 s bound, a display change that removes
//! the covered monitor, or (last resort) a main thread stalled with the
//! pointer captured, which ends this process.
use super::*;
use gpui::{DispatchPhase, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, canvas};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Lease without a frame (src/lib/next/ink-timing.json `leaseMs`).
pub(crate) const LEASE_MS: u64 = 750;
/// Hard bound on one capture, as the shell's own safety disarm.
pub(crate) const BOUND_MS: u64 = 90_000;
/// The shell's limits for one session (spatial_ink_window.rs).
pub(crate) const MAX_STROKES: usize = 128;
pub(crate) const MAX_POINTS: usize = 8192;
/// Points one reply carries; the rest follow on the next frame.
pub(crate) const REPLY_POINTS: usize = 2048;
/// The web overlay's snapshot flash and fade after handoff.
pub(crate) const FLASH_MS: u64 = 200;
pub(crate) const FADE_MS: u64 = 600;
/// A main thread silent this long while the pointer is captured.
const STALL_MS: u64 = 3_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    /// Ordered out, click-through, draws nothing.
    Hidden,
    /// Capturing the pointer and drawing.
    Armed,
    /// Escape let the pointer go; the strokes stay drawn, click-through.
    Held,
    /// Handoff flash and fade, click-through.
    Fading,
}

/// Why capture ended. Each is sufficient on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Disarm {
    Release,
    Handoff,
    Escape,
    Lease,
    Error,
    Bound,
    Display,
}
impl Disarm {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Release => "release",
            Self::Handoff => "handoff",
            Self::Escape => "escape",
            Self::Lease => "lease",
            Self::Error => "error",
            Self::Bound => "bound",
            Self::Display => "display",
        }
    }
}

/// The monitor the shell covered, in top-left desktop points.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
pub(crate) struct Monitor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Monitor {
    fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.x.abs() <= 100_000.
            && self.y.abs() <= 100_000.
            && self.width > 0.
            && self.height > 0.
            && self.width <= 100_000.
            && self.height <= 100_000.
    }
}

/// The AppKit frame of the screen that is the covered monitor: the screen it
/// overlaps most, provided that is at least half of it. `screens` are AppKit
/// frames (bottom-left origin), the primary first. None when the monitor is
/// gone, so the panel never captures over the wrong display.
pub(crate) fn appkit_frame(monitor: Monitor, screens: &[[f64; 4]]) -> Option<[f64; 4]> {
    if !monitor.valid() {
        return None;
    }
    let primary = *screens.first()?;
    if !primary.iter().all(|v| v.is_finite()) {
        return None;
    }
    let top = primary[1] + primary[3];
    let wanted = [
        monitor.x,
        top - monitor.y - monitor.height,
        monitor.width,
        monitor.height,
    ];
    let overlap = |s: &[f64; 4]| {
        let w = (wanted[0] + wanted[2]).min(s[0] + s[2]) - wanted[0].max(s[0]);
        let h = (wanted[1] + wanted[3]).min(s[1] + s[3]) - wanted[1].max(s[1]);
        w.max(0.) * h.max(0.)
    };
    let best = screens
        .iter()
        .filter(|s| s.iter().all(|v| v.is_finite()) && s[2] > 0. && s[3] > 0.)
        .max_by(|a, b| overlap(a).total_cmp(&overlap(b)))?;
    (overlap(best) >= wanted[2] * wanted[3] / 2.).then_some(*best)
}

/// One captured point in panel points; `t` is milliseconds since its stroke began.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Mark {
    pub x: f32,
    pub y: f32,
    pub t: f32,
}

#[derive(Default)]
pub(crate) struct Shown {
    configured: bool,
    visible: bool,
    geometry: Option<[f64; 4]>,
}

pub(crate) struct Ink {
    pub(super) phase: Phase,
    session: u64,
    monitor: Option<Monitor>,
    /// The covered area in points: the screen frame once placed.
    size: (f64, f64),
    pub(super) strokes: Vec<Vec<Mark>>,
    drawing: bool,
    points: usize,
    stroke_at: Instant,
    armed_at: Instant,
    heard: Instant,
    fade_at: Instant,
    reduced: bool,
    disarmed: Option<Disarm>,
    shown: Shown,
}
impl Default for Ink {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            phase: Phase::Hidden,
            session: 0,
            monitor: None,
            size: (1., 1.),
            strokes: Vec::new(),
            drawing: false,
            points: 0,
            stroke_at: now,
            armed_at: now,
            heard: now,
            fade_at: now,
            reduced: false,
            disarmed: None,
            shown: Shown::default(),
        }
    }
}

fn since(now: Instant, then: Instant) -> u64 {
    now.saturating_duration_since(then).as_millis() as u64
}

impl Ink {
    pub(crate) fn capturing(&self) -> bool {
        self.phase == Phase::Armed
    }
    pub(crate) fn visible(&self) -> bool {
        self.phase != Phase::Hidden
    }
    /// Whether a render asks for another frame: the live head while drawing,
    /// or the handoff fade. Never while hidden.
    pub(crate) fn animating(&self) -> bool {
        self.phase == Phase::Armed && self.drawing && !self.reduced || self.phase == Phase::Fading
    }

    /// The page's controls. Returns the receipt, or None for a malformed one.
    pub(crate) fn control(&mut self, args: &Value, now: Instant) -> Option<Value> {
        let from = || args["from"].as_u64().unwrap_or(0) as usize;
        match args["action"].as_str()? {
            // A flag probe: no window state changes.
            "prepare" => Some(json!({"ok":true})),
            "arm" => {
                let session = args["session"].as_u64()?;
                let monitor = serde_json::from_value::<Monitor>(args["monitor"].clone())
                    .ok()
                    .filter(Monitor::valid)?;
                self.arm(session, monitor, args["reducedMotion"] == true, now);
                Some(self.receipt(true, 0))
            }
            "frame" => {
                let session = args["session"].as_u64()?;
                if session != self.session {
                    return Some(json!({"ok":false}));
                }
                let live = matches!(self.phase, Phase::Armed | Phase::Held);
                if live {
                    self.heard = now;
                }
                Some(self.receipt(live, from()))
            }
            "release" => {
                let session = args["session"].as_u64()?;
                // A late release never ends a newer hold.
                if session != self.session {
                    return Some(json!({"ok":true}));
                }
                let reason = if args["handoff"] == true {
                    Disarm::Handoff
                } else {
                    Disarm::Release
                };
                self.disarm(reason, now);
                Some(self.receipt(true, from()))
            }
            _ => None,
        }
    }

    fn receipt(&self, ok: bool, from: usize) -> Value {
        let points = self.points_since(from);
        json!({
            "ok": ok,
            "capturing": self.capturing(),
            "disarmed": self.disarmed.map(Disarm::name),
            "next": from.min(self.points) + points.len(),
            "points": points,
        })
    }

    pub(crate) fn arm(&mut self, session: u64, monitor: Monitor, reduced: bool, now: Instant) {
        *self = Self {
            phase: Phase::Armed,
            session,
            monitor: Some(monitor),
            size: (monitor.width, monitor.height),
            reduced,
            armed_at: now,
            heard: now,
            shown: std::mem::take(&mut self.shown),
            ..Self::default()
        };
        // The shell re-fronts its own window at every arm; order this panel
        // front again even if the last hold's fade still shows it.
        self.shown.visible = false;
    }

    /// End capture. Returns whether the phase changed.
    pub(crate) fn disarm(&mut self, reason: Disarm, now: Instant) -> bool {
        let before = self.phase;
        if before == Phase::Hidden || before == Phase::Fading && reason == Disarm::Handoff {
            return false;
        }
        self.drawing = false;
        self.disarmed = Some(reason);
        let ink = self.points > 0;
        self.phase = match reason {
            Disarm::Handoff if ink && !self.reduced => {
                self.fade_at = now;
                Phase::Fading
            }
            Disarm::Escape if ink && before == Phase::Armed => Phase::Held,
            _ => Phase::Hidden,
        };
        before != self.phase
    }

    /// The loop's maintenance: time bound, lease, Escape, fade end. Returns
    /// whether the phase changed.
    pub(crate) fn tick(&mut self, now: Instant, escape: bool) -> bool {
        match self.phase {
            Phase::Armed | Phase::Held if since(now, self.armed_at) >= BOUND_MS => {
                self.disarm(Disarm::Bound, now)
            }
            Phase::Armed | Phase::Held if since(now, self.heard) > LEASE_MS => {
                self.disarm(Disarm::Lease, now)
            }
            Phase::Armed if escape => self.disarm(Disarm::Escape, now),
            Phase::Fading if since(now, self.fade_at) >= FLASH_MS + FADE_MS => {
                self.phase = Phase::Hidden;
                true
            }
            _ => false,
        }
    }

    pub(crate) fn press(&mut self, x: f32, y: f32, now: Instant) -> bool {
        if self.phase != Phase::Armed
            || self.strokes.len() >= MAX_STROKES
            || self.points >= MAX_POINTS
            || !x.is_finite()
            || !y.is_finite()
        {
            return false;
        }
        self.drawing = true;
        self.stroke_at = now;
        self.strokes.push(vec![Mark { x, y, t: 0. }]);
        self.points += 1;
        true
    }

    /// A drag sample; repeats of the last point (GPUI's synthetic drags) are dropped.
    pub(crate) fn drag(&mut self, x: f32, y: f32, now: Instant) -> bool {
        if self.phase != Phase::Armed
            || !self.drawing
            || self.points >= MAX_POINTS
            || !x.is_finite()
            || !y.is_finite()
        {
            return false;
        }
        let t = now.saturating_duration_since(self.stroke_at).as_secs_f32() * 1000.;
        let Some(stroke) = self.strokes.last_mut() else {
            return false;
        };
        if stroke
            .last()
            .is_some_and(|last| (last.x - x).hypot(last.y - y) < 0.5)
        {
            return false;
        }
        stroke.push(Mark { x, y, t });
        self.points += 1;
        true
    }

    pub(crate) fn lift(&mut self) -> bool {
        std::mem::replace(&mut self.drawing, false)
    }

    /// Points after the first `from`, as `[stroke, x, y, t]` normalized to the
    /// covered monitor, the space the web overlay reports in.
    pub(crate) fn points_since(&self, from: usize) -> Vec<[f64; 4]> {
        let (w, h) = (self.size.0.max(1.), self.size.1.max(1.));
        self.strokes
            .iter()
            .enumerate()
            .flat_map(|(index, stroke)| stroke.iter().map(move |mark| (index, mark)))
            .skip(from)
            .take(REPLY_POINTS)
            .map(|(index, mark)| {
                [
                    index as f64,
                    (mark.x as f64 / w).clamp(0., 1.),
                    (mark.y as f64 / h).clamp(0., 1.),
                    (mark.t as f64).clamp(0., 3_600_000.),
                ]
            })
            .collect()
    }

    /// Opacity and glow for this frame: the handoff flash swells the glow,
    /// then the strokes fade out (as the web overlay).
    pub(crate) fn envelope(&self, now: Instant) -> (f32, f32) {
        if self.phase != Phase::Fading {
            return (1., 1.);
        }
        let elapsed = since(now, self.fade_at);
        if elapsed < FLASH_MS {
            return (1., 1. + elapsed as f32 / FLASH_MS as f32 * 0.9);
        }
        let k = ((elapsed - FLASH_MS) as f32 / FADE_MS as f32).min(1.);
        (1. - k * k, 1.2 * (1. - k))
    }
}

impl Render for Ink {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let root = div().size_full();
        if !self.visible() {
            return root;
        }
        if self.animating() {
            w.request_animation_frame();
        }
        let now = Instant::now();
        let (alpha, glow) = self.envelope(now);
        let scene = draw::Scene::new(
            &self.strokes,
            self.reduced,
            alpha,
            glow,
            (self.capturing() && self.drawing && !self.reduced).then_some(capsules::now_ms()),
        );
        let view = cx.entity().downgrade();
        root.when(self.capturing(), |d| d.cursor(gpui::CursorStyle::Crosshair))
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, _| {
                        scene.paint(bounds, window);
                        listen(window, view);
                    },
                )
                .size_full(),
            )
    }
}

/// Pointer input for the frame. Presses outside an armed hold do nothing.
fn listen(window: &mut Window, view: gpui::WeakEntity<Ink>) {
    let down = view.clone();
    window.on_mouse_event(move |event: &MouseDownEvent, phase, _, cx| {
        if phase != DispatchPhase::Bubble || event.button != MouseButton::Left {
            return;
        }
        let (x, y) = (f32::from(event.position.x), f32::from(event.position.y));
        let _ = down.update(cx, |ink, cx| {
            if ink.press(x, y, Instant::now()) {
                cx.notify();
            }
        });
    });
    let moved = view.clone();
    window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
        if phase != DispatchPhase::Bubble || event.pressed_button != Some(MouseButton::Left) {
            return;
        }
        let (x, y) = (f32::from(event.position.x), f32::from(event.position.y));
        let _ = moved.update(cx, |ink, cx| {
            if ink.drag(x, y, Instant::now()) {
                cx.notify();
            }
        });
    });
    window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
        if phase != DispatchPhase::Bubble || event.button != MouseButton::Left {
            return;
        }
        let _ = view.update(cx, |ink, cx| {
            if ink.lift() {
                cx.notify();
            }
        });
    });
}

fn open(cx: &mut gpui::AsyncApp) -> Option<WindowHandle<Ink>> {
    cx.update(|cx| {
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
                    size(px(800.), px(600.)),
                ))),
                ..Default::default()
            },
            |_, cx| cx.new(|_| Ink::default()),
        )
    })
    .ok()
    .and_then(Result::ok)
}

/// One ink control from the shared queue, replied to over the same receipts.
pub(super) fn deliver(
    handle: &mut Option<WindowHandle<Ink>>,
    frame: Value,
    cx: &mut gpui::AsyncApp,
) {
    let id = frame["id"].as_str().unwrap_or_default().to_string();
    let action = frame["args"]["action"].as_str().unwrap_or_default();
    // Nothing to probe or release without a panel; it opens on the first arm.
    if handle.is_none() && action != "arm" {
        let ok = matches!(action, "prepare" | "release");
        crate::app_parent::browser_result(&id, json!({"ok":ok}));
        return;
    }
    if handle.is_none() {
        *handle = open(cx);
    }
    let Some(h) = *handle else {
        crate::app_parent::browser_result(&id, json!({"ok":false}));
        return;
    };
    let reply_id = id.clone();
    let result = AnyWindowHandle::from(h).update(cx, move |root, window, cx| {
        let Ok(view) = root.downcast::<Ink>() else {
            crate::app_parent::browser_result(&reply_id, json!({"ok":false}));
            return;
        };
        // As the dock: apply after any outer lease, present with it returned.
        let view = view.downgrade();
        window.defer(cx, move |window, cx| {
            let Some(view) = view.upgrade() else {
                crate::app_parent::browser_result(&reply_id, json!({"ok":false}));
                return;
            };
            let now = Instant::now();
            let reply = view.update(cx, |ink, cx| {
                let reply = if expired(&frame) {
                    None
                } else {
                    ink.control(&frame["args"], now)
                };
                // Any malformed or late control ends capture.
                if reply.is_none() {
                    ink.disarm(Disarm::Error, now);
                }
                cx.notify();
                reply
            });
            #[cfg(target_os = "macos")]
            macos::present_ink(window, &view, cx);
            #[cfg(not(target_os = "macos"))]
            let _ = window;
            watchdog::observe(view.read(cx).capturing());
            let _ = WAKE.0.try_send(());
            crate::app_parent::browser_result(&reply_id, reply.unwrap_or(json!({"ok":false})));
        });
    });
    if result.is_err() {
        *handle = None;
        watchdog::observe(false);
        crate::app_parent::browser_result(&id, json!({"ok":false}));
    }
}

/// The loop's maintenance tick. Returns whether the panel is on screen, so the
/// loop keeps its 16 ms tick only while it is.
pub(super) fn tick(handle: &mut Option<WindowHandle<Ink>>, cx: &mut gpui::AsyncApp) -> bool {
    let Some(h) = *handle else {
        watchdog::observe(false);
        return false;
    };
    let mut visible = false;
    let result = AnyWindowHandle::from(h).update(cx, |root, window, cx| {
        let Ok(view) = root.downcast::<Ink>() else {
            return;
        };
        let changed = view.update(cx, |ink, cx| {
            #[cfg(target_os = "macos")]
            let escape = ink.capturing() && macos::escape_down();
            #[cfg(not(target_os = "macos"))]
            let escape = false;
            let changed = ink.tick(Instant::now(), escape);
            if changed {
                cx.notify();
            }
            changed
        });
        #[cfg(target_os = "macos")]
        if changed {
            macos::present_ink(window, &view, cx);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (window, changed);
        let ink = view.read(cx);
        visible = ink.visible();
        watchdog::observe(ink.capturing());
    });
    if result.is_err() {
        *handle = None;
        watchdog::observe(false);
        return false;
    }
    visible
}

/// Last resort for a main thread that stops running with the pointer
/// captured: AppKit can only be told from that thread, so this process ends
/// and its panel goes with it. The page then takes the hold back.
pub(crate) mod watchdog {
    use super::*;
    static CAPTURING: AtomicBool = AtomicBool::new(false);
    static BEAT: AtomicU64 = AtomicU64::new(0);

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Called from the main thread on every delivery and loop tick.
    pub(crate) fn observe(capturing: bool) {
        BEAT.store(now_ms(), Ordering::SeqCst);
        CAPTURING.store(capturing, Ordering::SeqCst);
        if capturing {
            start();
        }
    }

    /// Whether a capture has gone `STALL_MS` without a beat.
    pub(crate) fn stalled(capturing: bool, beat: u64, now: u64) -> bool {
        capturing && now.saturating_sub(beat) > STALL_MS
    }

    fn start() {
        static STARTED: std::sync::Once = std::sync::Once::new();
        STARTED.call_once(|| {
            let _ = std::thread::Builder::new()
                .name("ink-watchdog".into())
                .spawn(|| {
                    loop {
                        std::thread::sleep(Duration::from_millis(250));
                        if stalled(
                            CAPTURING.load(Ordering::SeqCst),
                            BEAT.load(Ordering::SeqCst),
                            now_ms(),
                        ) {
                            eprintln!(
                                "o8 next: the ink panel's main thread stalled with the pointer captured; exiting"
                            );
                            std::process::exit(1);
                        }
                    }
                });
        });
    }
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

    // tree-sitter-rust 0.24 (theme_tests) cannot parse `unsafe extern "C"` blocks,
    // so the declaration reaches the parser only as macro token trees.
    macro_rules! key_abi {
        ({ $($declaration:tt)* }) => {
            #[link(name = "CoreGraphics", kind = "framework")]
            unsafe extern "C" { $($declaration)* }
        };
    }
    key_abi! {
        {
            fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
        }
    }

    /// Escape held right now (HID system state, virtual key 0x35). It is read,
    /// not received: the panel never becomes key, so key events never reach it.
    pub(super) fn escape_down() -> bool {
        // Reads global HID state only; no event is consumed or posted.
        unsafe { CGEventSourceKeyState(1, 0x35) }
    }

    /// The ink panel: the dock's nonactivating class, level 24 (under the dock
    /// and HUD at 25, as the classic ink window), on every Space, covering the
    /// shell's monitor. It takes mouse events only while armed.
    pub(super) fn present_ink(window: &Window, view: &Entity<Ink>, cx: &mut App) {
        let Ok(handle) = HasWindowHandle::window_handle(window) else {
            return;
        };
        let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
            return;
        };
        // GPUI owns this content view and NSPanel; calls stay on the UI thread.
        unsafe {
            let content: id = handle.ns_view.as_ptr() as id;
            let panel: id = msg_send![content, window];
            let configure = view.update(cx, |ink, _| !std::mem::replace(&mut ink.shown.configured, true));
            if configure {
                super::super::macos::make_nonactivating(panel);
                let _: () = msg_send![panel, setIgnoresMouseEvents: YES];
                let _: () = msg_send![panel, setHidesOnDeactivate: NO];
                let _: () = msg_send![panel, setLevel: 24_i64];
                // CanJoinAllSpaces | Stationary | IgnoresCycle | FullScreenAuxiliary,
                // as the classic ink window.
                let _: () = msg_send![panel, setCollectionBehavior: 1_u64 | 16 | 64 | 256];
            }
            let (visible, monitor) = {
                let ink = view.read(cx);
                (ink.visible(), ink.monitor)
            };
            let frame = if visible {
                let screens: id = msg_send![class!(NSScreen), screens];
                let count: usize = msg_send![screens, count];
                let frames: Vec<[f64; 4]> = (0..count)
                    .map(|index| {
                        let screen: id = msg_send![screens, objectAtIndex: index];
                        let rect: NSRect = msg_send![screen, frame];
                        [
                            rect.origin.x,
                            rect.origin.y,
                            rect.size.width,
                            rect.size.height,
                        ]
                    })
                    .collect();
                monitor.and_then(|monitor| appkit_frame(monitor, &frames))
            } else {
                None
            };
            let Some([x, y, width, height]) = frame else {
                // Hidden, or the covered monitor is gone: never capture.
                let _: () = msg_send![panel, setIgnoresMouseEvents: YES];
                let _: () = msg_send![panel, orderOut: nil];
                view.update(cx, |ink, cx| {
                    ink.shown.visible = false;
                    if ink.disarm(Disarm::Display, Instant::now()) {
                        cx.notify();
                    }
                });
                return;
            };
            let (moved, front, capturing) = view.update(cx, |ink, _| {
                let moved = ink.shown.geometry != Some([x, y, width, height]);
                ink.shown.geometry = Some([x, y, width, height]);
                ink.size = (width, height);
                let front = !std::mem::replace(&mut ink.shown.visible, true);
                (moved, front, ink.capturing())
            });
            if moved {
                let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
                let _: () = msg_send![panel, setFrame: frame display: NO];
            }
            // Click-through unless armed; set before ordering front.
            let _: () = msg_send![panel, setIgnoresMouseEvents: if capturing { NO } else { YES }];
            if front {
                let _: () = msg_send![panel, orderFrontRegardless];
            }
        }
    }
}

#[path = "native_ink_draw.rs"]
mod draw;
#[cfg(test)]
#[path = "native_ink_tests.rs"]
mod tests;
