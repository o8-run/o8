//! The PR detail's tab bodies, as desktop PrSummary, TimelineTab, ChangesTab,
//! ChecksTab and ReviewsTab draw them.
use super::super::controls::{USER, icon};
use super::*;
use crate::{
    model::Row,
    retained::{RetainedRow, RowState},
};
use std::{cell::RefCell, collections::BTreeSet};

const CHEVRON_RIGHT: &str = "m9 18 6-6-6-6";
const CHEVRON_DOWN: &str = "m6 9 6 6 6-6";

/// PrMarkdown: the transcript's markdown rows.
fn markdown(id: &str, body: &str) -> AnyElement {
    let state = Rc::new(RefCell::new(RowState::new(Row::Message {
        id: id.to_owned(),
        role: "assistant".into(),
        nodes: crate::text::markdown(body),
    })));
    RetainedRow {
        state,
        index: 0,
        painted: Rc::new(RefCell::new(BTreeSet::new())),
    }
    .into_any_element()
}

fn muted(text: impl Into<gpui::SharedString>) -> gpui::Div {
    div()
        .text_size(px(12.))
        .text_color(theme().text_muted)
        .child(text.into())
}

fn small_button(id: String, label: &'static str) -> gpui::Stateful<gpui::Div> {
    let selector = id.clone();
    div()
        .id(gpui::SharedString::from(id))
        .debug_selector(move || selector.clone())
        .min_h(px(28.))
        .px(px(8.))
        .flex()
        .items_center()
        .rounded(px(7.))
        .border_1()
        .border_color(theme().border)
        .text_size(px(11.))
        .text_color(theme().text_secondary)
        .cursor_pointer()
        .hover(|b| b.bg(theme().hover))
        .child(label)
}

fn age(at: &str) -> String {
    crate::clock::age(crate::clock::timestamp(at), crate::clock::now())
}

impl PullRequests {
    pub(super) fn tab_body(&self, cx: &mut Context<Self>) -> AnyElement {
        match self.tab.as_str() {
            "timeline" => self.timeline_tab(cx),
            "changes" => self.changes_tab(cx),
            "checks" => self.checks_tab(cx),
            "reviews" => self.reviews_tab(),
            _ => self.summary_tab(cx),
        }
    }

    fn summary_tab(&self, cx: &mut Context<Self>) -> AnyElement {
        let d = &self.detail;
        let reviewers = if d["requestedReviewers"].is_null() {
            "Not available".to_owned()
        } else {
            let names: Vec<_> = array(d, "requestedReviewers")
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            if names.is_empty() { "None requested".into() } else { names.join(", ") }
        };
        let labels: Vec<_> = array(d, "labels")
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        let term = |text: &'static str| div().w(px(80.)).flex_shrink_0().text_color(theme().text_muted).child(text);
        let open = self.description_open;
        let body = string(d, "body").trim().to_owned();
        let commits = format!("{}/commits", string(d, "url"));
        div()
            .pt(px(18.))
            .px(px(18.))
            .pb(px(24.))
            .text_size(px(12.))
            .flex()
            .flex_col()
            .child(
                div()
                    .mb(px(22.))
                    .flex()
                    .flex_col()
                    .gap(px(14.))
                    .child(div().flex().child(term("Reviewers")).child(div().text_color(theme().text_secondary).child(reviewers)))
                    .child(
                        div().flex().child(term("Labels")).child(
                            div()
                                .flex()
                                .flex_wrap()
                                .gap(px(6.))
                                .children(labels.iter().map(|l| super::super::label_chip(l)))
                                .when(labels.is_empty(), |row| {
                                    row.child(muted(if d["labels"].is_null() { "Not available" } else { "None" }))
                                }),
                        ),
                    ),
            )
            .child(
                div()
                    .id("pr-description-toggle")
                    .debug_selector(|| "pr-description-toggle".into())
                    .mb(px(12.))
                    .min_h(px(28.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_color(theme().text_muted)
                    .cursor_pointer()
                    .child(icon(if open { CHEVRON_DOWN } else { CHEVRON_RIGHT }, 13.))
                    .child("Description")
                    .on_click(cx.listener(|s, _, _, cx| {
                        s.description_open = !s.description_open;
                        s.changed(cx);
                    })),
            )
            .when(open, |c| {
                c.child(if body.is_empty() {
                    muted("No description provided.").into_any_element()
                } else {
                    markdown("pr-description", &body)
                })
            })
            .child(
                div()
                    .id("pr-commits-link")
                    .mt(px(16.))
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .text_size(px(11.))
                    .text_color(theme().accent)
                    .cursor_pointer()
                    .child("View commits on GitHub")
                    .child(crate::icon::stroke(EXTERNAL, theme().accent, 11., 1.8))
                    .on_click(move |_, _, cx| {
                        if commits.starts_with("https://") {
                            cx.open_url(&commits)
                        }
                    }),
            )
            .into_any_element()
    }

    fn timeline_tab(&self, cx: &mut Context<Self>) -> AnyElement {
        let d = &self.detail;
        let mut events = vec![json!({
            "id": "opened", "title": "opened this pull request", "actor": string(d, "author"),
            "at": string(d, "createdAt"), "body": "",
        })];
        events.extend(self.timeline.iter().cloned());
        events.sort_by_key(|e| crate::clock::timestamp(string(e, "at")).unwrap_or(0));
        if self.newest_first {
            events.reverse();
        }
        let loaded = !self.timeline.is_empty() || self.timeline_next.is_some();
        let mut list = div().flex().flex_col();
        if loaded || (!self.timeline_loading && self.timeline_error.is_empty()) {
            for (i, e) in events.iter().enumerate() {
                let body = string(e, "body").trim().to_owned();
                let sha = string(e, "commitSha").chars().take(7).collect::<String>();
                list = list.child(
                    div()
                        .relative()
                        .flex()
                        .gap(px(12.))
                        .pb(px(20.))
                        .child(
                            div()
                                .absolute()
                                .left(px(11.))
                                .top(px(25.))
                                .bottom(px(2.))
                                .w(px(1.))
                                .bg(theme().border),
                        )
                        .child(
                            div()
                                .size(px(24.))
                                .flex_shrink_0()
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded_full()
                                .bg(theme().surface_raised)
                                .child(icon(USER, 14.)),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .child(
                                            div()
                                                .flex()
                                                .flex_wrap()
                                                .gap(px(4.))
                                                .child(div().font_weight(gpui::FontWeight::MEDIUM).child(string(e, "actor").to_owned()))
                                                .child(div().text_color(theme().text_secondary).child(string(e, "title").to_owned())),
                                        ),
                                )
                                .child(
                                    div()
                                        .mt(px(3.))
                                        .flex()
                                        .gap(px(8.))
                                        .text_size(px(10.))
                                        .text_color(theme().text_muted)
                                        .when(!sha.is_empty(), |m| m.child(div().font_family(theme().font_mono).child(sha)))
                                        .child(age(string(e, "at"))),
                                )
                                .when(!body.is_empty(), |c| {
                                    c.child(
                                        div()
                                            .mt(px(8.))
                                            .py(px(10.))
                                            .px(px(12.))
                                            .rounded(px(9.))
                                            .border_1()
                                            .border_color(theme().border)
                                            .bg(theme().surface_raised)
                                            .child(markdown(&format!("pr-timeline-{i}"), &body)),
                                    )
                                }),
                        ),
                );
            }
        }
        div()
            .pt(px(12.))
            .px(px(18.))
            .pb(px(18.))
            .child(
                div()
                    .mb(px(16.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(div().text_size(px(11.)).text_color(theme().text_muted).child(if loaded {
                        format!("{} events{}", events.len(), if self.timeline_next.is_some() { " loaded" } else { "" })
                    } else {
                        "Pull request activity".into()
                    }))
                    .child(
                        div()
                            .flex()
                            .gap(px(6.))
                            .child(
                                small_button("pr-timeline-order".into(), if self.newest_first { "Newest first" } else { "Oldest first" })
                                    .on_click(cx.listener(|s, _, _, cx| {
                                        s.newest_first = !s.newest_first;
                                        s.changed(cx);
                                    })),
                            )
                            .child(
                                small_button("pr-timeline-refresh".into(), "Refresh")
                                    .on_click(cx.listener(|s, _, _, cx| s.load_timeline(false, cx))),
                            ),
                    ),
            )
            .when(self.timeline_loading && !loaded, |c| {
                c.child(muted(format!("Loading activity for PR #{}…", self.selected.unwrap_or_default())))
            })
            .when(!self.timeline_error.is_empty(), |c| {
                c.child(
                    div()
                        .mb(px(12.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .text_size(px(12.))
                        .text_color(theme().danger)
                        .child(self.timeline_error.clone())
                        .child(
                            small_button("pr-timeline-retry".into(), "Retry activity")
                                .on_click(cx.listener(|s, _, _, cx| s.load_timeline(false, cx))),
                        ),
                )
            })
            .child(list)
            .when(self.timeline_next.is_some(), |c| {
                c.child(
                    small_button("pr-timeline-more".into(), "Load more activity")
                        .on_click(cx.listener(|s, _, _, cx| s.load_timeline(true, cx))),
                )
            })
            .into_any_element()
    }

    fn changes_tab(&self, cx: &mut Context<Self>) -> AnyElement {
        let files = array(&self.detail, "files");
        if files.is_empty() {
            return div().p(px(16.)).child(muted("No file changes reported.")).into_any_element();
        }
        let all_open = files.iter().all(|f| self.open_files.contains(string(f, "path")));
        let toolbar = div()
            .px(px(18.))
            .pb(px(8.))
            .flex()
            .items_center()
            .justify_between()
            .text_size(px(11.))
            .text_color(theme().text_muted)
            .child(format!(
                "{} files · +{} −{}",
                self.detail["changedFiles"].as_u64().unwrap_or(files.len() as u64),
                self.detail["additions"].as_u64().unwrap_or(0),
                self.detail["deletions"].as_u64().unwrap_or(0)
            ))
            .child(
                small_button("pr-files-toggle".into(), if all_open { "Collapse all" } else { "Expand all" })
                    .on_click(cx.listener(move |s, _, _, cx| {
                        if all_open {
                            s.open_files.clear();
                        } else {
                            s.open_files = array(&s.detail, "files")
                                .iter()
                                .map(|f| string(f, "path").to_owned())
                                .collect();
                        }
                        s.changed(cx);
                    })),
            );
        let mut list = div().flex().flex_col().px(px(12.)).gap(px(6.));
        for (i, f) in files.iter().enumerate() {
            let path = string(f, "path").to_owned();
            let open = self.open_files.contains(&path);
            let toggle = path.clone();
            let mut file = div()
                .rounded(px(10.))
                .border_1()
                .border_color(theme().border)
                .overflow_hidden()
                .child(
                    div()
                        .id(("pr-file", i))
                        .debug_selector(move || format!("pr-file-{i}"))
                        .px(px(10.))
                        .py(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .cursor_pointer()
                        .hover(|h| h.bg(theme().hover))
                        .child(icon(if open { CHEVRON_DOWN } else { CHEVRON_RIGHT }, 12.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .font_family(theme().font_mono)
                                .text_size(px(11.5))
                                .child(path),
                        )
                        .child(div().text_size(px(11.)).text_color(theme().success).child(format!("+{}", f["additions"].as_u64().unwrap_or(0))))
                        .child(div().text_size(px(11.)).text_color(theme().danger).child(format!("−{}", f["deletions"].as_u64().unwrap_or(0))))
                        .on_click(cx.listener(move |s, _, _, cx| {
                            if !s.open_files.remove(&toggle) {
                                s.open_files.insert(toggle.clone());
                            }
                            s.changed(cx);
                        })),
                );
            if open {
                let patch = f["patch"].as_str();
                let mut lines = div()
                    .border_t_1()
                    .border_color(theme().border)
                    .py(px(4.))
                    .font_family(theme().font_mono)
                    .text_size(px(11.))
                    .flex()
                    .flex_col();
                match patch {
                    Some(patch) => {
                        for line in patch.lines() {
                            let (bg, color) = match line.chars().next() {
                                Some('+') => (Some(theme().success_surface), theme().text),
                                Some('-') => (Some(theme().danger_surface), theme().text),
                                Some('@') => (None, theme().text_muted),
                                _ => (None, theme().text_secondary),
                            };
                            lines = lines.child(
                                div()
                                    .px(px(10.))
                                    .min_h(px(17.))
                                    .when_some(bg, |l, bg| l.bg(bg))
                                    .text_color(color)
                                    .whitespace_nowrap()
                                    .child(if line.is_empty() { " ".to_owned() } else { line.to_owned() }),
                            );
                        }
                    }
                    None => {
                        lines = lines.child(
                            div().px(px(10.)).py(px(6.)).text_color(theme().text_muted).child("Patch unavailable. Open GitHub to inspect this file."),
                        )
                    }
                }
                file = file.child(lines);
            }
            list = list.child(file);
        }
        div().pb(px(18.)).child(toolbar).child(list).into_any_element()
    }

    fn checks_tab(&self, cx: &mut Context<Self>) -> AnyElement {
        let d = &self.detail;
        let checks = array(d, "statusCheckRollup");
        let mut body = div().flex().flex_col();
        if checks.is_empty() {
            body = body.child(div().p(px(16.)).child(muted("No checks reported for this PR.")));
        }
        if d["checksUnavailable"] == true {
            body = body.child(div().px(px(14.)).py(px(8.)).child(muted("Some checks are unavailable. Refresh to try again.")));
        }
        for (bucket, label) in [
            ("failing", "Failing"),
            ("running", "Running"),
            ("passed", "Passed"),
            ("neutral", "Neutral"),
            ("skipped", "Skipped"),
        ] {
            let items: Vec<_> = checks.iter().enumerate().filter(|(_, c)| check_bucket(c) == bucket).collect();
            if items.is_empty() {
                continue;
            }
            let (glyph, color) = match bucket {
                "failing" => (X_CIRCLE, theme().danger),
                "passed" => (CHECK_CIRCLE, theme().success),
                "running" => (CLOCK, theme().warning),
                _ => (CLOCK, theme().text_muted),
            };
            let mut group = div()
                .id(gpui::SharedString::from(format!("pr-check-group-{bucket}")))
                .debug_selector(move || format!("pr-check-group-{bucket}"))
                .flex()
                .flex_col()
                .flex_shrink_0()
                .child(
                    div()
                        .py(px(9.))
                        .px(px(14.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .border_b_1()
                        .border_color(theme().border)
                        .text_size(px(10.))
                        .text_color(theme().text_faint)
                        .child(label)
                        .child(items.len().to_string()),
                );
            for (i, c) in items {
                let url = string(c, "url").to_owned();
                let link = url.starts_with("https://") || url.starts_with("http://");
                group = group.child(
                    div()
                        .id(("pr-check-row", i))
                        .debug_selector(move || format!("pr-check-row-{i}"))
                        .flex()
                        .flex_shrink_0()
                        .items_center()
                        .gap(px(10.))
                        .py(px(9.))
                        .px(px(14.))
                        .border_b_1()
                        .border_color(theme().border)
                        .child(crate::icon::stroke(glyph, color, 14., 1.8))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .gap(px(2.))
                                .child(div().text_size(px(12.5)).truncate().child(string(c, "name").to_owned()))
                                .child(div().text_size(px(10.)).text_color(theme().text_muted).child(
                                    match (string(c, "status"), string(c, "conclusion")) {
                                        (status, "") => status.to_lowercase(),
                                        (_, conclusion) => conclusion.to_lowercase(),
                                    },
                                )),
                        )
                        .when(link, |row| {
                            row.child(
                                div()
                                    .id(gpui::SharedString::from(format!("pr-check-{i}")))
                                    .debug_selector(move || format!("pr-check-{i}"))
                                    .py(px(3.))
                                    .px(px(8.))
                                    .flex()
                                    .items_center()
                                    .gap(px(4.))
                                    .rounded(px(7.))
                                    .text_size(px(10.))
                                    .text_color(theme().text_faint)
                                    .cursor_pointer()
                                    .hover(|b| b.bg(theme().hover).text_color(theme().text))
                                    .child("View run")
                                    .child(crate::icon::stroke(EXTERNAL, theme().text_faint, 11., 1.8))
                                    .on_click(move |_, _, cx| cx.open_url(&url)),
                            )
                        }),
                );
            }
            body = body.child(group);
        }
        // Merge gates and the packet preview the desktop shows beside checks.
        let gates = array(&d["mergeGate"], "checks");
        if !gates.is_empty() || self.packet.is_some() {
            let gate_row = |check: &Value| {
                let pass = check["verdict"] == "pass";
                div()
                    .py(px(8.))
                    .px(px(14.))
                    .flex()
                    .gap(px(10.))
                    .border_b_1()
                    .border_color(theme().border)
                    .child(crate::icon::stroke(
                        if pass { CHECK_CIRCLE } else { X_CIRCLE },
                        if pass { theme().success } else { theme().danger },
                        14.,
                        1.8,
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(div().text_size(px(12.)).child(string(check, "name").to_owned()))
                            .child(div().text_size(px(11.)).text_color(theme().text_muted).child(string(check, "detail").to_owned()))
                            .children(array(check, "actions").iter().filter_map(|a| a.as_str().map(str::to_owned)).map(|a| {
                                div().text_size(px(11.)).text_color(theme().text_secondary).child(a)
                            })),
                    )
            };
            body = body.child(
                div()
                    .pt(px(16.))
                    .pb(px(6.))
                    .px(px(14.))
                    .text_size(px(10.))
                    .text_color(theme().text_faint)
                    .child("Merge gates"),
            );
            body = body.children(gates.iter().map(gate_row));
            if let Some(packet) = &self.packet {
                body = body
                    .child(div().px(px(14.)).py(px(8.)).child(muted(
                        "Packet-linked merging and enabling auto-merge are unavailable in this build. Use the governed packet merge surface.",
                    )))
                    .child(div().px(px(14.)).child(muted(format!(
                        "Packet {packet} · merge preview: {}",
                        if self.preview["wouldMerge"] == true { "would merge" } else { "would not merge" }
                    ))))
                    .children(array(&self.preview, "checks").iter().map(gate_row));
            }
        }
        let _ = cx;
        body.into_any_element()
    }

    fn reviews_tab(&self) -> AnyElement {
        let d = &self.detail;
        let mut comments: Vec<(String, String, String, String)> = array(d, "issueComments")
            .iter()
            .map(|c| {
                let author = match string(c, "user") { "" => string(c, "author"), user => user };
                let at = match string(c, "created_at") { "" => string(c, "createdAt"), at => at };
                (author.to_owned(), at.to_owned(), String::new(), string(c, "body").to_owned())
            })
            .collect();
        comments.extend(array(d, "reviewComments").iter().map(|c| {
            let author = match string(c, "author") { "" => string(c, "user"), author => author };
            let at = match string(c, "createdAt") { "" => string(c, "created_at"), at => at };
            let path = match c["line"].as_u64() {
                Some(line) => format!("{}:{line}", string(c, "path")),
                None => string(c, "path").to_owned(),
            };
            (author.to_owned(), at.to_owned(), path, string(c, "body").to_owned())
        }));
        comments.sort_by_key(|(_, at, _, _)| crate::clock::timestamp(at).unwrap_or(0));
        let decision = match string(d, "reviewDecision").to_uppercase().as_str() {
            "APPROVED" => Some(("Approved", theme().success)),
            "CHANGES_REQUESTED" => Some(("Changes Requested", theme().danger)),
            "COMMENTED" => Some(("Commented", theme().text_muted)),
            "" => None,
            _ => Some(("Reviewed", theme().text_muted)),
        };
        div()
            .flex()
            .flex_col()
            .when_some(decision, |c, (label, color)| {
                c.child(
                    div()
                        .py(px(10.))
                        .px(px(14.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .border_b_1()
                        .border_color(theme().border)
                        .bg(theme().surface_raised)
                        .child(div().text_size(px(10.)).text_color(theme().text_faint).child("Latest review:"))
                        .child(
                            div()
                                .px(px(8.))
                                .py(px(2.))
                                .rounded_full()
                                .bg(gpui::Rgba { a: 0.14, ..color })
                                .text_size(px(11.))
                                .text_color(color)
                                .child(label),
                        ),
                )
            })
            .when(d["discussionIncomplete"] == true, |c| {
                c.child(div().px(px(14.)).py(px(8.)).child(muted("Discussion is incomplete. Open GitHub for the full conversation.")))
            })
            .when(comments.is_empty(), |c| c.child(div().p(px(16.)).child(muted("No discussion reported."))))
            .children(comments.into_iter().enumerate().map(|(i, (author, at, path, body))| {
                div()
                    .flex()
                    .gap(px(10.))
                    .py(px(12.))
                    .px(px(14.))
                    .border_b_1()
                    .border_color(theme().border)
                    .child(
                        div()
                            .size(px(26.))
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_full()
                            .bg(theme().surface_raised)
                            .text_size(px(11.))
                            .text_color(theme().text_secondary)
                            .child(author.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or("?".into())),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(
                                div()
                                    .flex()
                                    .flex_wrap()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(div().text_size(px(13.5)).font_weight(gpui::FontWeight::LIGHT).child(author))
                                    .child(div().text_size(px(9.5)).text_color(theme().text_faint).child(age(&at)))
                                    .when(!path.is_empty(), |h| {
                                        h.child(
                                            div()
                                                .min_w_0()
                                                .truncate()
                                                .font_family(theme().font_mono)
                                                .text_size(px(10.))
                                                .text_color(theme().text_muted)
                                                .child(path),
                                        )
                                    }),
                            )
                            .child(if body.trim().is_empty() {
                                muted("No comment text.").into_any_element()
                            } else {
                                markdown(&format!("pr-review-{i}"), &body)
                            }),
                    )
            }))
            .into_any_element()
    }
}
