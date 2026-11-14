//! Speech playback, live voice and agent working capsules in the dictation panel.
//! Clicks are queued as intents for the web dock, which remains the owner of the
//! voice and agent commands; nothing here calls those commands.
use super::{Pill, Snapshot};
use gpui::{AnyElement, Context, Div, Stateful, div, prelude::*, px};
use serde_json::{Value, json};

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
const ACTION_LIMIT: usize = 8;

pub(crate) fn is_capsule(state: &str) -> bool {
    matches!(state, "speaking" | "working" | "voice")
}

/// The web capsule footprint for each state (DockNotchSurface geometry).
pub(crate) fn size(snapshot: &Snapshot) -> (f64, f64) {
    match snapshot.state.as_str() {
        "success" | "error" => (420., 44.),
        "speaking" => (280., 40.),
        "voice" => (268., 40.),
        "working" => (248., 40.),
        _ => (248., 44.),
    }
}

pub(crate) fn interactive(snapshot: &Snapshot) -> bool {
    match snapshot.state.as_str() {
        "recording" | "speaking" | "working" => true,
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
            .rounded(px(20.))
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
                .into_any_element(),
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
