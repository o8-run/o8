//! Caret-local dictation feedback (the HUD), behind `native_dictation_hud`.
//! It shares the dock's frame queue, wake channel, pipe receipts and native
//! loop, in its own click-through panel. The web HUD page keeps the session
//! events, wording and timers; the classic shell computes the placement.
use super::*;

/// Lease without a frame before the panel hides on its own (pill-timing.json).
const LEASE_MS: u64 = 750;
/// The largest frame the shell gives this window (820×220 today), as the route's limit.
const MAX_SIZE: (f64, f64) = (2048., 1024.);

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HudDetail {
    #[serde(default)]
    pub surface: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub dim: bool,
    #[serde(default)]
    pub solid: bool,
    #[serde(default)]
    pub reduced_motion: bool,
    #[serde(default)]
    pub placement: Option<Placement>,
}

/// Top-left desktop points, as the classic shell applied them to its window.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
pub(crate) struct Placement {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HudSnapshot {
    pub state: String,
    #[serde(default)]
    pub session: u64,
    #[serde(default)]
    pub audio_level: f32,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub hud: Option<HudDetail>,
    /// Sent once the web has stopped painting this session; earlier frames
    /// are acknowledged but stay hidden, so the two never show together.
    #[serde(default)]
    pub armed: bool,
}
impl HudSnapshot {
    /// Only an armed, placed, known dictation phase ever becomes visible: the
    /// panel never shows somewhere the shell did not anchor it.
    pub fn visible(&self) -> bool {
        self.armed
            && self.hud.as_ref().is_some_and(|hud| hud.placement.is_some())
            && matches!(
                self.state.as_str(),
                "requesting-mic" | "recording" | "transcribing" | "polishing" | "success" | "error"
            )
    }
    fn caret(&self) -> bool {
        self.hud.as_ref().is_none_or(|hud| hud.surface != "hud")
    }
}

/// The AppKit frame (bottom-left origin) for a top-left placement, clamped
/// into the bounding box of the screens and to the largest frame the shell
/// uses. `screens` are AppKit frames, the primary first; None without either.
pub(crate) fn appkit_frame(placement: Option<Placement>, screens: &[[f64; 4]]) -> Option<[f64; 4]> {
    let p = placement?;
    let finite = |values: &[f64]| values.iter().all(|v| v.is_finite());
    if !finite(&[p.x, p.y, p.width, p.height]) || p.width <= 0. || p.height <= 0. {
        return None;
    }
    let primary = *screens.first()?;
    let screens: Vec<_> = screens
        .iter()
        .filter(|s| finite(&s[..]) && s[2] > 0. && s[3] > 0.)
        .collect();
    if screens.is_empty() || !finite(&primary) {
        return None;
    }
    let left = screens.iter().map(|s| s[0]).fold(f64::INFINITY, f64::min);
    let bottom = screens.iter().map(|s| s[1]).fold(f64::INFINITY, f64::min);
    let right = screens
        .iter()
        .map(|s| s[0] + s[2])
        .fold(f64::NEG_INFINITY, f64::max);
    let top = screens
        .iter()
        .map(|s| s[1] + s[3])
        .fold(f64::NEG_INFINITY, f64::max);
    let width = p.width.min(MAX_SIZE.0).min(right - left);
    let height = p.height.min(MAX_SIZE.1).min(top - bottom);
    let y = primary[1] + primary[3] - p.y - p.height;
    Some([
        p.x.clamp(left, right - width),
        y.clamp(bottom, top - height),
        width,
        height,
    ])
}

pub(crate) struct Hud {
    pub(super) snapshot: HudSnapshot,
    heard: Instant,
    motion: crate::motion::Transition,
    shown: bool,
    target: bool,
    level: marks::LevelEase,
    /// The bar's window bounds from the last paint, for the backdrop blur.
    pub(super) bar: std::rc::Rc<std::cell::Cell<Option<gpui::Bounds<gpui::Pixels>>>>,
    /// The blur view's last frame, corner radius and alpha (macOS).
    pub(super) blur: Option<([f64; 4], f64, f64)>,
    pub(super) presentation: Presentation,
}
impl Default for Hud {
    fn default() -> Self {
        Self {
            snapshot: HudSnapshot::default(),
            heard: Instant::now(),
            motion: crate::motion::Transition::new(160),
            shown: false,
            target: false,
            level: marks::LevelEase::default(),
            bar: Default::default(),
            blur: None,
            presentation: Presentation::default(),
        }
    }
}
impl Hud {
    fn apply(&mut self, snapshot: HudSnapshot) {
        let visible = snapshot.visible();
        if visible && !self.target {
            // The web bar was on screen and has just gone: no second entrance.
            self.motion = crate::motion::Transition::settled(160, true);
        }
        self.motion.set(visible);
        self.target = visible;
        if visible {
            self.level.set(snapshot.audio_level);
            self.snapshot = snapshot;
        }
        self.heard = Instant::now();
    }
    /// A lost feed hides at once, without the exit fade.
    fn expire(&mut self) {
        if self.target && self.heard.elapsed() > Duration::from_millis(LEASE_MS) {
            self.apply(HudSnapshot::default());
            self.motion = crate::motion::Transition::settled(160, false);
        }
    }
    /// The dock's presentation contract: prepare, frame, release. Returns
    /// whether the panel shows, or None for a malformed control.
    pub(crate) fn control(&mut self, args: &Value) -> Option<bool> {
        match args["action"].as_str() {
            Some("prepare") => {
                self.apply(HudSnapshot::default());
                self.motion = crate::motion::Transition::settled(160, false);
            }
            Some("frame") => {
                let snapshot =
                    serde_json::from_value::<HudSnapshot>(args["snapshot"].clone()).ok()?;
                self.apply(snapshot);
            }
            Some("release") => {
                // A late release never hides a newer session already on screen.
                let stale = self.target
                    && args["session"]
                        .as_u64()
                        .is_some_and(|session| session != self.snapshot.session);
                if !stale {
                    self.apply(HudSnapshot::default());
                    if args["immediate"] == true {
                        self.motion = crate::motion::Transition::settled(160, false);
                    }
                }
            }
            _ => return None,
        }
        self.shown = self.target || self.motion.value().1;
        Some(self.shown)
    }
}

fn white(alpha: f32) -> gpui::Rgba {
    gpui::Rgba {
        r: 1.,
        g: 1.,
        b: 1.,
        a: alpha,
    }
}

impl Render for Hud {
    fn render(&mut self, w: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let (opacity, moving) = self.motion.value();
        let root = div().size_full().flex();
        let Some(hud) = self.snapshot.hud.clone() else {
            return root;
        };
        let state = self.snapshot.state.as_str();
        let processing = matches!(state, "transcribing" | "polishing");
        let (level, easing) = self.level.value(hud.reduced_motion);
        if moving || easing || processing && !hud.reduced_motion {
            w.request_animation_frame();
        }
        let caret = self.snapshot.caret();
        let viewport = f32::from(w.viewport_size().width);
        let rise = if hud.reduced_motion {
            0.
        } else {
            4. * (1. - opacity)
        };
        let seconds = self.snapshot.duration_ms / 1000;
        let header = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .min_h(px(24.))
            .child(crate::shell::rail::symon_mark_sized(
                16.,
                state == "recording",
            ))
            .child({
                let mut label = div()
                    .text_size(px(10.))
                    .font_weight(gpui::FontWeight::LIGHT)
                    .text_color(white(0.55));
                // The web label's 0.04em tracking at 10 px.
                label
                    .text_style()
                    .get_or_insert_with(Default::default)
                    .letter_spacing = Some(px(0.4));
                label.child(hud.title.to_uppercase())
            })
            .child(div().flex_1())
            .when(state == "recording", |d| d.child(marks::waveform(level)))
            .when(processing, |d| {
                d.child(marks::polish_mark(hud.reduced_motion))
            })
            .when(!caret && state == "recording" && seconds >= 10, |d| {
                d.child(
                    div()
                        .text_size(px(10.))
                        .font_weight(gpui::FontWeight::LIGHT)
                        .text_color(white(0.45))
                        .child(format!("{}:{:02}", seconds / 60, seconds % 60)),
                )
            });
        let transcript = div()
            .max_h(px(if caret { 48. } else { 84. }))
            .overflow_hidden()
            .flex()
            .flex_col()
            .justify_end()
            .child(
                div()
                    .text_size(px(if caret { 14. } else { 19. }))
                    .line_height(gpui::relative(1.4))
                    .text_color(white(if hud.dim { 0.62 } else { 0.97 }))
                    .child(hud.text.clone()),
            );
        let bar = div()
            .id("native-dictation-hud")
            .debug_selector(|| "native-dictation-hud".into())
            .relative()
            .top(px(rise))
            .opacity(opacity)
            .flex()
            .flex_col()
            .gap(px(if caret { 5. } else { 8. }))
            .w(px(if caret {
                420_f32.min(viewport - 12.)
            } else {
                680_f32.min(viewport - 56.)
            }))
            .py(px(if caret { 10. } else { 16. }))
            .px(px(if caret { 14. } else { 26. }))
            .rounded(px(if caret { 14. } else { 22. }))
            // Dark in both palettes; only the glass/solid material flips.
            .bg(crate::theme::dictation_hud_fill(hud.solid))
            .border_1()
            .border_color(white(0.12))
            .shadow(vec![
                gpui::BoxShadow {
                    color: gpui::hsla(0., 0., 0., if caret { 0.38 } else { 0.55 }),
                    offset: point(px(0.), px(if caret { 10. } else { 18. })),
                    blur_radius: px(if caret { 30. } else { 60. }),
                    spread_radius: px(0.),
                },
                gpui::BoxShadow {
                    color: gpui::hsla(0., 0., 0., if caret { 0.32 } else { 0.4 }),
                    offset: point(px(0.), px(if caret { 1. } else { 2. })),
                    blur_radius: px(if caret { 5. } else { 8. }),
                    spread_radius: px(0.),
                },
            ])
            .font_family(crate::theme::current().font_ui)
            .child({
                // Measures the bar each paint so the backdrop blur follows it.
                let cell = self.bar.clone();
                gpui::canvas(move |bounds, _, _| cell.set(Some(bounds)), |_, _, _, _| {})
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
            })
            .child(header)
            .child(transcript);
        if caret {
            root.items_start().justify_start().p(px(6.)).child(bar)
        } else {
            root.items_end()
                .justify_center()
                .px(px(24.))
                .pb(px(6.))
                .child(bar)
        }
    }
}

fn open(cx: &mut gpui::AsyncApp) -> Option<WindowHandle<Hud>> {
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
                    size(px(460.), px(138.)),
                ))),
                ..Default::default()
            },
            |_, cx| cx.new(|_| Hud::default()),
        )
    })
    .ok()
    .and_then(Result::ok)
}

/// One HUD control from the shared queue, replied to over the same receipts.
pub(super) fn deliver(
    handle: &mut Option<WindowHandle<Hud>>,
    frame: Value,
    cx: &mut gpui::AsyncApp,
) {
    let id = frame["id"].as_str().unwrap_or_default().to_string();
    if handle.is_none() && frame["args"]["action"] == "release" {
        crate::app_parent::browser_result(&id, json!({"ok":true}));
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
        let Ok(view) = root.downcast::<Hud>() else {
            crate::app_parent::browser_result(&reply_id, json!({"ok":false}));
            return;
        };
        // As the dock: apply after any outer lease, present with it returned.
        let view = view.downgrade();
        window.defer(cx, move |window, cx| {
            let reply = |ok: bool| crate::app_parent::browser_result(&reply_id, json!({"ok":ok}));
            if expired(&frame) {
                return reply(false);
            }
            let Some(view) = view.upgrade() else {
                return reply(false);
            };
            let Some(show) = view.update(cx, |hud, cx| {
                let show = hud.control(&frame["args"]);
                cx.notify();
                show
            }) else {
                return reply(false);
            };
            #[cfg(target_os = "macos")]
            macos::present_hud(window, show, &view, cx);
            #[cfg(not(target_os = "macos"))]
            let _ = (window, show);
            let _ = WAKE.0.try_send(());
            reply(true);
        });
    });
    if result.is_err() {
        *handle = None;
        crate::app_parent::browser_result(&id, json!({"ok":false}));
    }
}

/// The loop's maintenance tick: lease expiry, exit fade. Returns whether the
/// panel is visible, so the loop keeps its 16 ms tick only while it is.
pub(super) fn tick(handle: &mut Option<WindowHandle<Hud>>, cx: &mut gpui::AsyncApp) -> bool {
    let Some(h) = *handle else {
        return false;
    };
    let mut visible = false;
    let result = AnyWindowHandle::from(h).update(cx, |root, window, cx| {
        let Ok(view) = root.downcast::<Hud>() else {
            return;
        };
        let (show, was_shown) = view.update(cx, |hud, cx| {
            let was_active = hud.target;
            hud.expire();
            if was_active != hud.target {
                cx.notify();
            }
            let show = hud.target || hud.shown && hud.motion.value().1;
            let was_shown = hud.shown;
            hud.shown = show;
            (show, was_shown)
        });
        visible = show;
        #[cfg(target_os = "macos")]
        if show || was_shown {
            macos::present_hud(window, show, &view, cx);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (window, was_shown);
    });
    if result.is_err() {
        *handle = None;
        return false;
    }
    visible
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

    /// The caret/HUD panel: the dock's nonactivating class and level, fully
    /// click-through, on every Space, at the classic shell's placement.
    pub(super) fn present_hud(window: &Window, visible: bool, view: &Entity<Hud>, cx: &mut App) {
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
            let configure = view.update(cx, |hud, _| !hud.presentation.configured);
            if configure {
                super::super::macos::make_nonactivating(panel);
                let _: () = msg_send![panel, setIgnoresMouseEvents: YES];
                let _: () = msg_send![panel, setHidesOnDeactivate: NO];
                let _: () = msg_send![panel, setLevel: 25_i64];
                // CanJoinAllSpaces | Stationary | IgnoresCycle | FullScreenAuxiliary,
                // as the classic HUD window.
                let _: () = msg_send![panel, setCollectionBehavior: 1_u64 | 16 | 64 | 256];
                // GPUI's blurred-window view backs the glass bar (see backdrop).
                window.set_background_appearance(WindowBackgroundAppearance::Blurred);
            }
            let screens: id = msg_send![class!(NSScreen), screens];
            let count: usize = msg_send![screens, count];
            let frame = if visible {
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
                let placement = view.update(cx, |hud, _| {
                    hud.snapshot
                        .hud
                        .as_ref()
                        .and_then(|detail| detail.placement)
                });
                appkit_frame(placement, &frames)
            } else {
                None
            };
            let Some([x, y, width, height]) = frame else {
                view.update(cx, |hud, _| {
                    hud.presentation.tick(false, None);
                });
                let _: () = msg_send![panel, orderOut: nil];
                return;
            };
            let (_, set_frame, order_front) = view.update(cx, |hud, _| {
                hud.presentation.tick(true, Some([x, y, width, height]))
            });
            if set_frame {
                let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
                let _: () = msg_send![panel, setFrame: frame display: NO];
            }
            // Never key, never main, never takes a click.
            let _: () = msg_send![panel, setIgnoresMouseEvents: YES];
            backdrop(content, view, cx);
            if order_front {
                let _: () = msg_send![panel, orderFrontRegardless];
            }
        }
    }

    /// The glass bar's backdrop blur: GPUI's own blurred-window view (no
    /// toolkit change), cut to the bar's last painted bounds and corner
    /// radius and faded with it; hidden for the solid material.
    unsafe fn backdrop(content: id, view: &Entity<Hud>, cx: &mut App) {
        let (wanted, previous) = view.update(cx, |hud, _| {
            let solid = hud.snapshot.hud.as_ref().is_none_or(|detail| detail.solid);
            let radius = if hud.snapshot.caret() { 14. } else { 22. };
            let (opacity, _) = hud.motion.value();
            let wanted = hud.bar.get().filter(|_| !solid).map(|bar| {
                (
                    [
                        f64::from(f32::from(bar.origin.x)),
                        f64::from(f32::from(bar.origin.y)),
                        f64::from(f32::from(bar.size.width)),
                        f64::from(f32::from(bar.size.height)),
                    ],
                    radius,
                    f64::from(opacity),
                )
            });
            (wanted, std::mem::replace(&mut hud.blur, wanted))
        });
        if wanted == previous {
            return;
        }
        unsafe {
            let subviews: id = msg_send![content, subviews];
            let count: usize = msg_send![subviews, count];
            let effect = (0..count)
                .map(|index| -> id { msg_send![subviews, objectAtIndex: index] })
                .find(|&subview| {
                    let kind: cocoa::base::BOOL =
                        msg_send![subview, isKindOfClass: class!(NSVisualEffectView)];
                    kind == YES
                });
            let Some(effect) = effect else {
                return;
            };
            let Some(([x, top, width, height], radius, alpha)) = wanted else {
                let _: () = msg_send![effect, setHidden: YES];
                return;
            };
            // The content view is not flipped: AppKit y runs up from the bottom.
            let bounds: NSRect = msg_send![content, bounds];
            let frame = NSRect::new(
                NSPoint::new(x, bounds.size.height - top - height),
                NSSize::new(width, height),
            );
            let _: () = msg_send![effect, setAutoresizingMask: 0_u64];
            let _: () = msg_send![effect, setFrame: frame];
            let _: () = msg_send![effect, setWantsLayer: YES];
            let layer: id = msg_send![effect, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, setCornerRadius: radius];
                let _: () = msg_send![layer, setMasksToBounds: YES];
            }
            let _: () = msg_send![effect, setAlphaValue: alpha];
            let _: () = msg_send![effect, setHidden: NO];
        }
    }
}

#[path = "native_hud_marks.rs"]
mod marks;
#[cfg(test)]
#[path = "native_hud_tests.rs"]
mod tests;
