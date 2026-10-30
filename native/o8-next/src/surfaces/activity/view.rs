use super::super::marks::{self, tint};
use super::feed::text;
use super::*;
use crate::icon;
use crate::theme::current as theme;
use gpui::{
    Corner, FontWeight, IntoElement, Render, Rgba, SharedString, anchored, canvas, deferred, div,
    prelude::*, px, relative,
};

/// A 0.5px border, as classic's `0.5px solid` group outlines.
fn hairline<E: Styled>(mut element: E) -> E {
    let width = Some(px(0.5).into());
    element.style().border_widths = gpui::EdgesRefinement {
        top: width,
        right: width,
        bottom: width,
        left: width,
    };
    element
}

const CLEAR: Rgba = Rgba {
    r: 0.,
    g: 0.,
    b: 0.,
    a: 0.,
};

impl ActivityPane {
    /// A click and keyboard stop: its id, selector and action, unstyled.
    fn control(
        &mut self,
        id: impl Into<String>,
        action: Action,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let id = id.into();
        let control_id = id.clone();
        self.controls.push((id.clone(), action.clone()));
        div()
            .id(SharedString::from(id.clone()))
            .debug_selector(move || id.clone())
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, window, cx| {
                this.focus(window);
                this.keyboard = Some(control_id.clone());
                this.act(action.clone(), cx);
            }))
    }
    fn button(
        &mut self,
        id: impl Into<String>,
        label: impl Into<SharedString>,
        action: Action,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let id = id.into();
        let selected = self.keyboard.as_ref() == Some(&id);
        self.control(id, action, cx)
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
            .child(label.into())
    }
    /// A control that is busy: same box, dimmed, with no click or keyboard stop.
    fn inert(id: impl Into<String>, label: impl Into<SharedString>) -> gpui::Stateful<gpui::Div> {
        let id = id.into();
        div()
            .id(SharedString::from(id.clone()))
            .debug_selector(move || id.clone())
            .min_h(px(26.))
            .px(px(9.))
            .py(px(4.))
            .rounded(px(7.))
            .text_size(px(12.))
            .font_weight(gpui::FontWeight::LIGHT)
            .bg(theme().surface)
            .opacity(0.6)
            .child(label.into())
    }
    /// O8ActivityMissionControls' compact button: 24px, hairline, 10px medium.
    fn compact(
        &mut self,
        id: &'static str,
        label: &'static str,
        action: Action,
        busy: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let selected = self.keyboard.as_deref() == Some(id);
        let base = if busy {
            div().id(id).debug_selector(move || id.into()).opacity(0.55)
        } else {
            self.control(id, action, cx).hover(|v| v.bg(theme().hover))
        };
        hairline(
            base.flex_shrink_0()
                .h(px(24.))
                .px(px(8.))
                .rounded(px(8.))
                .border_color(theme().border)
                .flex()
                .items_center()
                .bg(if selected { theme().selection } else { CLEAR })
                .text_size(px(10.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme().text_muted),
        )
        .child(label)
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
                    .child(match row.url() {
                        // Classic opens the issue in the shell's issue view.
                        Some(_) => self
                            .button(
                                "activity-open-issue",
                                "Open issue",
                                Action::Open(row.clone()),
                                cx,
                            )
                            .into_any_element(),
                        None => self.link("activity-open-issue", "Open issue", None, cx),
                    });
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
                view = view.child(match (row.kind, row.url()) {
                    ("ci", url) => self.link("activity-open-run", "Open CI run", url, cx),
                    // Classic's "Open PR details" opens the pull request in the app.
                    (_, Some(_)) => self
                        .button(
                            "activity-open-pr",
                            "Open PR details",
                            Action::Open(row.clone()),
                            cx,
                        )
                        .into_any_element(),
                    (_, None) => self.link("activity-open-pr", "Open PR details", None, cx),
                });
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
                // PacketCard's lifecycle buttons and review section.
                let status = text(&row.data, "status");
                let lane = !text(&row.data["lane"], "laneId").is_empty();
                let mut lifecycle = div().flex().flex_wrap().gap(px(6.));
                let mut any = false;
                if lane
                    && !self.pending
                    && row.data["operatorStopped"] != true
                    && matches!(status.as_str(), "running" | "launching" | "recovering")
                {
                    lifecycle = lifecycle.child(self.button(
                        "activity-lane-stop",
                        "Stop",
                        Action::Lane(row.clone(), "stop"),
                        cx,
                    ));
                    any = true;
                }
                if lane
                    && !self.pending
                    && matches!(status.as_str(), "idle" | "awaiting_review" | "recovering")
                {
                    lifecycle = lifecycle.child(self.button(
                        "activity-lane-resume",
                        "Resume",
                        Action::Lane(row.clone(), "resume"),
                        cx,
                    ));
                    any = true;
                }
                if lane
                    && !self.pending
                    && (status == "awaiting_review"
                        || (status == "blocked"
                            && row.data["blockedReason"] == "Awaiting operator input"))
                {
                    lifecycle = lifecycle
                        .child(self.button(
                            "activity-lane-create-pr",
                            "Create PR",
                            Action::Lane(row.clone(), "create_pr"),
                            cx,
                        ))
                        .child(self.button(
                            "activity-lane-merge",
                            "Merge",
                            Action::Lane(row.clone(), "merge"),
                            cx,
                        ));
                    any = true;
                }
                if any {
                    view = view.child(lifecycle);
                }
                if status == "awaiting_review"
                    && (!self.pending || self.closing.as_deref() == Some(row.id.as_str()))
                {
                    view = view.child(self.close_unmerged(row, cx));
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
impl ActivityPane {
    /// PacketCloseUnmergedActions: one button, then a reason and a confirm.
    fn close_unmerged(&mut self, row: &Row, cx: &mut Context<Self>) -> gpui::AnyElement {
        if self.closing.as_deref() != Some(row.id.as_str()) {
            return div()
                .flex()
                .justify_end()
                .child(self.button(
                    "activity-close-unmerged",
                    "Close unmerged…",
                    Action::CloseAsk(Some(row.id.clone())),
                    cx,
                ))
                .into_any_element();
        }
        let stage = self.close_stage;
        let mut reasons = div().flex().flex_wrap().gap(px(6.));
        for (reason, label) in super::CLOSE_REASONS {
            let chosen = self.close_reason == reason;
            let id = format!("activity-close-reason-{reason}");
            reasons = reasons.child(
                if stage.is_some() {
                    Self::inert(id, label)
                } else {
                    self.button(id, label, Action::CloseReason(reason), cx)
                }
                .when(chosen, |button| {
                    button.border_1().border_color(theme().accent)
                }),
            );
        }
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_secondary)
                    .child(
                        "Close this packet without merging. Its branch is preserved when possible.",
                    ),
            )
            .child(reasons)
            .child(
                div()
                    .flex()
                    .gap(px(6.))
                    .child(match stage {
                        Some(stage) => Self::inert("activity-close-confirm", stage),
                        None => self.button(
                            "activity-close-confirm",
                            "Confirm close",
                            Action::Close(row.clone()),
                            cx,
                        ),
                    })
                    .child(match stage {
                        Some(_) => Self::inert("activity-close-cancel", "Cancel"),
                        None => self.button(
                            "activity-close-cancel",
                            "Cancel",
                            Action::CloseAsk(None),
                            cx,
                        ),
                    }),
            )
            .into_any_element()
    }
}
/// A repository's label and owner, as O8RepoSelector's repoMeta.
fn repo_meta(repo: &feed::Repo) -> (String, String) {
    match repo.slug() {
        Some(slug) => match slug.split_once('/') {
            Some((owner, name)) => (name.to_owned(), owner.to_owned()),
            None => (slug, String::new()),
        },
        None => (repo.name.clone(), String::new()),
    }
}

/// O8RepoSelector: one chip, and a menu of All repos and each repository.
impl ActivityPane {
    fn scope_selector(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let open = self.scope_menu;
        let accent = tint(marks::ACCENT, 1.);
        let label = if self.scope == "*" {
            "All repos".to_owned()
        } else {
            self.repos
                .iter()
                .find(|repo| repo.local_path == self.scope)
                .map(|repo| repo_meta(repo).0)
                .or_else(|| {
                    self.scope
                        .rsplit(['/', '\\'])
                        .find(|s| !s.is_empty())
                        .map(String::from)
                })
                .unwrap_or_else(|| "No repo".into())
        };
        let selected = self.keyboard.as_deref() == Some("activity-scope");
        let chip = hairline(
            self.control("activity-scope", Action::ScopeMenu(!open), cx)
                .flex()
                .items_center()
                .gap(px(5.))
                .w_full()
                .min_h(px(28.))
                .pl(px(8.))
                .pr(px(10.))
                .rounded(px(8.))
                .border_color(theme().border)
                .bg(if open || selected {
                    theme().hover
                } else {
                    theme().surface
                })
                .hover(|v| v.bg(theme().hover))
                .text_size(px(13.5))
                .font_weight(FontWeight::LIGHT)
                .line_height(relative(1.25))
                .text_color(theme().text),
        )
        .child(
            div()
                .size(px(18.))
                .flex_shrink_0()
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(tint(marks::ACCENT, 0.08))
                .child(icon::stroke(marks::FOLDER, accent, 11., 2.)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .whitespace_normal()
                .line_clamp(1)
                .text_ellipsis()
                .child(label),
        )
        .child(icon::stroke(
            marks::CHEVRON_DOWN,
            theme().text_muted,
            10.,
            2.,
        ));
        let mut wrapper = div().relative().flex_1().min_w_0().child(chip);
        if !open {
            return wrapper;
        }
        let row =
            |this: &mut Self, id: String, action: Action, checked: bool, cx: &mut Context<Self>| {
                let selected = this.keyboard.as_ref() == Some(&id);
                this.control(id, action, cx)
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .w_full()
                    .px(px(12.))
                    .py(px(7.))
                    .text_size(px(13.5))
                    .font_weight(FontWeight::LIGHT)
                    .text_color(if checked { accent } else { theme().text })
                    .bg(if checked {
                        tint(marks::ACCENT, 0.08)
                    } else if selected {
                        theme().selection
                    } else {
                        CLEAR
                    })
                    .when(!checked, |row| row.hover(|v| v.bg(theme().hover)))
            };
        let mut menu = div()
            .id("activity-scope-menu")
            .debug_selector(|| "activity-scope-menu".into())
            .occlude()
            .w(px(280.))
            .max_h(px(240.))
            .overflow_y_scroll()
            .rounded(px(12.))
            .bg(crate::theme::popover_background())
            .border_1()
            .border_color(theme().border)
            .shadow_lg()
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.scope_menu = false;
                this.changed(cx);
            }))
            .child(
                row(
                    self,
                    "activity-scope-all".into(),
                    Action::Scope("*".into()),
                    self.scope == "*",
                    cx,
                )
                .border_b_1()
                .border_color(theme().border)
                .child("All repos"),
            );
        for (i, repo) in self.repos.clone().iter().enumerate() {
            let (label, owner) = repo_meta(repo);
            let checked = self.scope != "*" && repo.local_path == self.scope;
            menu = menu.child(
                row(
                    self,
                    format!("activity-scope-{i}"),
                    Action::Scope(repo.local_path.clone()),
                    checked,
                    cx,
                )
                .child(icon::stroke(
                    marks::FOLDER,
                    if checked { accent } else { theme().text_muted },
                    12.,
                    2.,
                ))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .whitespace_normal()
                        .line_clamp(1)
                        .text_ellipsis()
                        .child(label),
                )
                .when(!owner.is_empty(), |row| {
                    row.child(
                        div()
                            .flex_shrink_0()
                            .pl(px(8.))
                            .text_size(px(9.5))
                            .font_weight(FontWeight(260.))
                            .text_color(theme().text_faint)
                            .child(owner),
                    )
                }),
            );
        }
        wrapper = wrapper.child(
            div().absolute().top(px(32.)).left_0().child(deferred(
                anchored()
                    .anchor(Corner::TopLeft)
                    .snap_to_window_with_margin(px(12.))
                    .child(menu),
            )),
        );
        wrapper
    }
}

/// Classic feed-row parts: the status dot, subline and trailing badge.
impl ActivityPane {
    fn dot(row: &Row) -> gpui::Div {
        let dot = div()
            .size(px(20.))
            .mt(px(1.))
            .flex_shrink_0()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center();
        if row.kind == "packet" {
            let (_, color, wash) = marks::packet_tone(&text(&row.data, "status"));
            return dot
                .bg(wash)
                .child(div().size(px(6.)).rounded_full().bg(color));
        }
        let (path, hue) = marks::feed_icon(row);
        dot.bg(tint(hue, 0.08))
            .child(icon::stroke(path, tint(hue, 1.), 11., 2.))
    }
    fn subline(row: &Row, now: u64) -> gpui::Div {
        let faint = theme().text_faint;
        let sep = || div().flex_shrink_0().text_color(faint).child("·");
        let clip = |value: String| {
            div()
                .min_w_0()
                .whitespace_normal()
                .line_clamp(1)
                .text_ellipsis()
                .child(value)
        };
        let chip = |label: String, hue: Rgba, wash: Rgba| {
            div()
                .flex_shrink_0()
                .px(px(4.))
                .rounded(px(4.))
                .bg(wash)
                .text_color(hue)
                .font_weight(FontWeight::LIGHT)
                .child(label)
        };
        let line = div()
            .flex()
            .items_center()
            .gap(px(6.))
            .mt(px(3.))
            .min_w_0()
            .overflow_hidden()
            .text_size(px(9.5))
            .font_weight(FontWeight(260.))
            .line_height(relative(1.25))
            .text_color(faint);
        match row.kind {
            "commit" => {
                let date = text(&row.data, "date");
                let line = line
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_color(theme().text_secondary)
                            .child(row.id.clone()),
                    )
                    .child(sep())
                    .child(marks::age(
                        if date.is_empty() { &row.date } else { &date },
                        now,
                    ));
                match &row.ci {
                    Some(ci) => {
                        let outcome = marks::conclusion(&ci.data);
                        let hue = marks::outcome(&outcome);
                        line.child(chip(
                            if outcome.is_empty() {
                                "ci".into()
                            } else {
                                outcome
                            },
                            tint(hue, 1.),
                            tint(hue, 0.08),
                        ))
                    }
                    None => line,
                }
            }
            "pr" => line
                .child(
                    div()
                        .flex_shrink_0()
                        .text_color(tint(marks::ADD, 1.))
                        .child(format!("+{}", row.data["additions"].as_u64().unwrap_or(0))),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .text_color(tint(marks::DELETE, 1.))
                        .child(format!("-{}", row.data["deletions"].as_u64().unwrap_or(0))),
                )
                .child(sep())
                .child(clip(text(&row.data, "headRefName")))
                .child(sep())
                .child(div().flex_shrink_0().child(marks::age(&row.date, now))),
            "issue" => {
                let mut line = line;
                let labels = row.data["labels"].as_array().cloned().unwrap_or_default();
                for label in labels.iter().take(2) {
                    let hue =
                        u32::from_str_radix(&text(label, "color"), 16).unwrap_or(marks::MERGE);
                    // Classic washes a label in its own color at #18.
                    line = line.child(chip(text(label, "name"), tint(hue, 1.), tint(hue, 0.094)));
                }
                if !labels.is_empty() {
                    line = line.child(sep());
                }
                line.child(marks::age(&row.date, now))
            }
            "ci" => {
                let outcome = marks::conclusion(&row.data);
                line.child(clip(text(&row.data, "workflowName")))
                    .child(sep())
                    .child(clip(text(&row.data, "headBranch")))
                    .child(sep())
                    .child(
                        div()
                            .flex_shrink_0()
                            .font_weight(FontWeight::NORMAL)
                            .text_color(tint(marks::outcome(&outcome), 1.))
                            .child(outcome),
                    )
            }
            _ => {
                let target = text(&row.data, "workspaceTargetPath");
                let place = [
                    target
                        .rsplit(['/', '\\'])
                        .find(|s| !s.is_empty())
                        .unwrap_or(""),
                    text(&row.data, "branchTarget").trim(),
                ]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("·");
                let age = marks::age(&row.date, now);
                let mut line = line;
                for (i, part) in [place, age]
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .enumerate()
                {
                    if i > 0 {
                        line = line.child(sep());
                    }
                    line = line.child(clip(part));
                }
                line
            }
        }
    }
    fn badge(row: &Row) -> Option<gpui::Div> {
        let state = text(&row.data, "state").to_lowercase();
        let (label, hue, wash) = match row.kind {
            "pr" if !state.is_empty() => {
                let hue = match state.as_str() {
                    "merged" => marks::MERGE,
                    "open" => marks::SUCCESS,
                    _ => marks::DANGER,
                };
                (state.to_uppercase(), tint(hue, 1.), tint(hue, 0.08))
            }
            "issue" if !state.is_empty() => {
                let hue = if state == "open" {
                    marks::SUCCESS
                } else {
                    marks::MERGE
                };
                (state.to_uppercase(), tint(hue, 1.), tint(hue, 0.08))
            }
            "packet" => {
                let (label, color, _) = marks::packet_tone(&text(&row.data, "status"));
                (label.to_uppercase(), color, Rgba { a: 0.1, ..color })
            }
            _ => return None,
        };
        Some(
            div()
                .flex_shrink_0()
                .mt(px(4.))
                .px(px(6.))
                .py(px(1.))
                .rounded_full()
                .text_size(px(9.))
                .font_weight(FontWeight::LIGHT)
                .bg(wash)
                .text_color(hue)
                .child(label),
        )
    }
}
impl Render for ActivityPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.controls.clear();
        let revision = self.revision;
        let painted = self.painted.clone();
        let now = crate::clock::now();
        // Repository scope and the mission controls share the first header row.
        let scope = self.scope_selector(cx);
        let refresh = self.compact("activity-refresh", "Refresh", Action::Refresh, false, cx);
        let mut top = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(scope)
            .child(refresh);
        if self.mission["missionId"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
        {
            let pending = self.pending;
            top = top.child(
                self.compact(
                    "activity-stop-mission",
                    "Stop mission",
                    Action::StopMission,
                    pending,
                    cx,
                )
                .tooltip(|_, cx| {
                    cx.new(|_| icon::Tip("Stop and hold every packet in this mission".into()))
                        .into()
                }),
            );
        }
        // Classic's filter pills: one hairline group, the active pill in accent.
        let accent = tint(marks::ACCENT, 1.);
        let mut pills = hairline(
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .p(px(3.))
                .rounded(px(10.))
                .border_color(theme().border)
                .bg(theme().surface),
        );
        for (filter, label, path) in [
            ("all", "All", marks::ZAP),
            ("commit", "Commits", marks::COMMIT),
            ("pr", "PRs", marks::PULL),
            ("issue", "Issues", marks::ALERT),
            ("ci", "CI", marks::CHECK),
            ("packet", "Packets", marks::ZAP),
        ] {
            let count = self
                .rows
                .iter()
                .filter(|r| filter == "all" || r.kind == filter || filter == "ci" && r.ci.is_some())
                .count();
            let id = format!("activity-filter-{filter}");
            let active = self.filter == filter;
            let selected = self.keyboard.as_ref() == Some(&id);
            let color = if active { accent } else { theme().text_muted };
            pills = pills.child(
                self.control(id, Action::Filter(filter), cx)
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .pt(px(3.))
                    .pb(px(3.))
                    .pl(px(6.))
                    .pr(px(8.))
                    .rounded_full()
                    .text_size(px(11.))
                    .font_weight(FontWeight(350.))
                    .text_color(color)
                    .bg(if active {
                        tint(marks::ACCENT, 0.08)
                    } else if selected {
                        theme().selection
                    } else {
                        CLEAR
                    })
                    .when(!active, |pill| pill.hover(|v| v.bg(theme().hover)))
                    .child(icon::stroke(path, color, 11., 2.))
                    .child(label)
                    .when(count > 0 && filter != "all", |pill| {
                        pill.child(
                            div()
                                .text_size(px(9.5))
                                .font_weight(FontWeight(260.))
                                .text_color(if active { accent } else { theme().text_faint })
                                .child(count.to_string()),
                        )
                    }),
            );
        }
        let header = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .flex_shrink_0()
            .pt(px(10.))
            .px(px(12.))
            .pb(px(8.))
            .border_b_1()
            .border_color(theme().border)
            .child(top)
            .child(div().flex().child(pills));
        let mut list = div()
            .id("activity-list")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col();
        let status = || {
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .py(px(16.))
                .px(px(14.))
                .text_size(px(13.))
                .line_height(relative(1.45))
                .text_color(theme().text_muted)
        };
        // Classic's read-failure block: the errors, how old the saved GitHub
        // state is (GithubReadStatus), and Retry.
        if !self.loading && !self.errors.is_empty() {
            let mut block = status().children(self.errors.clone());
            if self.errors.iter().any(|e| e.starts_with("GitHub")) {
                let saved = match self.remote_updated.map(|t| now.saturating_sub(t)) {
                    None => "No saved state is available.".to_owned(),
                    Some(age) if age < 60 => format!("Showing saved state updated {age}s ago."),
                    Some(age) => format!("Showing saved state updated {}m ago.", age / 60),
                };
                block = block.child(
                    div()
                        .debug_selector(|| "activity-github-status".into())
                        .text_size(px(11.))
                        .font_weight(FontWeight::LIGHT)
                        .line_height(relative(1.35))
                        .text_color(theme().warning)
                        .child(format!("GitHub refresh delayed. {saved}")),
                );
            }
            let retry = self.button("activity-retry", "Retry", Action::Refresh, cx);
            list = list.child(block.child(div().mt(px(8.)).flex().child(retry)));
        }
        if !self.notice.is_empty() {
            list = list.child(status().child(self.notice.clone()));
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
        let quiet = || {
            div()
                .py(px(32.))
                .px(px(14.))
                .text_center()
                .text_size(px(13.))
                .font_weight(FontWeight::LIGHT)
                .line_height(relative(1.45))
                .text_color(theme().text_faint)
        };
        if self.loading {
            list = list.child(
                quiet()
                    .debug_selector(|| "activity-loading".into())
                    .child("Loading activity…"),
            );
        } else if rows.is_empty() && self.errors.is_empty() {
            let connected = self.scope == "*"
                || self
                    .repos
                    .iter()
                    .any(|r| r.local_path == self.scope && r.slug().is_some());
            // Classic names the repository and the filter.
            let label = self
                .repos
                .iter()
                .find(|repo| repo.local_path == self.scope)
                .map(|repo| repo_meta(repo).0)
                .or_else(|| {
                    self.scope
                        .rsplit(['/', '\\'])
                        .find(|s| !s.is_empty())
                        .map(String::from)
                })
                .unwrap_or_else(|| "this folder".into());
            let kind = if self.filter == "all" {
                String::new()
            } else {
                format!("{} ", self.filter)
            };
            let message = if self.scope.is_empty() {
                "Choose a folder to see activity here.".to_owned()
            } else if !connected && matches!(self.filter, "pr" | "issue" | "ci") {
                "Connect GitHub to see pull requests, issues, and CI runs.".to_owned()
            } else if !connected && matches!(self.filter, "all" | "commit") {
                format!("No commits yet in {label}.")
            } else if self.scope == "*" {
                format!("No {kind}activity yet.")
            } else {
                format!("No {kind}activity yet for {label}.")
            };
            list = list.child(
                quiet()
                    .debug_selector(|| "activity-empty".into())
                    .child(message),
            );
        }
        let mut day = String::new();
        for row in rows {
            let heading = marks::day(&row.date, now);
            if heading != day {
                day = heading;
                list = list.child(
                    div()
                        .pt(px(8.))
                        .px(px(14.))
                        .pb(px(4.))
                        .text_size(px(9.))
                        .font_weight(FontWeight::LIGHT)
                        .text_color(theme().text_faint)
                        .child(day.to_uppercase()),
                );
            }
            let expanded = self.expanded.as_ref() == Some(&row.key());
            let selected = self.keyboard.as_ref() == Some(&row.selector());
            let packet = row.kind == "packet";
            // Packet rows use the input fill when open, feed rows the accent wash.
            let (open, hover) = if packet {
                (theme().surface_raised, theme().hover)
            } else {
                (tint(marks::ACCENT, 0.08), tint(marks::ACCENT, 0.08))
            };
            // Classic's `nowrap` folds a commit body onto the subject's line.
            let title = row.title.split_whitespace().collect::<Vec<_>>().join(" ");
            let title = match row.kind {
                "commit" if !row.id.is_empty() => {
                    format!("{title} · {}", row.id.get(..7).unwrap_or(&row.id))
                }
                _ => title,
            };
            let destination = row.clone();
            let summary = self
                .control(row.selector(), Action::Expand(row.clone()), cx)
                // A double click also takes the row to its destination.
                .on_click(cx.listener(move |this, event: &gpui::ClickEvent, _, cx| {
                    if event.click_count() >= 2 {
                        this.act(Action::Open(destination.clone()), cx);
                    }
                }))
                .flex()
                .items_start()
                .gap(px(8.))
                .w_full()
                .px(px(14.))
                .py(px(7.))
                .bg(if selected {
                    theme().selection
                } else if expanded {
                    open
                } else {
                    CLEAR
                })
                .when(!expanded, |row| row.hover(move |v| v.bg(hover)))
                .child(
                    div()
                        .w(px(10.))
                        .h(px(20.))
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon::fill(
                            if expanded {
                                marks::CHEVRON_OPEN
                            } else {
                                marks::CHEVRON
                            },
                            theme().text_faint,
                            7.,
                        )),
                )
                .child(Self::dot(&row))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .text_size(px(13.5))
                                .font_weight(FontWeight::LIGHT)
                                .line_height(relative(1.25))
                                .text_color(theme().text)
                                .min_w_0()
                                // As the rail: truncation recomputes once flex sets the width.
                                .whitespace_normal()
                                .line_clamp(if packet { 2 } else { 1 })
                                .text_ellipsis()
                                .child(title),
                        )
                        .child(Self::subline(&row, now)),
                )
                .children(Self::badge(&row));
            list = list.child(summary);
            if expanded {
                list = list.child(
                    div()
                        .pt(px(6.))
                        .pr(px(14.))
                        .pb(px(10.))
                        .pl(px(52.))
                        .border_b_1()
                        .border_color(theme().border)
                        .child(self.detail_view(&row, cx)),
                );
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
            .font_weight(FontWeight::LIGHT)
            .child(header)
            .child(list)
            .child(canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision)).size(px(1.)))
    }
}
