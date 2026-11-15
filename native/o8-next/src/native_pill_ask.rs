//! The dock's Ask conversation panel (DockAskPanel), drawn natively behind the
//! `native_dictation_pill` flag. The web dock owns the thread, its timers and
//! every command: close, copy and the idle re-arm are intents it runs from the
//! reply, as for the capsules. Nothing here closes, copies or finishes.
use super::{Pill, Snapshot, capsules};
use gpui::{AnyElement, Context, div, prelude::*, px};
use serde::Deserialize;
use serde_json::json;

/// The 420×380 answer panel and the 248×40 listening capsule (DockNotchSurface).
pub(crate) const PANEL: (f64, f64) = (420., 380.);
const LISTENING: (f64, f64) = (248., 40.);

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ask {
    /// Changes whenever the web thread changes; a copy names the thread it saw.
    #[serde(default)]
    pub rev: u64,
    /// Listening for the first question: the compact capsule, no panel yet.
    #[serde(default)]
    pub listening: bool,
    /// The newest turns that fit the frame budget, oldest first.
    #[serde(default)]
    pub turns: Vec<Turn>,
    #[serde(default)]
    pub pending: Option<Pending>,
    #[serde(default)]
    pub working: Option<Working>,
    /// The answer whose copy the web just confirmed.
    #[serde(default)]
    pub copied: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Turn {
    pub index: u64,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub sources: Option<String>,
}

/// An agent dictation that is a pending You turn inside the open panel.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pending {
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub text: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Working {
    #[serde(default)]
    pub tool: String,
    #[serde(default)]
    pub started_at: u64,
}

impl Ask {
    pub(crate) fn size(&self) -> (f64, f64) {
        if self.listening { LISTENING } else { PANEL }
    }
    /// The pending turn is still recording: a click finishes it, as the web
    /// dock's own body click does.
    pub(crate) fn recording(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|pending| pending.phase == "listening")
    }
    fn answer(&self, index: u64) -> bool {
        self.turns.iter().any(|turn| {
            turn.index == index && turn.role == "assistant" && !turn.text.trim().is_empty()
        })
    }
}

/// The paragraphs and list items of a turn, as DockAskPanel's AskMarkdown
/// splits them, with the inline `code` and **bold** markers removed.
pub(crate) fn blocks(text: &str) -> Vec<(Option<String>, String)> {
    let mut out = Vec::new();
    for block in text.trim().split("\n\n") {
        let lines: Vec<&str> = block
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        if lines.is_empty() {
            continue;
        }
        let bullet = |l: &str| {
            l.strip_prefix("- ")
                .or_else(|| l.strip_prefix("* "))
                .map(str::to_string)
        };
        let number = |l: &str| {
            let (digits, rest) = l.split_once(". ")?;
            (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
                .then(|| rest.to_string())
        };
        if lines.iter().all(|l| bullet(l).is_some()) {
            out.extend(
                lines
                    .iter()
                    .map(|l| (Some("•".into()), plain(&bullet(l).unwrap_or_default()))),
            );
        } else if lines.iter().all(|l| number(l).is_some()) {
            out.extend(lines.iter().enumerate().map(|(i, l)| {
                (
                    Some(format!("{}.", i + 1)),
                    plain(&number(l).unwrap_or_default()),
                )
            }));
        } else {
            out.push((None, plain(&lines.join(" "))));
        }
    }
    out
}

fn plain(text: &str) -> String {
    text.replace("**", "").replace('`', "")
}

impl Pill {
    /// Queue one Ask intent for the panel on screen. A copy names the thread
    /// revision and an answer that is drawn; anything else is dropped.
    pub(crate) fn ask_act(&mut self, action: &str, index: Option<u64>) -> bool {
        let Some(ask) = self
            .snapshot
            .ask
            .as_ref()
            .filter(|_| self.target && self.snapshot.state == "ask")
        else {
            return false;
        };
        let allowed = match action {
            "ask-close" => !ask.listening,
            "ask-copy" => index.is_some_and(|index| ask.answer(index)),
            "ask-active" => !self.ask_active_sent,
            _ => false,
        };
        if !allowed || self.actions.len() >= capsules::ACTION_LIMIT {
            return false;
        }
        if action == "ask-active" {
            self.ask_active_sent = true;
        }
        self.actions.push(json!({
            "session": self.snapshot.session,
            "state": "ask",
            "action": action,
            "value": index,
            "ref": ask.rev.to_string(),
        }));
        true
    }

    /// Scroll the thread to its newest turn when the content changes, as the
    /// web panel's auto-scroll does.
    pub(crate) fn ask_follow(&mut self, previous: Option<&Ask>) {
        let Some(ask) = self.snapshot.ask.as_ref() else {
            return;
        };
        let moved = previous.is_none_or(|before| {
            before.rev != ask.rev
                || before.pending != ask.pending
                || before.working.is_some() != ask.working.is_some()
        });
        if moved {
            self.ask_scroll.scroll_to_bottom();
        }
    }

    pub(crate) fn render_ask(&self, opacity: f32, cx: &mut Context<Self>) -> AnyElement {
        let t = crate::theme::current();
        let ask = self.snapshot.ask.clone().unwrap_or_default();
        let (width, height) = ask.size();
        let surface = div()
            .id("native-dock-ask")
            .debug_selector(|| "native-dock-ask".into())
            .w(px(width as f32))
            .h(px(height as f32))
            .rounded(px(if ask.listening { 20. } else { 26. }))
            .overflow_hidden()
            .bg(t.surface_raised)
            .border_1()
            .border_color(t.border)
            .text_color(t.text)
            .font_family(t.font_ui)
            .font_weight(gpui::FontWeight::LIGHT)
            .opacity(opacity);
        if ask.listening {
            // DockNotchSurface's compact capsule: the waveform at rest level.
            let mut bars = div().flex().items_center().gap(px(3.)).h(px(22.));
            for i in 0..26 {
                let weight = 1. - ((i as f32 - 12.5) / 13.).abs();
                bars = bars.child(
                    div()
                        .w(px(2.))
                        .h(px(2. + 4. * weight))
                        .rounded(px(1.))
                        .bg(t.accent),
                );
            }
            return surface
                .flex()
                .items_center()
                .justify_center()
                .child(bars)
                .into_any_element();
        }
        let label = |text: &str| {
            div()
                .text_size(px(9.5))
                .text_color(t.text_secondary)
                .mb(px(4.))
                .child(text.to_uppercase())
        };
        let mut thread = div()
            .id("native-dock-ask-thread")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.ask_scroll)
            .px(px(18.))
            .pt(px(2.))
            .pb(px(14.));
        for turn in &ask.turns {
            let mut row = div().relative().my(px(12.));
            if turn.role == "user" {
                row = row.child(label("You")).child(
                    div()
                        .text_size(px(12.5))
                        .line_height(px(18.75))
                        .text_color(t.text_secondary)
                        .child(turn.text.clone()),
                );
            } else {
                let index = turn.index;
                let copied = ask.copied == Some(index);
                row = row.child(label("Symon")).child(
                    div()
                        .id(("native-ask-copy", index as usize))
                        .debug_selector(move || format!("native-ask-copy-{index}"))
                        .absolute()
                        .top(px(-2.))
                        .right_0()
                        .px(px(7.))
                        .py(px(2.))
                        .rounded(px(6.))
                        .bg(t.hover)
                        .border_1()
                        .border_color(t.border)
                        .text_size(px(9.5))
                        .text_color(if copied { t.success } else { t.text_secondary })
                        .cursor_pointer()
                        .child(if copied { "Copied" } else { "Copy" })
                        .on_click(cx.listener(move |pill, _, _, cx| {
                            pill.ask_act("ask-copy", Some(index));
                            cx.notify();
                        })),
                );
                for (marker, text) in blocks(&turn.text) {
                    let body = div()
                        .text_size(px(13.5))
                        .line_height(px(20.25))
                        .text_color(t.text);
                    row = row.child(match marker {
                        Some(marker) => div()
                            .flex()
                            .gap(px(6.))
                            .pl(px(8.))
                            .mb(px(4.))
                            .child(
                                div()
                                    .text_size(px(13.5))
                                    .text_color(t.text_secondary)
                                    .child(marker),
                            )
                            .child(body.flex_1().child(text)),
                        None => body.mb(px(8.)).child(text),
                    });
                }
                if let Some(sources) = turn.sources.as_ref().filter(|s| !s.is_empty()) {
                    row = row.child(
                        div()
                            .mt(px(4.))
                            .text_size(px(10.))
                            .line_height(px(14.))
                            .text_color(t.text_muted)
                            .line_clamp(2)
                            .child(sources.clone()),
                    );
                }
            }
            thread = thread.child(row);
        }
        if let Some(pending) = &ask.pending {
            // DockAskPanel's pending You turn: the live words (or Listening…),
            // the level bars while recording, Polishing… until the agent claims it.
            let listening = pending.phase == "listening";
            let level = if self.snapshot.audio_level.is_finite() {
                self.snapshot.audio_level.clamp(0., 1.)
            } else {
                0.
            };
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
            let (words, color) = if pending.text.is_empty() && listening {
                ("Listening…".to_string(), t.text_faint)
            } else {
                (pending.text.clone(), t.text_secondary)
            };
            thread = thread.child(
                div()
                    .my(px(12.))
                    .child(label("You"))
                    .when(!words.is_empty(), |d| {
                        d.child(
                            div()
                                .text_size(px(12.5))
                                .line_height(px(18.75))
                                .text_color(color)
                                .child(words),
                        )
                    })
                    .when(listening, |d| d.child(div().mt(px(6.)).child(bars)))
                    .when(!listening && ask.working.is_none(), |d| {
                        d.child(
                            div()
                                .mt(px(6.))
                                .flex()
                                .items_center()
                                .gap(px(7.))
                                .child(
                                    div()
                                        .size(px(11.))
                                        .rounded_full()
                                        .border_1()
                                        .border_color(t.text_secondary),
                                )
                                .child(
                                    div()
                                        .text_size(px(10.5))
                                        .text_color(t.text_secondary)
                                        .child("Polishing…"),
                                ),
                        )
                    }),
            );
        }
        if let Some(working) = &ask.working {
            let words = if working.tool == "o8_ask" {
                "Synthesizing…"
            } else {
                "Working…"
            };
            thread = thread.child(
                div().my(px(12.)).child(label("Symon")).child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(9.))
                        .child(
                            div()
                                .size(px(13.))
                                .rounded_full()
                                .border_1()
                                .border_color(t.text_secondary),
                        )
                        .child(div().text_size(px(11.)).child(words))
                        .when(working.started_at > 0, |d| {
                            d.child(div().text_size(px(10.5)).text_color(t.text_muted).child(
                                capsules::elapsed_label(working.started_at, capsules::now_ms()),
                            ))
                        }),
                ),
            );
        }
        let header = div()
            .flex()
            .items_center()
            .gap(px(10.))
            .flex_none()
            .pt(px(9.))
            .pr(px(12.))
            .pb(px(5.))
            .pl(px(16.))
            .child(
                div()
                    .size(px(15.))
                    .flex_shrink_0()
                    .rounded_full()
                    .bg(t.accent),
            )
            .child(
                div()
                    .text_size(px(12.5))
                    .text_color(t.text_secondary)
                    .child("Symon"),
            )
            .child(
                div()
                    .id("native-ask-close")
                    .debug_selector(|| "native-ask-close".into())
                    .ml_auto()
                    .size(px(24.))
                    .rounded(px(7.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(|s| s.bg(t.hover))
                    .child(crate::icon::stroke(CLOSE, t.text_secondary, 13., 2.))
                    .on_click(cx.listener(|pill, _, _, cx| {
                        pill.ask_act("ask-close", None);
                        cx.notify();
                    })),
            );
        surface
            .flex()
            .flex_col()
            .on_mouse_move(cx.listener(|pill, _, _, cx| {
                if pill.ask_act("ask-active", None) {
                    cx.notify();
                }
            }))
            .on_click(cx.listener(|pill, _, _, cx| {
                pill.finish();
                cx.notify();
            }))
            .child(header)
            .child(thread)
            .into_any_element()
    }
}

/// Size the native window to the drawn content: the default 120 points, or
/// the Ask panel plus the chip and glint rows below it.
pub(crate) fn panel_height(snapshot: &Snapshot) -> f64 {
    if snapshot.state == "ask" {
        8. + capsules::size(snapshot).1 + 64.
    } else {
        120.
    }
}

/// DockAskPanel's close glyph on the 24-unit icon grid.
const CLOSE: &str = "M6 6l12 12M18 6L6 18";
