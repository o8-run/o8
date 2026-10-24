use super::*;
use crate::{activity_feed::text, theme::current as theme};
use gpui::{IntoElement, Render, SharedString, canvas, div, prelude::*, px};

impl ActivityPane {
    fn button(
        &mut self,
        id: impl Into<String>,
        label: impl Into<SharedString>,
        action: Action,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let id = id.into();
        let selected = self.keyboard == Some(self.controls.len());
        self.controls.push((id.clone(), action.clone()));
        div()
            .id(SharedString::from(id.clone()))
            .debug_selector(move || id.clone())
            .min_h(px(26.))
            .px(px(9.))
            .py(px(4.))
            .rounded(px(7.))
            .text_size(px(12.))
            .font_weight(gpui::FontWeight::LIGHT)
            .bg(if selected {
                theme().selection
            } else {
                theme().surface
            })
            .hover(|v| v.bg(theme().hover))
            .cursor_pointer()
            .child(label.into())
            .on_click(cx.listener(move |this, _, window, cx| {
                this.focus(window);
                this.act(action.clone(), cx);
            }))
    }
    fn link(
        &mut self,
        id: &str,
        label: &str,
        url: Option<String>,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        match url {
            Some(url) => self
                .button(id, label.to_owned(), Action::Link(url), cx)
                .into_any_element(),
            None => div()
                .child("No GitHub remote")
                .text_color(theme().text_faint)
                .into_any_element(),
        }
    }
    fn detail_view(&mut self, row: &Row, cx: &mut Context<Self>) -> gpui::AnyElement {
        let mut view = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .pl(px(24.))
            .pr(px(12.))
            .py(px(8.))
            .text_size(px(12.))
            .text_color(theme().text_secondary);
        match row.kind {
            "commit" => {
                view = view
                    .child(row.id.clone())
                    .child(row.title.clone())
                    .child(self.link("activity-open-commit", "Open commit", row.url(), cx));
            }
            "issue" => {
                let labels = row.data["labels"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|l| text(l, "name"))
                    .collect::<Vec<_>>()
                    .join(" · ");
                view = view
                    .child(labels)
                    .child(
                        text(&row.data, "body")
                            .chars()
                            .take(200)
                            .collect::<String>(),
                    )
                    .child(format!(
                        "{} comments",
                        row.data["comments"].as_u64().unwrap_or(0)
                    ))
                    .child(self.link("activity-open-issue", "Open issue", row.url(), cx));
            }
            "ci" | "pr" => {
                let detail = self.details.get(&row.key());
                let loading = detail.is_some_and(|d| d.loading);
                let error = detail.and_then(|d| d.error.clone());
                let updated = detail.and_then(|d| d.updated);
                let value = detail.and_then(|d| d.value.clone());
                if loading {
                    view = view.child(
                        div()
                            .debug_selector(|| "activity-detail-loading".into())
                            .child(if value.is_some() {
                                "Refreshing details…"
                            } else {
                                "Loading details…"
                            }),
                    );
                }
                if let Some(error) = error {
                    view = view.child(
                        div()
                            .debug_selector(|| "activity-detail-delayed".into())
                            .text_color(theme().warning)
                            .child(format!("Details delayed: {error}.")),
                    );
                    if let Some(updated) = updated {
                        view = view.child(format!(
                            "Showing last known details ({}s old).",
                            updated.elapsed().as_secs()
                        ));
                    }
                }
                match value {
                    Some(DetailValue::Ci(detail)) => {
                        for (i, job) in detail
                            .run
                            .jobs
                            .iter()
                            .filter(|j| {
                                j.conclusion
                                    .as_deref()
                                    .is_some_and(|s| s.eq_ignore_ascii_case("failure"))
                            })
                            .take(3)
                            .enumerate()
                        {
                            let step = job
                                .steps
                                .iter()
                                .find(|s| {
                                    s.conclusion
                                        .as_deref()
                                        .is_some_and(|s| s.eq_ignore_ascii_case("failure"))
                                })
                                .map(|s| s.name.as_str())
                                .unwrap_or("");
                            view = view.child(
                                div()
                                    .debug_selector(move || format!("activity-ci-job-{i}"))
                                    .text_color(theme().danger)
                                    .child(format!("{} · {step}", job.name)),
                            );
                        }
                        if let Some(line) = detail.logs.lines().find(|l| {
                            l.contains("##[error]")
                                || l.to_lowercase().contains("error ts")
                                || l.to_lowercase().contains("failed")
                        }) {
                            view = view.child(
                                line.rsplit("##[error]")
                                    .next()
                                    .unwrap_or(line)
                                    .trim()
                                    .chars()
                                    .take(200)
                                    .collect::<String>(),
                            );
                        }
                        for pr in detail.run.pull_requests.iter().filter(|p| p.number > 0) {
                            let url = row
                                .repo
                                .as_ref()
                                .filter(|r| feed::valid_slug(r))
                                .map(|r| format!("https://github.com/{r}/pull/{}", pr.number));
                            view = view.child(self.link(
                                &format!("activity-open-ci-pr-{}", pr.number),
                                &format!("Open PR #{}", pr.number),
                                url,
                                cx,
                            ));
                        }
                    }
                    Some(DetailValue::Pr(detail)) => {
                        view = view.child(format!(
                            "Checks: {} · Review: {}",
                            text(&detail, "checksStatus"),
                            text(&detail, "reviewDecision")
                        ));
                        for (i, file) in detail["files"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .take(6)
                            .enumerate()
                        {
                            view = view.child(
                                div()
                                    .debug_selector(move || format!("activity-pr-file-{i}"))
                                    .child(format!(
                                        "{} +{} -{}",
                                        text(file, "path"),
                                        file["additions"],
                                        file["deletions"]
                                    )),
                            );
                        }
                        view = view.child(text(&detail, "body"));
                    }
                    _ => {}
                }
                let retry = if row.kind == "ci" {
                    "activity-ci-retry"
                } else {
                    "activity-pr-retry"
                };
                view = view.child(self.button(
                    retry,
                    if row.kind == "ci" {
                        "Retry CI details"
                    } else {
                        "Retry PR details"
                    },
                    Action::RetryDetail(row.clone()),
                    cx,
                ));
                view = view.child(self.link(
                    if row.kind == "ci" {
                        "activity-open-run"
                    } else {
                        "activity-open-pr"
                    },
                    if row.kind == "ci" {
                        "Open CI run"
                    } else {
                        "Open PR details"
                    },
                    row.url(),
                    cx,
                ));
            }
            "packet" => {
                view = view
                    .child(text(&row.data, "summary"))
                    .child(text(&row.data, "blockedReason"));
                if let Some(key) = row.data["lane"]["sessionKey"]
                    .as_str()
                    .or(row.data["lane"]["tabId"].as_str())
                    .filter(|s| !s.is_empty())
                {
                    view = view.child(self.button(
                        "activity-open-worker",
                        "Open worker",
                        Action::Worker(key.into()),
                        cx,
                    ));
                }
                if !self.pending && (row.data["queueState"] == "held" || row.data["lane"].is_null())
                {
                    let held = row.data["queueState"] == "held";
                    view = view.child(self.button(
                        if held {
                            "activity-release"
                        } else {
                            "activity-hold"
                        },
                        if held { "Release hold" } else { "Hold" },
                        Action::Hold(row.clone(), !held),
                        cx,
                    ));
                }
            }
            _ => {}
        }
        view.into_any_element()
    }
}
impl Render for ActivityPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.controls.clear();
        let revision = self.revision;
        let painted = self.painted.clone();
        let mut header = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(12.))
            .child("Activity");
        let mut scope = div().flex().flex_wrap().gap(px(4.));
        scope = scope.child(self.button(
            "activity-scope-all",
            "All repositories",
            Action::Scope("*".into()),
            cx,
        ));
        for (i, repo) in self.repos.clone().iter().enumerate() {
            scope = scope.child(self.button(
                format!("activity-scope-{i}"),
                format!(
                    "{}{}",
                    if self.scope == repo.local_path {
                        "• "
                    } else {
                        ""
                    },
                    repo.name
                ),
                Action::Scope(repo.local_path.clone()),
                cx,
            ));
        }
        header = header.child(scope);
        let mut controls = div().flex().flex_wrap().gap(px(4.));
        for (filter, label) in [
            ("all", "All"),
            ("commit", "Commits"),
            ("pr", "PRs"),
            ("issue", "Issues"),
            ("ci", "CI"),
            ("packet", "Packets"),
        ] {
            let count = self
                .rows
                .iter()
                .filter(|r| filter == "all" || r.kind == filter || filter == "ci" && r.ci.is_some())
                .count();
            controls = controls.child(
                self.button(
                    format!("activity-filter-{filter}"),
                    format!("{label} {count}"),
                    Action::Filter(filter),
                    cx,
                )
                .bg(if self.filter == filter {
                    theme().selection
                } else {
                    theme().surface
                }),
            );
        }
        controls =
            controls.child(self.button("activity-refresh", "Retry / Refresh", Action::Refresh, cx));
        if self.mission["missionId"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
            && !self.pending
        {
            controls = controls.child(self.button(
                "activity-stop-mission",
                "Stop mission",
                Action::StopMission,
                cx,
            ));
        }
        header = header.child(controls);
        let mut list = div()
            .id("activity-list")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(4.))
            .p(px(12.));
        for error in self.errors.clone() {
            list = list.child(div().text_color(theme().warning).child(error));
        }
        if !self.notice.is_empty() {
            list = list.child(self.notice.clone());
        }
        let rows = self
            .rows
            .iter()
            .filter(|r| {
                self.filter == "all"
                    || r.kind == self.filter
                    || self.filter == "ci" && r.ci.is_some()
            })
            .cloned()
            .collect::<Vec<_>>();
        if self.loading {
            list = list.child(
                div()
                    .debug_selector(|| "activity-loading".into())
                    .child("Loading activity…"),
            );
        } else if rows.is_empty() && self.errors.is_empty() {
            let connected = self.scope == "*"
                || self
                    .repos
                    .iter()
                    .any(|r| r.local_path == self.scope && r.slug().is_some());
            let message = if self.scope.is_empty() {
                "Choose a folder to see activity here."
            } else if !connected && matches!(self.filter, "pr" | "issue" | "ci") {
                "Connect GitHub to see pull requests, issues, and CI runs."
            } else if !connected && matches!(self.filter, "all" | "commit") {
                "No commits yet in this folder."
            } else {
                "No activity yet for this repository."
            };
            list = list.child(
                div()
                    .debug_selector(|| "activity-empty".into())
                    .text_color(theme().text_faint)
                    .child(message),
            );
        }
        let mut day = String::new();
        for row in rows {
            let date = row.date.get(..10).unwrap_or("");
            if date != day {
                day = date.into();
                list = list.child(
                    div()
                        .text_size(px(10.))
                        .text_color(theme().text_faint)
                        .child(day.clone()),
                );
            }
            let key = row.key();
            let expanded = self.expanded.as_ref() == Some(&key);
            let mut summary = self
                .button(
                    row.selector(),
                    row.title.clone(),
                    Action::Expand(row.clone()),
                    cx,
                )
                .w_full()
                .text_size(px(13.5))
                .bg(if expanded {
                    theme().selection
                } else {
                    theme().surface
                });
            if let Some(ci) = &row.ci {
                summary = summary.child(format!(" · {}", text(&ci.data, "conclusion")));
            }
            list = list.child(summary).child(
                div()
                    .text_size(px(9.5))
                    .text_color(theme().text_faint)
                    .child(format!(
                        "{} · {}",
                        row.meta,
                        row.repo.as_deref().unwrap_or("local")
                    )),
            );
            if expanded {
                list = list.child(self.detail_view(&row, cx));
            }
        }
        div()
            .id("activity-pane")
            .debug_selector(|| "activity-pane".into())
            .size_full()
            .flex()
            .flex_col()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::key_down))
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .font_weight(gpui::FontWeight::LIGHT)
            .child(header)
            .child(list)
            .child(canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision)).size(px(1.)))
    }
}
