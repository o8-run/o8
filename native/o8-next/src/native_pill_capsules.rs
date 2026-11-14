//! Speech playback, live voice, agent working and fleet capsules in the dictation panel.
//! Clicks are queued as intents for the web dock, which remains the owner of the
//! voice and agent commands; nothing here calls those commands.
use super::{Pill, Snapshot};
use gpui::{AnyElement, Context, Div, Stateful, div, prelude::*, px};
use serde::Deserialize;
use serde_json::{Value, json};

/// The fleet snapshot DockNotchSurface draws (worker-status and parked lanes).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Workers {
    #[serde(default)]
    pub count: u64,
    #[serde(default)]
    pub working: u64,
    #[serde(default)]
    pub waiting: u64,
    /// `ready` for parked review lanes, otherwise `waiting`.
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub repos: Vec<String>,
}

impl Workers {
    fn waiting_copy(&self) -> String {
        if self.label == "ready" {
            format!("{} review ready", self.waiting)
        } else {
            format!("{} waiting on you", self.waiting)
        }
    }
    /// The expanded capsule's line, worded as DockNotchSurface words it.
    pub(crate) fn detail(&self) -> String {
        let s = if self.working == 1 { "" } else { "s" };
        if self.working > 0 && self.waiting > 0 {
            format!("{} in flight · {}", self.working, self.waiting_copy())
        } else if self.working > 0 {
            format!("{} packet{s} in flight", self.working)
        } else {
            self.waiting_copy()
        }
    }
    /// The resting orbit's count and word.
    pub(crate) fn sliver(&self) -> (String, String) {
        let count = if self.count > 99 {
            "99+".into()
        } else {
            self.count.to_string()
        };
        let word = if self.working > 0 && self.waiting > 0 {
            "fleet".into()
        } else if self.working > 0 {
            "work".into()
        } else if self.label.is_empty() {
            "waiting".into()
        } else {
            self.label.clone()
        };
        (count, word)
    }
}

/// The web dock's speed band and 0.05 step (DockNotchSurface SPEED_MIN/MAX).
pub(crate) const SPEEDS: [f32; 11] = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2];
const SPEED_SELECTORS: [&str; 11] = [
    "native-speech-speed-0",
    "native-speech-speed-1",
    "native-speech-speed-2",
    "native-speech-speed-3",
    "native-speech-speed-4",
    "native-speech-speed-5",
    "native-speech-speed-6",
    "native-speech-speed-7",
    "native-speech-speed-8",
    "native-speech-speed-9",
    "native-speech-speed-10",
];
const SPEED_TRACK: f32 = 58.;
/// Clicks between two frames are kept, in order, up to this bound.
pub(crate) const ACTION_LIMIT: usize = 8;

pub(crate) fn is_capsule(state: &str) -> bool {
    matches!(state, "speaking" | "working" | "voice" | "workers")
}

/// The session kind a release names: each capsule, the chip/glint-only
/// frame, or dictation for every dictation state.
pub(crate) fn kind(state: &str) -> &str {
    if is_capsule(state) || state == "extras" {
        state
    } else {
        "dictation"
    }
}

/// The web capsule footprint for each state (DockNotchSurface geometry).
pub(crate) fn size(snapshot: &Snapshot) -> (f64, f64) {
    match snapshot.state.as_str() {
        "success" | "error" => (420., 44.),
        "speaking" => (280., 40.),
        "voice" if voice_workers(snapshot) > 0 => (348., 40.),
        "voice" => (268., 40.),
        "workers" if snapshot.expanded => (320., 44.),
        "workers" => (128., 16.),
        "working" => (248., 40.),
        _ => (248., 44.),
    }
}

pub(crate) fn interactive(snapshot: &Snapshot) -> bool {
    match snapshot.state.as_str() {
        "recording" | "speaking" | "working" | "workers" => true,
        "voice" => !snapshot.connecting,
        _ => false,
    }
}

/// The web WorkingTimer format: seconds below a minute, then m:ss.
pub(crate) fn elapsed_label(started_at: u64, now: u64) -> String {
    let seconds = now.saturating_sub(started_at) / 1000;
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}:{:02}", seconds / 60, seconds % 60)
    }
}

/// The in-flight worker count the live voice capsule carries (348 wide).
fn voice_workers(snapshot: &Snapshot) -> u64 {
    if snapshot.connecting {
        return 0;
    }
    snapshot
        .workers
        .as_ref()
        .map_or(0, |workers| workers.working)
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl Pill {
    /// Queue one intent for the current capsule session. Hidden, expired or
    /// replaced capsules accept nothing.
    pub(crate) fn act(&mut self, action: &str, value: Option<f32>) -> bool {
        let state = self.snapshot.state.as_str();
        let allowed = self.target
            && match action {
                "pause" | "stop" => state == "speaking",
                "speed" => state == "speaking" && value.is_some_and(|v| SPEEDS.contains(&v)),
                "interrupt" => state == "working",
                "voice-stop" => state == "voice" && !self.snapshot.connecting,
                "workers-expand" => state == "workers",
                _ => false,
            };
        if !allowed || self.actions.len() >= ACTION_LIMIT {
            return false;
        }
        self.actions.push(json!({
            "session": self.snapshot.session,
            "state": state,
            "action": action,
            // Two decimals, so the web receives the step it shows (0.85, not 0.8500000238).
            "value": value.map(|v| (f64::from(v) * 100.).round() / 100.),
        }));
        true
    }

    /// A click anywhere on the capsule body, matching the web capsule's own handler.
    pub(crate) fn capsule_click(&mut self) {
        match self.snapshot.state.as_str() {
            "recording" => self.finish(),
            "working" => {
                self.act("interrupt", None);
            }
            "voice" => {
                self.act("voice-stop", None);
            }
            "workers" => {
                self.act("workers-expand", None);
            }
            _ => {}
        }
    }

    pub(crate) fn take_actions(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.actions)
    }

    /// True when the elapsed label changed second; the visible maintenance tick
    /// redraws only then, from the start timestamp sent with the frame.
    pub(crate) fn timer_tick(&mut self, now: u64) -> bool {
        if !self.target || self.snapshot.state != "working" || self.snapshot.started_at == 0 {
            return false;
        }
        let second = now.saturating_sub(self.snapshot.started_at) / 1000;
        if self.second == Some(second) {
            return false;
        }
        self.second = Some(second);
        true
    }

    pub(crate) fn render_capsule(
        &self,
        capsule: Stateful<Div>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = crate::theme::current();
        let (width, height) = size(&self.snapshot);
        let snapshot = &self.snapshot;
        let base = capsule
            .w(px(width as f32))
            .h(px(height as f32))
            .rounded(px(if height < 20. { 8. } else { 20. }))
            .px(px(14.))
            .flex()
            .items_center()
            .justify_center()
            .overflow_hidden()
            .bg(t.surface_raised)
            .border_1()
            .border_color(t.border)
            .text_color(t.text)
            .font_family(t.font_ui)
            .font_weight(gpui::FontWeight::LIGHT);
        let label = |text: String, size: f32, color| {
            div().text_size(px(size)).text_color(color).child(text)
        };
        match snapshot.state.as_str() {
            "speaking" => {
                let fraction = ((snapshot.speed.clamp(0.7, 1.2) - 0.7) / 0.5).clamp(0., 1.);
                let mut targets = div().absolute().top_0().left_0().size_full().flex();
                for (index, rate) in SPEEDS.into_iter().enumerate() {
                    targets = targets.child(
                        div()
                            .id(SPEED_SELECTORS[index])
                            .debug_selector(move || SPEED_SELECTORS[index].into())
                            .flex_1()
                            .h_full()
                            .cursor_pointer()
                            .on_click(cx.listener(move |pill, _, _, cx| {
                                pill.act("speed", Some(rate));
                                cx.notify();
                            })),
                    );
                }
                let slider = div()
                    .relative()
                    .w(px(SPEED_TRACK))
                    .h(px(14.))
                    .flex()
                    .items_center()
                    .child(
                        div()
                            .absolute()
                            .left_0()
                            .w_full()
                            .h(px(3.))
                            .rounded(px(2.))
                            .bg(t.border),
                    )
                    .child(
                        div()
                            .absolute()
                            .left_0()
                            .w(px(SPEED_TRACK * fraction))
                            .h(px(3.))
                            .rounded(px(2.))
                            .bg(t.text_secondary),
                    )
                    .child(
                        div()
                            .absolute()
                            .left(px(SPEED_TRACK * fraction - 6.))
                            .size(px(12.))
                            .rounded_full()
                            .bg(t.text),
                    )
                    .child(targets);
                let speed = if snapshot.speed.fract() == 0. {
                    format!("{}×", snapshot.speed)
                } else {
                    format!("{:.2}×", snapshot.speed).replace("0×", "×")
                };
                base.gap(px(9.))
                    .child(label(
                        snapshot.label().to_uppercase(),
                        9.5,
                        t.text_secondary,
                    ))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .child(slider)
                            .child(label(speed, 10., t.text_secondary)),
                    )
                    .child(button(
                        "native-speech-pause",
                        if snapshot.paused { PLAY } else { PAUSE },
                        cx.listener(|pill, _, _, cx| {
                            pill.act("pause", None);
                            cx.notify();
                        }),
                    ))
                    .child(button(
                        "native-speech-stop",
                        STOP,
                        cx.listener(|pill, _, _, cx| {
                            pill.act("stop", None);
                            cx.notify();
                        }),
                    ))
                    .into_any_element()
            }
            "voice" => base
                .gap(px(6.))
                .when(!snapshot.connecting, |d| {
                    d.cursor_pointer()
                        .hover(|s| s.bg(t.hover))
                        .child(div().size(px(7.)).rounded_full().bg(t.success))
                })
                .when(snapshot.connecting, |d| d.child(orbit()))
                .child(label(snapshot.label().into(), 11., t.text))
                .when(voice_workers(snapshot) > 0, |d| {
                    d.child(div().size(px(3.)).rounded_full().bg(t.text_muted))
                        .child(orbit().size(px(12.)))
                        .child(label(
                            format!("{} working", voice_workers(snapshot)),
                            10.5,
                            t.text_secondary,
                        ))
                })
                .into_any_element(),
            "workers" => {
                let workers = snapshot.workers.clone().unwrap_or_default();
                let mark = if workers.working > 0 {
                    orbit()
                        .size(px(if snapshot.expanded { 13. } else { 9. }))
                        .into_any_element()
                } else {
                    let dot = if snapshot.expanded { 6. } else { 5. };
                    div()
                        .size(px(dot))
                        .flex_shrink_0()
                        .rounded_full()
                        .bg(t.warning)
                        .into_any_element()
                };
                let body = base.cursor_pointer().hover(|s| s.bg(t.hover)).child(mark);
                if snapshot.expanded {
                    let repos = workers.repos.join(", ");
                    body.gap(px(9.))
                        .px(px(16.))
                        .child(
                            div()
                                .flex()
                                .min_w_0()
                                .truncate()
                                .child(label(workers.detail(), 11.5, t.text))
                                .when(!repos.is_empty(), |d| {
                                    d.child(label(format!(" · {repos}"), 11.5, t.text_secondary))
                                }),
                        )
                        .into_any_element()
                } else {
                    let (count, word) = workers.sliver();
                    body.gap(px(4.))
                        .child(label(count, 9.5, t.text).font_weight(gpui::FontWeight::MEDIUM))
                        .child(label(word, 9., t.text_secondary))
                        .into_any_element()
                }
            }
            _ => {
                let hover = self.hover;
                let mut body = base
                    .gap(px(9.))
                    .cursor_pointer()
                    .on_hover(cx.listener(|pill, hovered: &bool, _, cx| {
                        pill.hover = *hovered;
                        cx.notify();
                    }))
                    .child(if hover {
                        crate::icon::fill(STOP, t.text, 11.).into_any_element()
                    } else {
                        orbit().into_any_element()
                    })
                    .child(label(
                        if hover {
                            "Stop".into()
                        } else {
                            snapshot.label().into()
                        },
                        11.,
                        t.text,
                    ));
                if !hover && snapshot.started_at > 0 {
                    body = body.child(label(
                        elapsed_label(snapshot.started_at, now_ms()),
                        10.5,
                        t.text_muted,
                    ));
                }
                body.into_any_element()
            }
        }
    }
}

const PLAY: &str =
    "M8 5.2v13.6a1 1 0 0 0 1.5.86l10.2-6.8a1 1 0 0 0 0-1.72L9.5 4.34A1 1 0 0 0 8 5.2Z";
const PAUSE: &str = "M7 5h3.4v14H7zM13.6 5H17v14h-3.4z";
const STOP: &str = "M6 8.5A2.5 2.5 0 0 1 8.5 6h7A2.5 2.5 0 0 1 18 8.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6 15.5z";

fn orbit() -> Div {
    let t = crate::theme::current();
    div()
        .size(px(13.))
        .rounded_full()
        .border_1()
        .border_color(t.text_secondary)
}

fn button(
    selector: &'static str,
    glyph: &'static str,
    click: impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static,
) -> Stateful<Div> {
    let t = crate::theme::current();
    div()
        .id(selector)
        .debug_selector(move || selector.into())
        .size(px(26.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .bg(t.hover)
        .border_1()
        .border_color(t.border)
        .cursor_pointer()
        .child(crate::icon::fill(glyph, t.text, 13.))
        .on_click(click)
}
