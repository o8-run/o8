use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, ClickEvent, IntoElement, Render, canvas, div, prelude::*, px};

impl PullRequests {
    fn button(
        &self,
        id: &str,
        label: &str,
        enabled: bool,
        handler: impl Fn(&mut Self, &ClickEvent, &mut Window, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let selector = id.to_owned();
        div()
            .id(gpui::SharedString::from(id.to_owned()))
            .debug_selector(move || selector.clone())
            .px(px(8.))
            .py(px(5.))
            .rounded(px(7.))
            .text_size(px(11.))
            .font_weight(gpui::FontWeight::LIGHT)
            .bg(theme().surface_raised)
            .opacity(if enabled { 1. } else { 0.4 })
            .when(enabled, |b| {
                b.cursor_pointer().hover(|b| b.bg(theme().hover))
            })
            .child(label.to_owned())
            .on_click(cx.listener(move |s, e, w, cx| {
                if enabled {
                    handler(s, e, w, cx);
                }
            }))
            .into_any_element()
    }
    fn list_controls(&self, cx: &mut Context<Self>) -> AnyElement {
        let mut controls = div().flex().flex_wrap().gap(px(5.));
        for (id, label, values) in [
            (
                "state",
                self.state.as_str(),
                vec!["open", "closed", "merged", "all"],
            ),
            (
                "sort",
                self.sort.as_str(),
                vec!["updated", "oldest", "newest"],
            ),
            (
                "scope",
                self.scope.as_str(),
                vec!["all", "authored", "reviewing", "others"],
            ),
            ("layout", self.layout.as_str(), vec!["authors", "stacks"]),
        ] {
            let index = values.iter().position(|v| *v == label).unwrap_or(0);
            let next = values[(index + 1) % values.len()].to_owned();
            controls = controls.child(self.button(
                &format!("pr-{id}"),
                &format!("{id}: {label}"),
                !self.loading && (id != "scope" || !self.viewer.is_empty()),
                move |s, _, _, cx| {
                    match id {
                        "state" => s.state = next.clone(),
                        "sort" => s.sort = next.clone(),
                        "scope" => s.scope = next.clone(),
                        _ => s.layout = next.clone(),
                    }
                    if ["state", "sort"].contains(&id) {
                        s.rows.clear();
                        s.load(false, cx);
                    } else {
                        s.changed(cx);
                    }
                },
                cx,
            ));
        }
        for (key, label) in [
            ("author", "Author"),
            ("label", "Label"),
            ("baseRefName", "Base"),
            ("draft", "Draft"),
            ("checks", "Checks"),
        ] {
            let mut values = vec![String::new()];
            if key == "draft" {
                values.extend(["draft".into(), "ready".into()]);
            } else if key == "checks" {
                values.extend([
                    "success".into(),
                    "failure".into(),
                    "pending".into(),
                    "unknown".into(),
                ]);
            } else {
                for p in &self.rows {
                    if key == "label" {
                        values.extend(
                            array(p, "labels")
                                .iter()
                                .filter_map(|v| v.as_str().map(str::to_owned)),
                        );
                    } else {
                        values.push(string(p, key).into());
                    }
                }
                values.sort();
                values.dedup();
            }
            let current = self.filters.get(key).cloned().unwrap_or_default();
            let index = values.iter().position(|v| v == &current).unwrap_or(0);
            let next = values[(index + 1) % values.len()].clone();
            controls = controls.child(self.button(
                &format!("pr-filter-{key}"),
                &format!(
                    "{label}: {}",
                    if current.is_empty() { "all" } else { &current }
                ),
                true,
                move |s, _, _, cx| {
                    s.filters.insert(key, next.clone());
                    s.changed(cx);
                },
                cx,
            ));
        }
        controls
            .child(self.button(
                "pr-refresh",
                "Refresh",
                !self.loading,
                |s, _, _, cx| {
                    s.load(false, cx);
                    if let Some(n) = s.selected {
                        s.select(n, cx);
                    }
                },
                cx,
            ))
            .into_any_element()
    }
}
impl Render for PullRequests {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let visible = self.visible(cx);
        let count = visible.len();
        let painted = self.painted.clone();
        let painted_at = self.painted_at.clone();
        let ready_painted_at = self.ready_painted_at.clone();
        let ready = !self.loading && self.page["prs"].is_array();
        let revision = self.revision;
        let mut list = div()
            .id("pr-list-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(4.));
        if self.page["unavailable"] == true {
            list = list.child("This repository needs a GitHub origin to show pull requests.");
        }
        if !self.error.is_empty() {
            list = list
                .child(div().text_color(theme().danger).child(self.error.clone()))
                .child(self.button(
                    "pr-retry",
                    "Retry",
                    !self.loading,
                    |s, _, _, cx| s.load(false, cx),
                    cx,
                ));
        }
        if !self.loading && !self.page.is_null() && visible.is_empty() {
            list = list.child(
                if self.search.read(cx).text.is_empty()
                    && self.filters.values().all(String::is_empty)
                    && self.scope == "all"
                {
                    format!("No {} pull requests.", self.state)
                } else {
                    "No pull requests shown match these filters.".into()
                },
            );
        }
        for p in visible {
            let Some(n) = p["number"].as_u64() else {
                continue;
            };
            let meta = if self.layout == "stacks" {
                format!(
                    "{} → {}",
                    string(&p, "headRefName"),
                    string(&p, "baseRefName")
                )
            } else {
                format!(
                    "{} · {}",
                    if string(&p, "author").to_lowercase() == self.viewer {
                        "Authored"
                    } else {
                        "Others"
                    },
                    string(&p, "author")
                )
            };
            list = list.child(self.button(
                &format!("pr-row-{n}"),
                &format!(
                    "#{n} {}\n{meta} · {} · {} · +{} −{}",
                    string(&p, "title"),
                    if p["draft"] == true {
                        "draft"
                    } else {
                        string(&p, "state")
                    },
                    string(&p, "checks"),
                    p["additions"],
                    p["deletions"]
                ),
                true,
                move |s, _, _, cx| s.select(n, cx),
                cx,
            ));
        }
        if self.page["nextPage"].is_number() {
            list = list.child(self.button(
                "pr-more",
                "Load more pull requests",
                !self.loading,
                |s, _, _, cx| s.load(true, cx),
                cx,
            ));
        }
        let mut left = div()
            .w(px(340.))
            .min_h_0()
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(12.))
            .child("Pull requests")
            .child(string(&self.page, "repo").to_owned())
            .child(
                div()
                    .h(px(40.))
                    .bg(theme().surface_raised)
                    .child(self.search.clone()),
            )
            .child(self.list_controls(cx))
            .child(if self.loading {
                "Reading pull requests…".into()
            } else {
                format!("{count} shown")
            });
        if self.page["nextPage"].is_number() {
            left = left.child("Filters apply to loaded PRs. Load more to include older PRs.");
        }
        if self.page["statsUnavailable"] == true {
            left = left.child(
                "Some diff totals or review requests are unavailable. Refresh to try again.",
            );
        }
        div()
            .size_full()
            .flex()
            .bg(theme().surface)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .font_weight(gpui::FontWeight::LIGHT)
            .text_size(px(12.))
            .track_focus(&self.focus)
            .key_context("PullRequests List")
            .child(left.child(list))
            .child(self.detail_view(cx))
            .child(
                canvas(
                    |_, _, _| (),
                    move |_, _, _, _| {
                        let now = Instant::now();
                        if ready && ready_painted_at.get().is_none() {
                            ready_painted_at.set(Some(now));
                        }
                        if painted.get() != revision {
                            painted_at.set(Some(now));
                        }
                        painted.set(revision);
                    },
                )
                .absolute()
                .size_full(),
            )
    }
}

#[path = "detail.rs"]
mod detail;
