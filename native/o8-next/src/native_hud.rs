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
}
impl HudSnapshot {
    /// Only a placed, known dictation phase ever becomes visible: the panel
    /// never shows somewhere the shell did not anchor it.
    pub fn visible(&self) -> bool {
        self.hud.as_ref().is_some_and(|hud| hud.placement.is_some())
            && matches!(
                self.state.as_str(),
                "requesting-mic" | "recording" | "transcribing" | "polishing" | "success" | "error"
            )
    }
    fn caret(&self) -> bool {
        self.hud.as_ref().is_none_or(|hud| hud.surface != "hud")
    }
}

/// The AppKit frame (bottom-left origin) for a top-left placement, kept on one
/// screen: the one the rectangle overlaps most, or the nearest when it overlaps
/// none, and no larger than that screen or the largest frame the shell uses.
/// `screens` are AppKit frames, the primary first; None without either.
pub(crate) fn appkit_frame(placement: Option<Placement>, screens: &[[f64; 4]]) -> Option<[f64; 4]> {
    let p = placement?;
    let finite = |values: &[f64]| values.iter().all(|v| v.is_finite());
    if !finite(&[p.x, p.y, p.width, p.height]) || p.width <= 0. || p.height <= 0. {
        return None;
    }
    let primary = *screens.first()?;
    if !finite(&primary) {
        return None;
    }
    // The requested rectangle in AppKit coordinates, top edge kept.
    let top = primary[1] + primary[3] - p.y;
    let wanted = [p.x, top - p.height, p.width, p.height];
    let overlap = |s: &[f64; 4]| {
        let w = (wanted[0] + wanted[2]).min(s[0] + s[2]) - wanted[0].max(s[0]);
        let h = (wanted[1] + wanted[3]).min(s[1] + s[3]) - wanted[1].max(s[1]);
        w.max(0.) * h.max(0.)
    };
    let distance = |s: &[f64; 4]| {
        let dx = (s[0] - (wanted[0] + wanted[2]))
            .max(wanted[0] - (s[0] + s[2]))
            .max(0.);
        let dy = (s[1] - (wanted[1] + wanted[3]))
            .max(wanted[1] - (s[1] + s[3]))
            .max(0.);
        dx * dx + dy * dy
    };
    let screen = screens
        .iter()
        .filter(|s| finite(&s[..]) && s[2] > 0. && s[3] > 0.)
        .max_by(|a, b| {
            overlap(a)
                .total_cmp(&overlap(b))
                .then(distance(b).total_cmp(&distance(a)))
        })?;
    let width = p.width.min(MAX_SIZE.0).min(screen[2]);
    let height = p.height.min(MAX_SIZE.1).min(screen[3]);
    Some([
        p.x.clamp(screen[0], screen[0] + screen[2] - width),
        (top - height).clamp(screen[1], screen[1] + screen[3] - height),
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
    /// Receipts held until the panel has drawn and presented its first frame
    /// and is on screen; the web keeps its bar until then.
    pub(super) awaiting: Vec<String>,
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
            awaiting: Vec::new(),
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
    /// Whether a render must ask for another frame: only while the panel is
    /// shown or fading, never for a hidden panel.
    pub(crate) fn animating(&self) -> bool {
        let (_, moving) = self.motion.value();
        let Some(hud) = self.snapshot.hud.as_ref() else {
            return false;
        };
        let processing = matches!(self.snapshot.state.as_str(), "transcribing" | "polishing");
        moving
            || self.target
                && (self.level.value(hud.reduced_motion).1 || processing && !hud.reduced_motion)
    }
    /// Once the exit fade has settled, drop the last session's content so a
    /// hidden panel draws nothing and the next one never shows it. Returns
    /// whether anything was cleared.
    pub(crate) fn settle(&mut self) -> bool {
        if self.target || self.motion.value().1 || self.snapshot.hud.is_none() {
            return false;
        }
        self.snapshot = HudSnapshot::default();
        true
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
        let (opacity, _) = self.motion.value();
        let root = div().size_full().flex();
        let Some(hud) = self.snapshot.hud.clone() else {
            return root;
        };
        let state = self.snapshot.state.as_str();
        let processing = matches!(state, "transcribing" | "polishing");
        let (level, _) = self.level.value(hud.reduced_motion);
        if self.animating() {
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
            {
                let on_screen = view.read(cx).presentation.visible;
                if !show || on_screen {
                    macos::present_hud(window, show, &view, cx, true);
                    // A release also settles anything held for a reveal.
                    if !show {
                        for held in view.update(cx, |hud, _| std::mem::take(&mut hud.awaiting)) {
                            crate::app_parent::browser_result(&held, json!({"ok":true}));
                        }
                    }
                } else {
                    // Place it, let GPUI draw and present this frame, and only
                    // then order the panel front and acknowledge: until that
                    // reply the web bar stays up, so neither surface is blank.
                    macos::present_hud(window, true, &view, cx, false);
                    let first = view.update(cx, |hud, _| {
                        hud.awaiting.push(reply_id.clone());
                        hud.awaiting.len() == 1
                    });
                    if first {
                        let view = view.downgrade();
                        window.on_next_frame(move |window, _| {
                            window.on_next_frame(move |window, cx| {
                                if let Some(view) = view.upgrade() {
                                    reveal(window, &view, cx);
                                }
                            });
                        });
                    }
                    let _ = WAKE.0.try_send(());
                    return;
                }
            }
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

/// After the panel's first frame has been drawn and presented: order it front
/// (if it is still wanted) and release the held receipts.
#[cfg(target_os = "macos")]
fn reveal(window: &mut Window, view: &Entity<Hud>, cx: &mut App) {
    let (show, held) = view.update(cx, |hud, _| (hud.target, std::mem::take(&mut hud.awaiting)));
    macos::present_hud(window, show, view, cx, true);
    for id in held {
        crate::app_parent::browser_result(&id, json!({"ok":true}));
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
        let (show, was_shown, front) = view.update(cx, |hud, cx| {
            let was_active = hud.target;
            hud.expire();
            if was_active != hud.target | hud.settle() {
                cx.notify();
            }
            let show = hud.target || hud.shown && hud.motion.value().1;
            let was_shown = hud.shown;
            hud.shown = show;
            (show, was_shown, hud.awaiting.is_empty())
        });
        visible = show;
        #[cfg(target_os = "macos")]
        if show || was_shown {
            macos::present_hud(window, show, &view, cx, front);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (window, was_shown, front);
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
    /// `front` false places a visible panel without ordering it front, while
    /// its first frame is still being drawn.
    pub(super) fn present_hud(
        window: &Window,
        visible: bool,
        view: &Entity<Hud>,
        cx: &mut App,
        front: bool,
    ) {
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
            if !front {
                let moved = view.update(cx, |hud, _| {
                    let moved = hud.presentation.geometry != Some([x, y, width, height]);
                    hud.presentation.geometry = Some([x, y, width, height]);
                    moved
                });
                if moved {
                    let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
                    let _: () = msg_send![panel, setFrame: frame display: NO];
                }
                return;
            }
            let (_, set_frame, order_front) = view.update(cx, |hud, _| {
                hud.presentation.tick(true, Some([x, y, width, height]))
            });
            if set_frame {
                let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
                let _: () = msg_send![panel, setFrame: frame display: NO];
            }
            // Never key, never main, never takes a click.
            let _: () = msg_send![panel, setIgnoresMouseEvents: YES];
            if order_front {
                let _: () = msg_send![panel, orderFrontRegardless];
            }
        }
    }
}

#[path = "native_hud_marks.rs"]
mod marks;
#[cfg(test)]
#[path = "native_hud_tests.rs"]
mod tests;
