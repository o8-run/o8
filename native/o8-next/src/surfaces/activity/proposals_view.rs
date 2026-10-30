//! O8DirectiveProposalDrawer and DirectiveProposalRow chrome and disclosure.
use super::super::proposals;
use super::*;
impl ActivityPane {
    pub(super) fn proposal_drawer(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let rows = self.proposals.rows();
        if rows.is_empty() && self.proposals.errors.is_empty() {
            return None;
        }
        let unread = rows
            .iter()
            .filter(|p| !self.proposals.snapshot.contains(&text(p, "id")))
            .count();
        let accent = theme().accent;
        let header=self.control("activity-proposals",Action::Proposals,cx).flex().items_center().gap(px(8.)).px(px(8.)).py(px(6.)).rounded(px(8.))
            .bg(if unread>0 {theme().selection}else if self.proposals.open {theme().hover}else{CLEAR})
            .hover(|v|v.bg(theme().hover))
            .child(icon::stroke(if self.proposals.open {"m6 9 6 6 6-6"}else{"m9 6 6 6-6 6"},if unread>0 {accent}else{theme().text_faint},10.,1.5))
            .child(div().flex_1().text_size(px(9.)).font_weight(FontWeight::LIGHT).text_color(if unread>0 {accent}else{theme().text_faint}).child("PROPOSED DIRECTIVES"))
            .child(div().id("activity-proposals-count").debug_selector(||"activity-proposals-count".into()).px(px(7.)).py(px(1.)).rounded_full().text_size(px(9.5)).bg(if unread>0 {accent}else{theme().hover}).text_color(if unread>0 {crate::theme::on_accent()}else{theme().text_faint})
                .child(if unread>0 {format!("{unread} new")}else{rows.len().to_string()})
                .tooltip(|_,cx|cx.new(|_|icon::Tip("Surfaced when the same fix-pattern appears 3+ times in the last 14 days".into())).into()));
        let mut section = div()
            .debug_selector(|| "activity-proposals-section".into())
            .flex_shrink_0()
            .px(px(12.))
            .py(px(8.))
            .mb(px(2.))
            .border_b_1()
            .border_color(theme().border)
            .child(header);
        if self.proposals.open {
            let mut list = div().flex().flex_col().gap(px(4.)).my(px(4.));
            for error in self.proposals.errors.clone() {
                list = list.child(
                    div()
                        .debug_selector(|| "activity-proposals-error".into())
                        .text_size(px(11.))
                        .text_color(theme().danger)
                        .child(error),
                );
            }
            if !self.proposals.errors.is_empty() {
                list = list.child(self.button(
                    "activity-proposals-retry",
                    "Retry proposals",
                    Action::RetryProposals,
                    cx,
                ));
            }
            for p in rows {
                list = list.child(self.proposal_row(&p, cx));
            }
            section = section.child(list);
        }
        Some(section.into_any_element())
    }
    fn proposal_row(&mut self, p: &serde_json::Value, cx: &mut Context<Self>) -> gpui::Div {
        let key = proposals::key(p);
        let fresh = !self.proposals.snapshot.contains(&text(p, "id"));
        let source = text(p, "source");
        let (badge, preview) = match source.as_str() {
            "cross-repo" => (
                format!(
                    "{}%",
                    (p["similarity"].as_f64().unwrap_or(0.) * 100.).round() as i64
                ),
                format!(
                    "{} → {} · {}",
                    text(p, "sourceRepoName"),
                    text(p, "targetRepoName"),
                    text(p, "directiveTitle")
                ),
            ),
            "observation" => (
                text(p, "kind")
                    .chars()
                    .take(3)
                    .collect::<String>()
                    .to_uppercase(),
                format!(
                    "observation: {} · proposed by {}{}",
                    text(p, "scope"),
                    text(p, "proposed_by"),
                    p["laneId"]
                        .as_str()
                        .filter(|id| *id != text(p, "proposed_by"))
                        .map(|id| format!(" / {id}"))
                        .unwrap_or_default()
                ),
            ),
            _ => (
                format!("{}× seen", p["hits"].as_u64().unwrap_or(0)),
                format!(
                    "add directive: {} → {}?",
                    text(p, "filePattern"),
                    text(p, "fixPattern")
                ),
            ),
        };
        let expanded = self.proposals.expanded.contains(&key);
        let pending = self.proposals.pending.get(&key).copied();
        let detail = self
            .control(
                format!("activity-proposal-{key}"),
                Action::ProposalDetail(key.clone()),
                cx,
            )
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(
                div()
                    .w(px(42.))
                    .flex_shrink_0()
                    .text_size(px(10.))
                    .font_family(theme().font_mono)
                    .text_color(theme().text_muted)
                    .child(badge),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_size(px(11.))
                    .child(preview),
            );
        let mut header = div()
            .h(px(34.))
            .px(px(8.))
            .pl(px(10.))
            .flex()
            .items_center()
            .gap(px(8.))
            .child(
                div()
                    .debug_selector({
                        let key = key.clone();
                        move || format!("activity-proposal-new-{key}")
                    })
                    .size(px(6.))
                    .flex_shrink_0()
                    .rounded_full()
                    .bg(if fresh { theme().accent } else { CLEAR }),
            )
            .child(detail);
        for (accept, label) in [(true, "Accept"), (false, "Dismiss")] {
            let id = format!(
                "activity-proposal-{key}-{}",
                if accept { "accept" } else { "dismiss" }
            );
            let button = if pending.is_some() {
                Self::inert(id, label)
            } else {
                self.button(id, label, Action::ProposalDecision(key.clone(), accept), cx)
            };
            header = header.child(
                button
                    .min_h(px(22.))
                    .h(px(22.))
                    .px(px(8.))
                    .rounded(px(6.))
                    .text_size(px(10.))
                    .font_weight(FontWeight(450.))
                    .flex_shrink_0()
                    .when(accept && pending.is_none(), |v| {
                        v.bg(theme().accent).text_color(crate::theme::on_accent())
                    }),
            );
        }
        let mut row = div()
            .debug_selector({
                let key = key.clone();
                move || format!("activity-proposal-card-{key}")
            })
            .rounded(px(8.))
            .border_1()
            .border_color(if fresh {
                theme().accent
            } else {
                theme().border
            })
            .bg(theme().surface_raised)
            .overflow_hidden()
            .hover(|v| v.bg(theme().hover))
            .child(header);
        if let Some(label) = pending {
            row = row.child(
                div()
                    .debug_selector(|| "activity-proposal-pending".into())
                    .px(px(12.))
                    .pb(px(6.))
                    .text_size(px(10.))
                    .text_color(theme().text_muted)
                    .child(label),
            );
        }
        if expanded {
            let mut detail = div()
                .debug_selector({
                    let key = key.clone();
                    move || format!("activity-proposal-details-{key}")
                })
                .border_t_1()
                .border_color(theme().border)
                .px(px(12.))
                .pt(px(8.))
                .pb(px(12.))
                .flex()
                .flex_col()
                .gap(px(6.))
                .text_size(px(11.5))
                .line_height(relative(1.45))
                .text_color(theme().text_secondary);
            if source == "cross-repo" {
                detail = detail
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(theme().text)
                            .child(text(p, "directiveTitle")),
                    )
                    .child(
                        p["directiveBody"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .unwrap_or("(no body)")
                            .to_owned(),
                    )
                    .child(
                        div()
                            .text_size(px(10.))
                            .text_color(theme().text_muted)
                            .child(format!(
                                "Imported from {} · {}% stack overlap with {}",
                                text(p, "sourceRepoName"),
                                (p["similarity"].as_f64().unwrap_or(0.) * 100.).round() as i64,
                                text(p, "targetRepoName")
                            )),
                    );
            } else {
                detail = detail
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child(if source == "observation" {
                                "Worker observation:".to_string()
                            } else {
                                format!(
                                    "Detected pattern (seen {}× in last 14 days):",
                                    p["hits"].as_u64().unwrap_or(0)
                                )
                            }),
                    )
                    .child(if source == "observation" {
                        text(p, "text")
                    } else {
                        format!("{} → {}", text(p, "filePattern"), text(p, "fixPattern"))
                    })
                    .when(source == "observation", |v| {
                        v.child(
                            div()
                                .text_size(px(10.))
                                .text_color(theme().text_muted)
                                .child(format!(
                                    "Proposed by {} · {} · {}",
                                    text(p, "proposed_by"),
                                    text(p, "scope"),
                                    text(p, "kind")
                                )),
                        )
                    })
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child("Draft directive:"),
                    )
                    .child(text(p, "draftDirective"));
            }
            row = row.child(detail);
        }
        row
    }
}
