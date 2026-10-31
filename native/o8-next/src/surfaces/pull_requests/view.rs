use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, IntoElement, Render, canvas, div, prelude::*, px};

pub(super) const ICON_PR: &str = "M18 15a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M6 3a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M13 6h3a2 2 0 0 1 2 2v7 M6 9v12";
pub(super) const ICON_MERGED: &str = "M18 15a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M6 3a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M6 21V9a9 9 0 0 0 9 9";
const ICON_DRAFT: &str = "M18 15a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M6 3a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z M18 6V5 M18 11v-1 M6 9v12";
const RING: &str = "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20Z";

/// PrLabel: size labels take their size's tone, others the hover fill.
fn label_chip(label: &str) -> impl IntoElement {
    let size = label
        .to_ascii_lowercase()
        .strip_prefix("size/")
        .map(str::to_ascii_uppercase);
    let tone = match size.as_deref() {
        Some("XS" | "S") => Some(theme().success),
        Some("M") => Some(theme().warning),
        Some("L") => Some(crate::theme::brand_orange()),
        Some("XL" | "XXL") => Some(theme().danger),
        _ => None,
    };
    div()
        .rounded(px(5.))
        .px(px(6.))
        .py(px(1.))
        .text_size(px(11.))
        .bg(tone.map_or(theme().hover, |t| gpui::Rgba { a: 0.12, ..t }))
        .text_color(tone.unwrap_or(theme().text_secondary))
        .child(label.to_owned())
}

fn group_header(label: &'static str, glyph: &'static str, count: usize) -> impl IntoElement {
    div()
        .mt(px(12.))
        .mb(px(4.))
        .mx(px(12.))
        .flex()
        .items_center()
        .gap(px(8.))
        .text_size(px(12.))
        .font_weight(gpui::FontWeight::MEDIUM)
        .text_color(theme().text_muted)
        .child(crate::icon::stroke(glyph, theme().text_muted, 14., 1.8))
        .child(label)
        .child(count.to_string())
        .child(div().h(px(1.)).flex_1().ml(px(4.)).bg(theme().border))
}

impl PullRequests {
    /// The desktop PullRequestRow: state icon, numbered title with checks, author and
    /// repository underneath, diff totals and age on the right.
    fn pr_row(&self, p: &Value, n: u64, now: u64, cx: &mut Context<Self>) -> AnyElement {
        let draft = p["draft"] == true;
        let state = string(p, "state");
        let (icon, color) = if state == "merged" {
            (ICON_MERGED, theme().accent)
        } else if draft {
            (ICON_DRAFT, theme().text_muted)
        } else if state == "open" {
            (ICON_PR, theme().success)
        } else {
            (ICON_PR, theme().text_muted)
        };
        let checks = match string(p, "checks") {
            "success" => Some((format!("{RING} M9 12l2 2 4-4"), theme().success)),
            "failure" => Some((format!("{RING} M15 9l-6 6 M9 9l6 6"), theme().danger)),
            "" => None,
            _ => Some((format!("{RING} M12 6v6l4 2"), theme().text_muted)),
        };
        let totals = match (p["additions"].as_u64(), p["deletions"].as_u64()) {
            (Some(added), Some(removed)) => div()
                .flex()
                .gap(px(4.))
                .child(div().text_color(theme().success).child(format!("+{added}")))
                .child(div().text_color(theme().danger).child(format!("−{removed}"))),
            _ => div().text_color(theme().text_muted).child("—"),
        };
        let selected = self.selected == Some(n);
        let labels: Vec<String> = array(p, "labels")
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        div()
            .id(gpui::SharedString::from(format!("pr-row-{n}")))
            .debug_selector(move || format!("pr-row-{n}"))
            .flex()
            .items_start()
            .gap(px(12.))
            .px(px(12.))
            .py(px(15.))
            .min_h(px(72.))
            .rounded(px(12.))
            .cursor_pointer()
            .when(selected, |row| row.bg(theme().hover))
            .hover(|row| row.bg(theme().hover))
            .child(div().mt(px(2.)).child(crate::icon::stroke(icon, color, 18., 1.8)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_size(px(14.))
                            .child(
                                // Wrapping text re-measures at the final flex width, so the
                                // one-line clamp ends in an ellipsis instead of clipping.
                                div()
                                    .min_w_0()
                                    .whitespace_normal()
                                    .line_clamp(1)
                                    .text_ellipsis()
                                    .child(format!("#{n} {}", string(p, "title"))),
                            )
                            .when_some(checks, |line, (path, color)| {
                                line.child(crate::icon::stroke(&path, color, 14., 1.8))
                            }),
                    )
                    .child(
                        div()
                            .mt(px(5.))
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(7.))
                            .text_size(px(12.))
                            .text_color(theme().text_secondary)
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(5.))
                                    .child(crate::icon::stroke(
                                        controls::USER,
                                        theme().text_secondary,
                                        18.,
                                        1.6,
                                    ))
                                    .child(string(p, "author").to_owned()),
                            )
                            .child(
                                div()
                                    .text_color(theme().text_muted)
                                    .child(string(&self.page, "repo").to_owned()),
                            )
                            .when(draft, |line| {
                                line.child(div().text_color(theme().text_muted).child("Draft"))
                            })
                            .children(labels.iter().take(3).map(|l| label_chip(l)))
                            .when(labels.len() > 3, |line| {
                                line.child(
                                    div()
                                        .text_color(theme().text_muted)
                                        .child(format!("+{}", labels.len() - 3)),
                                )
                            }),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_end()
                    .gap(px(5.))
                    .min_w(px(64.))
                    .pt(px(2.))
                    .flex_shrink_0()
                    .text_size(px(12.))
                    .child(totals)
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child(crate::clock::age(
                                crate::clock::timestamp(string(p, "updatedAt")),
                                now,
                            )),
                    ),
            )
            .on_click(cx.listener(move |s, _, _, cx| s.pick(n, cx)))
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
        // The desktop list's states: error with Retry, no origin, and empty.
        let note = |text: String| {
            div()
                .mx(px(12.))
                .my(px(20.))
                .text_size(px(13.))
                .text_color(theme().text_secondary)
                .child(text)
        };
        if !self.error.is_empty() {
            let loading = self.loading;
            list = list.child(
                div()
                    .mt(px(8.))
                    .mx(px(12.))
                    .mb(px(16.))
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap(px(8.))
                    .text_size(px(13.))
                    .child(self.error.clone())
                    .child(
                        controls::control("pr-retry".into())
                            .opacity(if loading { 0.5 } else { 1. })
                            .when(!loading, |c| c.cursor_pointer().hover(|c| c.bg(theme().hover)))
                            .child("Retry")
                            .on_click(cx.listener(move |s, _, _, cx| {
                                if !loading {
                                    s.load(false, cx)
                                }
                            })),
                    ),
            );
        }
        if self.page["unavailable"] == true {
            list = list.child(note(
                "This repository needs a GitHub origin to show pull requests.".into(),
            ));
        } else if !self.loading && self.page["prs"].is_array() && self.error.is_empty() && visible.is_empty() {
            list = list.child(note(
                if self.search.read(cx).text.is_empty()
                    && self.filters.values().all(String::is_empty)
                    && self.scope == "all"
                {
                    if self.state == "all" {
                        "No pull requests.".into()
                    } else {
                        format!("No {} pull requests.", self.state)
                    }
                } else {
                    "No pull requests shown match these filters.".into()
                },
            ));
        }
        let now = crate::clock::now();
        let loaded = self.page["prs"].is_array() && self.page["unavailable"] != true;
        if loaded && self.layout == "stacks" {
            for p in &visible {
                let Some(n) = p["number"].as_u64() else {
                    continue;
                };
                list = list
                    .child(
                        div()
                            .pt(px(8.))
                            .px(px(12.))
                            .text_size(px(11.))
                            .text_color(theme().text_muted)
                            .child(format!(
                                "{} → {}",
                                string(p, "headRefName"),
                                string(p, "baseRefName")
                            )),
                    )
                    .child(self.pr_row(p, n, now, cx));
            }
        } else if loaded {
            // The desktop's author groups: the viewer's PRs, then everyone else's.
            let (mine, others): (Vec<_>, Vec<_>) = visible
                .iter()
                .partition(|p| string(p, "author").to_lowercase() == self.viewer);
            for (label, glyph, prs) in [
                ("Authored", controls::PENCIL, mine),
                ("Others", controls::USER, others),
            ] {
                if prs.is_empty() && self.scope != "all" {
                    continue;
                }
                list = list.child(group_header(label, glyph, prs.len()));
                if prs.is_empty() && label == "Others" {
                    list = list.child(
                        div()
                            .px(px(12.))
                            .py(px(10.))
                            .text_size(px(12.))
                            .text_color(theme().text_muted)
                            .child("No other pull requests shown."),
                    );
                }
                for p in prs {
                    if let Some(n) = p["number"].as_u64() {
                        list = list.child(self.pr_row(p, n, now, cx));
                    }
                }
            }
        }
        if self.page["nextPage"].is_number() {
            let loading = self.loading;
            list = list.child(
                div().mt(px(16.)).flex().justify_center().child(
                    controls::control("pr-more".into())
                        .when(!loading, |c| c.cursor_pointer().hover(|c| c.bg(theme().hover)))
                        .child(if loading { "Loading…" } else { "Load more pull requests" })
                        .on_click(cx.listener(move |s, _, _, cx| {
                            if !loading {
                                s.load(true, cx)
                            }
                        })),
                ),
            );
        }
        let muted = |text: &'static str| {
            div()
                .mt(px(6.))
                .text_size(px(11.))
                .text_color(theme().text_muted)
                .child(text)
        };
        let repo = string(&self.page, "repo");
        let status = if self.loading {
            if self.page["prs"].is_array() {
                "Refreshing pull requests…".to_owned()
            } else {
                "Reading pull requests from GitHub…".to_owned()
            }
        } else if self.page["prs"].is_array() {
            let order = match self.sort.as_str() {
                "oldest" => "Oldest update first",
                "newest" => "Newest created first",
                _ => "Recently updated first",
            };
            format!("{count} shown · {order}")
        } else {
            "Pull requests for this workspace".to_owned()
        };
        // The desktop RepositoryPullRequests header: title and repository,
        // the control row, then the status line and its notes.
        let header = div()
            .flex_shrink_0()
            .pt(px(20.))
            .px(px(24.))
            .pb(px(14.))
            .child(
                div()
                    .mb(px(18.))
                    .flex()
                    .flex_wrap()
                    .items_baseline()
                    .gap(px(12.))
                    .child(
                        div()
                            .text_size(px(18.))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child("Pull requests"),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(theme().text_secondary)
                            .child(if repo.is_empty() {
                                "Current repository".to_owned()
                            } else {
                                repo.to_owned()
                            }),
                    ),
            )
            .child(self.controls(cx))
            .child(
                div()
                    .debug_selector(|| "pr-status".into())
                    .mt(px(12.))
                    .text_size(px(12.))
                    .text_color(theme().text_muted)
                    .child(status),
            )
            .when(self.page["nextPage"].is_number(), |h| {
                h.child(muted("Filters apply to the PRs shown. Load more to include older PRs."))
            })
            .when(self.page["statsUnavailable"] == true, |h| {
                h.child(muted(
                    "Some diff totals or review requests are unavailable. Refresh to try again.",
                ))
            })
            .when(self.layout == "stacks", |h| {
                h.child(muted(
                    "Dependencies follow branches in the loaded PRs. This view does not change or merge them.",
                ))
            });
        let split = !self.hosted && self.contextual.is_none();
        let list_column = div()
            .when(split, |c| c.w(px(440.)).flex_none())
            .when(!split, |c| c.flex_1())
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .child(header)
            .child(list.px(px(12.)).pb(px(20.)));
        // In the shell a picked pull request opens in the right panel, as
        // classic's o8:open-pr does; the panel's own view shows only it.
        let detail = split.then(|| self.detail_view(cx));
        div()
            .size_full()
            .flex()
            .bg(theme().surface)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .font_weight(gpui::FontWeight::LIGHT)
            .text_size(px(12.))
            .track_focus(&self.focus)
            .map(|root| {
                if self.contextual.is_some() {
                    root.child(self.detail_view(cx))
                } else {
                    root.child(list_column).children(detail)
                }
            })
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

#[path = "controls.rs"]
mod controls;
#[path = "detail.rs"]
mod detail;
