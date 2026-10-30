//! Classic recurring-problems disclosure and the expanded evidence/history card.
use super::*;
fn status(value: &str) -> (&'static str, Rgba) {
    match value {
        "candidate" => ("Needs a decision", theme().accent),
        "accepted" => ("Accepted", theme().accent),
        "investigating" => ("Investigating", theme().accent),
        "remedy_active" => ("Remedy running", theme().accent),
        "provisionally_resolved" => ("Proving the fix", theme().warning),
        "verified_closed" => ("Verified closed", theme().success),
        "reopened" => ("Pain returned", theme().danger),
        "suppressed" => ("Suppressed", theme().text_faint),
        _ => ("Unknown", theme().text_muted),
    }
}
fn date(v: &serde_json::Value) -> String {
    use crate::shell::sidebar::{calendar_clock, calendar_date};
    let Some(time) = v.as_str().and_then(crate::clock::timestamp) else {
        return "Unknown".into();
    };
    let Some((month, day)) = calendar_date(time) else {
        return "Unknown".into();
    };
    let Some((_, hour, minute)) = calendar_clock(time) else {
        return "Unknown".into();
    };
    let name = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .get(month as usize)
    .copied()
    .unwrap_or("");
    format!(
        "{name} {day}, {}:{minute:02} {}",
        if hour % 12 == 0 { 12 } else { hour % 12 },
        if hour < 12 { "AM" } else { "PM" }
    )
}
impl ActivityPane {
    pub(super) fn dossiers(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let rows = self
            .decisions
            .dossiers
            .iter()
            .filter(|d| self.scope == "*" || d["repoPath"] == self.scope)
            .cloned()
            .collect::<Vec<_>>();
        if rows.is_empty() && self.decisions.error.is_none() {
            return None;
        }
        let active = rows
            .iter()
            .filter(|d| d["status"] != "verified_closed" && d["status"] != "suppressed")
            .count();
        let color = if active > 0 {
            theme().accent
        } else {
            theme().success
        };
        let header = self
            .control("activity-dossiers", Action::Dossiers, cx)
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(10.))
            .py(px(9.))
            .hover(|d| d.bg(theme().hover))
            .child(div().size(px(7.)).rounded_full().bg(color))
            .child(
                div()
                    .flex_1()
                    .text_size(px(11.5))
                    .font_weight(FontWeight(520.))
                    .child("Recurring problems"),
            )
            .child(
                div()
                    .text_size(px(10.))
                    .text_color(theme().text_muted)
                    .child(if active > 0 {
                        format!("{active} active")
                    } else {
                        format!("{} in history", rows.len())
                    }),
            )
            .child(icon::stroke(
                if self.decisions.open {
                    "m6 9 6 6 6-6"
                } else {
                    "m9 6 6 6-6 6"
                },
                theme().text_faint,
                11.,
                1.5,
            ));
        let mut section = div()
            .debug_selector(|| "activity-dossiers-section".into())
            .mx(px(10.))
            .my(px(8.))
            .flex_shrink_0()
            .border_1()
            .border_color(theme().border)
            .rounded(px(12.))
            .bg(theme().surface)
            .overflow_hidden()
            .child(header);
        if self.decisions.open {
            let mut content = div().border_t_1().border_color(theme().border);
            if let Some(error) = self.decisions.error.clone() {
                let retry = self.button(
                    "activity-dossiers-retry",
                    "Retry",
                    Action::RetryDossiers,
                    cx,
                );
                content = content.child(
                    div()
                        .debug_selector(|| "activity-dossiers-error".into())
                        .p(px(10.))
                        .text_size(px(11.))
                        .text_color(theme().danger)
                        .child(error)
                        .child(retry),
                );
            }
            for (index, dossier) in rows.iter().enumerate() {
                content = content.child(self.dossier(dossier, index, cx));
            }
            section = section.child(content);
        }
        Some(section.into_any_element())
    }
    fn dossier(
        &mut self,
        d: &serde_json::Value,
        index: usize,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let id = text(d, "id");
        let expanded = self.decisions.expanded.as_ref() == Some(&id);
        let (label, color) = status(&text(d, "status"));
        let summary = self
            .control(
                format!("activity-dossier-{id}"),
                Action::DossierHistory(id.clone()),
                cx,
            )
            .w_full()
            .flex()
            .flex_col()
            .gap(px(5.))
            .hover(|v| v.bg(theme().hover))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(7.))
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(9.5))
                            .font_weight(FontWeight(560.))
                            .text_color(color)
                            .child(label.to_uppercase()),
                    )
                    .child(
                        div()
                            .text_size(px(9.5))
                            .text_color(theme().text_faint)
                            .child(format!(
                                "{} signals",
                                d["occurrenceCount"].as_u64().unwrap_or(0)
                            )),
                    ),
            )
            .child(
                div()
                    .text_size(px(11.5))
                    .line_height(relative(1.42))
                    .child(text(d, "painStatement")),
            )
            .when(d["status"] == "provisionally_resolved", |v| {
                v.child(
                    div()
                        .text_size(px(10.))
                        .text_color(theme().text_muted)
                        .child(format!(
                            "{} of {} clean exposures",
                            d["comparableExposureCount"].as_u64().unwrap_or(0),
                            d["closureContract"]["requiredComparableExposures"]
                                .as_u64()
                                .unwrap_or(0)
                        )),
                )
            });
        let mut card = div()
            .debug_selector({
                let id = id.clone();
                move || format!("activity-dossier-card-{id}")
            })
            .p(px(10.))
            .when(index > 0, |v| v.border_t_1().border_color(theme().border))
            .child(summary);
        if expanded {
            let remedies = d["remedies"].as_array().cloned().unwrap_or_default();
            let mut history = div()
                .debug_selector({
                    let id = id.clone();
                    move || format!("activity-dossier-history-{id}")
                })
                .mt(px(9.))
                .text_size(px(10.5))
                .line_height(relative(1.5))
                .text_color(theme().text_muted)
                .child(format!(
                    "First seen {} · Last seen {}",
                    date(&d["firstObservedAt"]),
                    date(&d["lastObservedAt"])
                ))
                .child(format!(
                    "Confidence {} · Impact {}",
                    text(d, "evidenceConfidence"),
                    text(d, "impactBand")
                ));
            if let Some(task) = d["linkedTaskId"].as_str() {
                history = history.child(format!("Task {task}"));
            }
            if !remedies.is_empty() {
                history = history.child(format!(
                    "{} remedy attempt{}",
                    remedies.len(),
                    if remedies.len() == 1 { "" } else { "s" }
                ));
            }
            if let Some(remedy) = remedies.last() {
                for (key, label) in [
                    ("missionId", "Mission"),
                    ("laneId", "Lane"),
                    ("approvalId", "Approval"),
                    ("releaseRef", "Release"),
                ] {
                    if let Some(value) = remedy[key].as_str() {
                        history = history.child(
                            div()
                                .debug_selector({
                                    let id = id.clone();
                                    move || format!("activity-dossier-field-{id}-{key}")
                                })
                                .child(format!("{label} {value}")),
                        );
                    }
                }
            }
            for evidence in d["evidence"].as_array().into_iter().flatten() {
                history = history.child(format!(
                    "{} · {}",
                    text(evidence, "sourceKind").replace('_', " "),
                    text(evidence, "packetId")
                ));
            }
            let mut events = div()
                .mt(px(7.))
                .pt(px(7.))
                .border_t_1()
                .border_color(theme().border);
            for event in d["history"].as_array().into_iter().flatten() {
                events = events.child(format!(
                    "{} · {}{}",
                    date(&event["at"]),
                    text(event, "eventType").replace('_', " "),
                    event["note"]
                        .as_str()
                        .map(|s| format!(" · {s}"))
                        .unwrap_or_default()
                ));
            }
            if d["history"].as_array().is_some_and(|a| !a.is_empty()) {
                history = history.child(events);
            }
            card = card.child(history);
        }
        let mut controls = div().flex().flex_wrap().gap(px(6.)).mt(px(9.)).child(
            self.button(
                format!("activity-dossier-history-toggle-{id}"),
                if expanded {
                    "Hide history"
                } else {
                    "Inspect history"
                },
                Action::DossierHistory(id.clone()),
                cx,
            )
            .min_h(px(24.))
            .rounded(px(7.))
            .text_size(px(10.5)),
        );
        let busy = self.decisions.pending.contains_key(&id);
        for action in super::super::decisions::actions(d) {
            let control_id = format!("activity-dossier-{id}-{action}");
            let label = match *action {
                "accept" => "Accept",
                "suppress" => "Suppress",
                "stop" => "Stop",
                _ => "Resume",
            };
            let button = if busy {
                Self::inert(control_id, "Working…")
            } else {
                self.button(
                    control_id,
                    label,
                    Action::DossierDecision(id.clone(), action),
                    cx,
                )
            };
            controls = controls.child(
                button
                    .min_h(px(24.))
                    .rounded(px(7.))
                    .text_size(px(10.5))
                    .when(*action == "accept", |v| {
                        v.bg(theme().accent).text_color(crate::theme::on_accent())
                    }),
            );
        }
        card.child(controls)
    }
}
