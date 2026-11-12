use super::*;
use crate::theme::current as palette;
use gpui::{IntoElement, div, prelude::*, px};

fn timestamp(ms: f64) -> String {
    // Gregorian civil date from Unix days, displayed explicitly in UTC.
    let seconds = (ms / 1000.) as i64;
    let days = seconds.div_euclid(86400) + 719468;
    let era = days.div_euclid(146097);
    let doe = days - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let time = seconds.rem_euclid(86400);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC",
        time / 3600,
        time / 60 % 60,
        time % 60
    )
}
impl Inbox {
    fn audit_button(
        &self,
        id: &'static str,
        title: String,
        control: usize,
        cx: &Context<Self>,
    ) -> impl IntoElement + use<> {
        div()
            .id(id)
            .debug_selector(move || id.into())
            .track_focus(&self.audit.focus[control])
            .tab_index(control as isize)
            .p(px(6.))
            .rounded(px(7.))
            .text_size(px(11.))
            .text_color(if control >= 4 && self.audit.loading {
                palette().text_muted
            } else {
                palette().text
            })
            .when(control < 4 || !self.audit.loading, |v| {
                v.cursor_pointer().hover(|s| s.bg(palette().hover))
            })
            .active(|s| s.bg(palette().selection))
            .focus(|s| s.bg(palette().selection))
            .child(title)
            .on_click(cx.listener(move |this, _, window, cx| {
                this.audit.focus[control].focus(window);
                this.audit_control(control, cx);
            }))
    }
    pub(in crate::inbox) fn audit_controls(&self, cx: &Context<Self>) -> impl IntoElement + use<> {
        let labels = [
            self.audit.session.clone().unwrap_or("All sessions".into()),
            RISKS[self.audit.risk].into(),
            RANGES[self.audit.range].into(),
        ];
        div()
            .max_w(px(620.))
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(8.))
                    .children(labels.into_iter().enumerate().map(|(i, title)| {
                        self.audit_button(
                            [
                                "approval-audit-session",
                                "approval-audit-risk",
                                "approval-audit-range",
                            ][i],
                            title,
                            i,
                            cx,
                        )
                    }))
                    .child(self.audit_button("approval-audit-clear", "Clear filters".into(), 3, cx))
                    .child(
                        self.audit_button(
                            "approval-audit-refresh",
                            if self.audit.loading {
                                "Refreshing…"
                            } else {
                                "Refresh"
                            }
                            .into(),
                            4,
                            cx,
                        ),
                    ),
            )
            .when_some(self.audit.menu, |v, filter| {
                v.child(
                    div()
                        .id("approval-audit-menu")
                        .max_h(px(180.))
                        .overflow_y_scroll()
                        .track_scroll(&self.audit.menu_scroll)
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .bg(palette().surface_raised)
                        .rounded(px(7.))
                        .p(px(6.))
                        .children(self.audit.options(filter).into_iter().enumerate().map(
                            |(index, title)| {
                                div()
                                    .id(("approval-audit-option", index))
                                    .p(px(6.))
                                    .rounded(px(7.))
                                    .bg(if index == self.audit.cursor {
                                        palette().selection
                                    } else {
                                        palette().surface_raised
                                    })
                                    .cursor_pointer()
                                    .hover(|s| s.bg(palette().hover))
                                    .child(title)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.audit.choose(filter, index);
                                        cx.notify();
                                    }))
                            },
                        ))
                        .child(
                            div()
                                .id("approval-audit-cancel")
                                .p(px(6.))
                                .cursor_pointer()
                                .bg(if self.audit.cursor == self.audit.options(filter).len() {
                                    palette().selection
                                } else {
                                    palette().surface_raised
                                })
                                .hover(|s| s.bg(palette().hover))
                                .child("Cancel")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.audit.menu = None;
                                    cx.notify();
                                })),
                        ),
                )
            })
    }
    pub(in crate::inbox) fn audit_body(&self, cx: &Context<Self>) -> impl IntoElement + use<> {
        let rows = self.audit.visible(now());
        div()
            .id("approval-audit-body")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.audit.scroll)
            .p(px(12.))
            .when(self.audit.loading, |v| {
                v.child(
                    div()
                        .text_color(palette().text_muted)
                        .child(if self.audit.loaded {
                            "Refreshing approval audit log…"
                        } else {
                            "Loading approval audit log…"
                        }),
                )
            })
            .when_some(self.audit.error.clone(), |v, error| {
                v.child(
                    div()
                        .debug_selector(|| "approval-audit-error".into())
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(div().text_color(palette().warning).child(error))
                        .child(self.audit_button("approval-audit-retry", "Retry".into(), 5, cx)),
                )
            })
            .when(
                self.audit.loaded && !self.audit.loading && rows.is_empty(),
                |v| {
                    v.child(
                        div()
                            .debug_selector(|| "approval-audit-empty".into())
                            .p(px(16.))
                            .text_color(palette().text_muted)
                            .child(if self.audit.rows.is_empty() {
                                "No approval audit events yet"
                            } else {
                                "No events match these filters"
                            }),
                    )
                },
            )
            .children(
                rows.into_iter()
                    .enumerate()
                    .map(|(index, row)| audit_row(row, index)),
            )
    }
}
fn audit_row(row: Row, index: usize) -> impl IntoElement {
    let event = &row.event;
    let review = text(event, "type") == "orchestrator_review";
    let verdict = event["approved"]
        .as_bool()
        .map(|approved| if approved { "Approved" } else { "Rejected" });
    div()
        .id(("approval-audit-row", index))
        .flex()
        .flex_col()
        .gap(px(6.))
        .mb(px(12.))
        .p(px(12.))
        .rounded(px(8.))
        .bg(palette().surface_raised)
        .child(div().text_size(px(13.5)).child(row.title))
        .child(
            div()
                .text_size(px(11.))
                .text_color(palette().text_muted)
                .child(format!(
                    "{} · {} risk · {}",
                    label(&text(event, "type")),
                    label(&row.risk),
                    timestamp(row.timestamp)
                )),
        )
        .child(div().text_size(px(11.)).child(format!(
            "Actor: {} · Session: {} · ID: {}",
            label(&text(event, "actor")),
            row.session,
            row.approval_id
        )))
        .when_some(verdict, |v, verdict| {
            v.child(div().child(format!("Verdict: {verdict}")))
        })
        .when(!text(event, "reviewer").is_empty(), |v| {
            v.child(div().child(format!("Reviewer: {}", text(event, "reviewer"))))
        })
        .when(!text(event, "diffSha").is_empty(), |v| {
            v.child(div().child(format!("Diff SHA: {}", text(event, "diffSha"))))
        })
        .when(!text(event, "note").is_empty(), |v| {
            v.child(
                div()
                    .text_size(px(11.5))
                    .child(format!("Note: {}", text(event, "note"))),
            )
        })
        .when(review, |v| {
            v.child(
                div()
                    .text_size(px(11.))
                    .text_color(palette().text_muted)
                    .child("Findings"),
            )
        })
        .when(
            review && event["findings"].as_array().is_none_or(Vec::is_empty),
            |v| v.child(div().child("No structured findings were recorded for this review.")),
        )
        .children(
            event["findings"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|finding| {
                    let location = match finding["line"].as_u64() {
                        Some(line) => format!("{}:{line}", text(finding, "file")),
                        None => text(finding, "file"),
                    };
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .p(px(8.))
                        .rounded(px(7.))
                        .bg(palette().background)
                        .child(div().text_size(px(11.)).child(format!(
                            "{} · {} · {location}",
                            label(&text(finding, "severity")),
                            label(&text(finding, "resolution"))
                        )))
                        .child(
                            div()
                                .text_size(px(11.5))
                                .child(text(finding, "description")),
                        )
                        .when(!text(finding, "fixSuggestion").is_empty(), |v| {
                            v.child(div().text_size(px(11.5)).child(format!(
                                "Suggested fix: {}",
                                text(finding, "fixSuggestion")
                            )))
                        })
                }),
        )
}
