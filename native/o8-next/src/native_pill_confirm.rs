//! The dock's confirmation card (DockConfirmationCard), drawn natively behind
//! the `native_dictation_pill` flag. The decision stays with the web dock: a
//! click is an intent naming the exact card it was drawn for, and the web runs
//! `agent_confirm_exact` only while that same card is on screen.
use super::{Pill, capsules};
use gpui::{AnyElement, Context, div, prelude::*, px};
use serde::Deserialize;
use serde_json::json;

/// DockNotchSurface's fixed card footprint; the review scrolls inside it.
pub(crate) const CARD: (f64, f64) = (420., 96.);

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Card {
    /// The confirmation and task identity the web decides on.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub task: String,
    /// `plan` cards list their steps and say Run plan.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub steps: Vec<Step>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Step {
    pub index: u64,
    #[serde(default)]
    pub summary: String,
}

impl Card {
    fn plan(&self) -> bool {
        self.kind == "plan" && !self.steps.is_empty()
    }
    pub(crate) fn valid(&self) -> bool {
        !self.id.is_empty() && !self.task.is_empty()
    }
}

impl Pill {
    /// Queue one decision for the card on screen, at most once per card.
    pub(crate) fn decide(&mut self, allow: bool) -> bool {
        let Some(card) = self
            .snapshot
            .confirm
            .as_ref()
            .filter(|card| self.target && self.snapshot.state == "confirm" && card.valid())
        else {
            return false;
        };
        let identity = (card.id.clone(), card.task.clone());
        if self.decided.as_ref() == Some(&identity) || self.actions.len() >= capsules::ACTION_LIMIT
        {
            return false;
        }
        self.actions.push(json!({
            "session": self.snapshot.session,
            "state": "confirm",
            "action": if allow { "confirm-allow" } else { "confirm-deny" },
            "value": null,
            "ref": card.id,
            "task": card.task,
        }));
        self.decided = Some(identity);
        true
    }

    pub(crate) fn render_confirm(&self, opacity: f32, cx: &mut Context<Self>) -> AnyElement {
        let t = crate::theme::current();
        let card = self.snapshot.confirm.clone().unwrap_or_default();
        let plan = card.plan();
        let mut review = div()
            .id("native-confirm-review")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .pr(px(4.))
            .text_size(px(12.))
            .line_height(px(17.))
            .text_color(t.text);
        if plan {
            for step in &card.steps {
                review = review.child(
                    div()
                        .flex()
                        .gap(px(4.))
                        .mb(px(3.))
                        .child(
                            div()
                                .w(px(16.))
                                .flex_shrink_0()
                                .text_color(t.text_secondary)
                                .child(format!("{}.", step.index)),
                        )
                        .child(div().flex_1().child(step.summary.clone())),
                );
            }
        } else {
            review = review.child(card.summary.clone());
        }
        let button = |selector: &'static str, words: &'static str, primary: bool| {
            div()
                .id(selector)
                .debug_selector(move || selector.into())
                .h(px(28.))
                .px(px(if primary { 18. } else { 14. }))
                .rounded(px(14.))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(12.))
                .cursor_pointer()
                .border_1()
                .when(primary, |d| {
                    d.bg(t.text)
                        .text_color(t.background)
                        .border_color(t.text)
                        .font_weight(gpui::FontWeight::MEDIUM)
                })
                .when(!primary, |d| {
                    d.bg(t.hover)
                        .text_color(t.text)
                        .border_color(t.border)
                        .font_weight(gpui::FontWeight::NORMAL)
                })
                .child(words)
        };
        div()
            .id("native-dock-confirm")
            .debug_selector(|| "native-dock-confirm".into())
            .w(px(CARD.0 as f32))
            .h(px(CARD.1 as f32))
            .rounded(px(24.))
            .overflow_hidden()
            .bg(t.surface_raised)
            .border_1()
            .border_color(t.border)
            .font_family(t.font_ui)
            .font_weight(gpui::FontWeight::LIGHT)
            .opacity(opacity)
            .flex()
            .flex_col()
            .gap(px(8.))
            .pt(px(10.))
            .pb(px(10.))
            .px(px(18.))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .flex_col()
                    .gap(px(3.))
                    .min_h_0()
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_size(px(9.5))
                            .text_color(t.text_secondary)
                            .child(if plan {
                                "SYMON’S PLAN"
                            } else {
                                "SYMON WANTS TO"
                            }),
                    )
                    .child(review),
            )
            .child(
                div()
                    .flex()
                    .flex_shrink_0()
                    .gap(px(8.))
                    .justify_end()
                    .child(
                        button("native-confirm-deny", "Cancel", false).on_click(cx.listener(
                            |pill, _, _, cx| {
                                pill.decide(false);
                                cx.notify();
                            },
                        )),
                    )
                    .child(
                        button(
                            "native-confirm-allow",
                            if plan { "Run plan" } else { "Allow" },
                            true,
                        )
                        .on_click(cx.listener(|pill, _, _, cx| {
                            pill.decide(true);
                            cx.notify();
                        })),
                    ),
            )
            .into_any_element()
    }
}
