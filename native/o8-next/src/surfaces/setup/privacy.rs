//! The desktop's first-run privacy choices (TelemetryConsentCard.tsx, as
//! embedded in onboarding): usage analytics on by default with a one-click
//! turn-off, crash reports as a separate choice, and the complete event
//! list, example payload and scrubbed crash sample.
use super::look::{self, Look};
use super::{Action, Setup};
use crate::theme::current as theme;
use gpui::{Context, Div, FontWeight, IntoElement, Pixels, div, prelude::*, px, relative};
use serde::Deserialize;
use std::sync::LazyLock;

/// The disclosures the desktop shows, copied from its own modules; a vitest
/// keeps this copy equal to them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Disclosures {
    events: Vec<Event>,
    example_payload: String,
    crash_sample: String,
}
#[derive(Deserialize)]
struct Event {
    event: String,
    fields: String,
}
static DISCLOSURES: LazyLock<Disclosures> = LazyLock::new(|| {
    serde_json::from_str(include_str!("privacy-disclosures.json"))
        .expect("bundled privacy disclosures")
});

const SHIELD: &str = "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z M9 12l2 2 4-5";
const CHECK: &str = "m3 8 3 3 7-7";

fn tracked(mut v: Div, spacing: Pixels) -> Div {
    v.style()
        .text
        .get_or_insert_with(Default::default)
        .letter_spacing = Some(spacing);
    v
}
fn mono() -> Div {
    div().font_family(theme().font_mono)
}
fn code_block(text: &str) -> Div {
    mono()
        .p(px(12.))
        .rounded(px(10.))
        .bg(theme().code_background)
        .text_color(theme().text_secondary)
        .text_size(px(10.5))
        .line_height(relative(1.5))
        .child(text.to_owned())
}
fn card() -> Div {
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .p(px(20.))
        .rounded(px(14.))
        .border_1()
        .border_color(theme().border)
        .bg(theme().surface_raised)
}
fn heading(title: &'static str, note: String) -> Div {
    div()
        .flex()
        .items_end()
        .justify_between()
        .gap(px(12.))
        .mb(px(8.))
        .child(
            div()
                .text_size(px(16.))
                .font_weight(FontWeight::NORMAL)
                .child(title),
        )
        .child(
            mono()
                .text_size(px(10.))
                .text_color(theme().text_faint)
                .child(note),
        )
}
fn copy(text: &'static str) -> Div {
    div()
        .mb(px(12.))
        .text_size(px(12.5))
        .font_weight(FontWeight::LIGHT)
        .line_height(relative(1.5))
        .text_color(theme().text_secondary)
        .child(text)
}
/// The desktop's ChoiceButton: a full-width choice, filled when selected.
fn choice(
    id: &'static str,
    label: &'static str,
    selected: bool,
    enabled: bool,
) -> gpui::Stateful<Div> {
    look::button(id, "", enabled, Look::Bordered)
        .w_full()
        .justify_center()
        .gap(px(8.))
        .px(px(14.))
        .text_size(px(12.5))
        .font_weight(FontWeight::NORMAL)
        .when(selected, |v| {
            v.border_color(theme().text)
                .bg(theme().text)
                .text_color(theme().background)
        })
        .when(!selected, |v| v.hover(|v| v.bg(theme().hover)))
        .when(selected, |v| {
            v.child(crate::icon::stroke(CHECK, theme().background, 13., 1.8))
        })
        .child(label)
}

pub(super) fn page(this: &Setup, busy: bool, cx: &mut Context<Setup>) -> impl IntoElement {
    let usage = this.telemetry;
    let crashes = this.crashes;
    let can_save = crashes.is_some() && !busy;
    let disclosures = &*DISCLOSURES;
    div()
        .debug_selector(|| "setup-privacy".into())
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        // The choices scroll; the save row stays at the bottom of the frame,
        // as the desktop's sticky footer does.
        .child(
            div()
                .id("setup-privacy-scroll")
                .debug_selector(|| "setup-privacy-scroll".into())
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
        .child(
            div()
                .w_full()
                .flex()
                .items_start()
                .gap(px(16.))
                .child(
                    div()
                        .size(px(44.))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(12.))
                        .border_1()
                        .border_color(theme().border)
                        .bg(theme().code_background)
                        .child(crate::icon::stroke(SHIELD, theme().text, 22., 1.7)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .flex()
                                .gap(px(10.))
                                .mb(px(8.))
                                .text_size(px(10.))
                                .font_weight(FontWeight::LIGHT)
                                .text_color(theme().text_muted)
                                .child(tracked(div(), px(1.8)).child("PRIVACY"))
                                .child(tracked(mono(), px(0.4)).child("(first run)")),
                        )
                        .child(
                            tracked(div(), px(-0.4))
                                .mb(px(8.))
                                .text_size(px(28.))
                                .font_weight(FontWeight::NORMAL)
                                .line_height(relative(1.2))
                                .child("You choose what o8 sends."),
                        )
                ),
        )
        // Below the title row, indented past the shield: text in a row's
        // flexible column wraps at the row's full width in gpui.
        .child(
            div()
                .ml(px(60.))
                .mb(px(24.))
                .text_size(px(13.5))
                .font_weight(FontWeight::LIGHT)
                .line_height(relative(1.55))
                .text_color(theme().text_secondary)
                .child(
                    "Usage analytics are on by default for installs without an earlier \
                     choice. Default-on sharing starts after you finish this screen. Turn \
                     them off with one click. Crash reports are a separate opt-in. You can \
                     change either choice in Settings → General → Privacy.",
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(16.))
                .child(
                    card()
                        .child(heading(
                            "Usage analytics",
                            format!("({} events)", disclosures.events.len()),
                        ))
                        .child(copy(
                            "Helps us understand which features get used. These are the \
                             complete event names and fields. No identity is collected beyond \
                             sign-in; the event payload contains no identity fields.",
                        ))
                        .child(
                            div()
                                .debug_selector(|| "setup-telemetry-status".into())
                                .mt(px(16.))
                                .mb(px(8.))
                                .text_size(px(12.5))
                                .text_color(theme().text_secondary)
                                .child(if this.error.is_some() {
                                    "Check the save status above before continuing."
                                } else if usage == Some(false) {
                                    "Usage analytics are off."
                                } else {
                                    "Usage analytics are on."
                                }),
                        )
                        .child(
                            choice(
                                "setup-telemetry",
                                if usage == Some(false) {
                                    "Turn on"
                                } else {
                                    "Turn off"
                                },
                                false,
                                !busy,
                            )
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !this.busy {
                                    let next = this.telemetry == Some(false);
                                    // Keep the choice even if the save is lost, so
                                    // the final save cannot restore default-on.
                                    this.telemetry = Some(next);
                                    this.act(Action::Usage(next), cx);
                                }
                            })),
                        )
                        .child(div().flex().flex_col().border_t_1().border_color(theme().border).children(
                            disclosures.events.iter().map(|row| {
                                div()
                                    .flex()
                                    .gap(px(12.))
                                    .py(px(10.))
                                    .border_b_1()
                                    .border_color(theme().border)
                                    .text_size(px(10.5))
                                    .child(mono().w(px(160.)).flex_none().child(row.event.clone()))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .font_weight(FontWeight::LIGHT)
                                            .line_height(relative(1.4))
                                            .text_color(theme().text_muted)
                                            .child(row.fields.clone()),
                                    )
                            }),
                        ))
                        .child(
                            div()
                                .mt(px(12.))
                                .mb(px(6.))
                                .text_size(px(11.))
                                .text_color(theme().text_secondary)
                                .child("Example payload when a project is added"),
                        )
                        .child(code_block(&disclosures.example_payload))
                        .child(
                            div()
                                .mt(px(12.))
                                .p(px(12.))
                                .rounded(px(10.))
                                .border_1()
                                .border_color(theme().border)
                                .bg(theme().code_background)
                                .child(
                                    tracked(div(), px(0.8))
                                        .mb(px(5.))
                                        .text_size(px(10.))
                                        .child("NEVER SENT IN PRODUCT USAGE"),
                                )
                                .child(
                                    div()
                                        .text_size(px(11.))
                                        .font_weight(FontWeight::LIGHT)
                                        .line_height(relative(1.5))
                                        .text_color(theme().text_secondary)
                                        .child(
                                            "Code, prompts, repo names, file paths, diffs, \
                                             transcripts, file contents, credentials, user \
                                             identity, or machine identity.",
                                        ),
                                ),
                        ),
                )
                .child(
                    card()
                        .child(heading("Crash reports", "(errors + stacks)".into()))
                        .child(copy(
                            "Helps diagnose failures with scrubbed errors and stack traces. \
                             Native crash reports may include thread-stack memory and \
                             loaded-module paths, beginning on the next launch.",
                        ))
                        .child(
                            div()
                                .id("setup-crash-sample")
                                .debug_selector(|| "setup-crash-sample".into())
                                .mb(px(8.))
                                .text_size(px(12.))
                                .text_color(theme().text_secondary)
                                .cursor_pointer()
                                .child(if this.crash_sample {
                                    "▾ See a sample crash report"
                                } else {
                                    "▸ See a sample crash report"
                                })
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.crash_sample = !this.crash_sample;
                                    this.revision += 1;
                                    cx.notify();
                                })),
                        )
                        .when(this.crash_sample, |v| {
                            v.child(
                                tracked(div(), px(0.8))
                                    .mb(px(6.))
                                    .text_size(px(10.))
                                    .font_weight(FontWeight::LIGHT)
                                    .text_color(theme().text_muted)
                                    .child("SCRUBBED SAMPLE PAYLOAD"),
                            )
                            .child(
                                div()
                                    .id("setup-crash-sample-payload")
                                    .debug_selector(|| "setup-crash-sample-payload".into())
                                    .max_h(px(230.))
                                    .overflow_y_scroll()
                                    .rounded(px(10.))
                                    .border_1()
                                    .border_color(theme().border)
                                    .child(code_block(&disclosures.crash_sample).min_h(px(176.))),
                            )
                            .child(
                                div()
                                    .mt(px(10.))
                                    .text_size(px(10.5))
                                    .font_weight(FontWeight::LIGHT)
                                    .line_height(relative(1.45))
                                    .text_color(theme().text_muted)
                                    .child(
                                        "This sample uses placeholders and the same scrubber as \
                                         browser and server reports.",
                                    ),
                            )
                        })
                        .child(
                            div()
                                .mt(px(16.))
                                .flex()
                                .gap(px(8.))
                                .child(
                                    div().flex_1().min_w_0().child(
                                        choice(
                                            "setup-crashes-share",
                                            "Share crash reports",
                                            crashes == Some(true),
                                            !busy,
                                        )
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            if !this.busy {
                                                this.crashes = Some(true);
                                                this.revision += 1;
                                                cx.notify();
                                            }
                                        })),
                                    ),
                                )
                                .child(
                                    div().flex_1().min_w_0().child(
                                        choice(
                                            "setup-crashes-off",
                                            "Keep crash reports off",
                                            crashes == Some(false),
                                            !busy,
                                        )
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            if !this.busy {
                                                this.crashes = Some(false);
                                                this.revision += 1;
                                                cx.notify();
                                            }
                                        })),
                                    ),
                                ),
                        ),
                ),
        )
        )
        .child(
            div()
                .flex_none()
                .mt(px(12.))
                .pt(px(12.))
                .flex()
                .flex_wrap()
                .items_center()
                .justify_between()
                .gap(px(16.))
                .border_t_1()
                .border_color(theme().border)
                .child(
                    div()
                        .debug_selector(|| "setup-privacy-status".into())
                        .min_h(px(20.))
                        .text_size(px(11.5))
                        .font_weight(FontWeight::LIGHT)
                        .line_height(relative(1.45))
                        .text_color(if this.error.is_some() {
                            theme().danger
                        } else {
                            theme().text_muted
                        })
                        .child(match &this.error {
                            Some(error) => error.clone(),
                            None if crashes.is_some() => {
                                "Your privacy choices are ready to save.".into()
                            }
                            None => "Choose whether to share crash reports to continue.".into(),
                        }),
                )
                .child(
                    look::button(
                        "setup-consent",
                        if busy { "Saving choices…" } else { "Save privacy choices" },
                        can_save,
                        if crashes.is_some() {
                            Look::Primary
                        } else {
                            Look::Bordered
                        },
                    )
                    .flex_none()
                    .px(px(20.))
                    .on_click(cx.listener(|this, _, _, cx| {
                        if this.crashes.is_some() {
                            this.act(Action::Consent, cx)
                        }
                    })),
                ),
        )
}
