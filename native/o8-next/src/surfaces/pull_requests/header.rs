//! The PR viewer's header and diff, ported from the desktop panel
//! (src/components/desktop/pr-panel/PrPanelHeader.tsx, PrPanelTitle.tsx):
//! repository and number, state, title, author, base ← head, size and checks.
use super::*;

/// Lucide git-pull-request.
pub(crate) const PR_ICON: &str =
    "M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M13 6h3a2 2 0 0 1 2 2v7 M6 9v12";

/// "Merged", "Closed", "Draft" or "Open", as the desktop header names them.
pub(crate) fn pr_state(detail: &Value) -> &'static str {
    if !string(detail, "mergedAt").is_empty() || string(detail, "state").eq_ignore_ascii_case("merged") {
        "Merged"
    } else if string(detail, "state").eq_ignore_ascii_case("closed") {
        "Closed"
    } else if detail["draft"] == true {
        "Draft"
    } else {
        "Open"
    }
}
pub(crate) fn state_color(state: &str) -> gpui::Rgba {
    match state {
        "Open" => theme().success,
        "Closed" => theme().danger,
        "Draft" => theme().text_muted,
        _ => theme().accent,
    }
}
/// Passed, failing and running counts across the PR's checks.
pub(crate) fn check_counts(detail: &Value) -> (usize, usize, usize) {
    let checks = array(detail, "statusCheckRollup");
    let count = |bucket| checks.iter().filter(|c| check_bucket(c) == bucket).count();
    (count("passed"), count("failing"), count("running"))
}

impl PullRequests {
    pub(super) fn header(&self, number: u64, close: AnyElement, _cx: &mut Context<Self>) -> AnyElement {
        let d = &self.detail;
        let state = pr_state(d);
        let color = state_color(state);
        let repo = match string(d, "resolvedRepo") {
            "" => string(&self.page, "repo").to_owned(),
            repo => repo.to_owned(),
        };
        let url = string(d, "url").to_owned();
        let link = div()
            .id("pr-header-link")
            .debug_selector(|| "pr-header-link".into())
            .flex()
            .items_center()
            .gap(px(6.))
            .min_w_0()
            .text_size(px(12.))
            .text_color(theme().text_muted)
            .cursor_pointer()
            .hover(|s| s.text_color(theme().text_secondary))
            .child(div().min_w_0().text_ellipsis().child(if repo.is_empty() {
                "Pull request".to_owned()
            } else {
                repo
            }))
            .child(div().flex_shrink_0().text_color(color).child(format!("#{number}")))
            .child("↗")
            .on_click(move |_, _, cx| {
                if url.starts_with("https://") {
                    cx.open_url(&url);
                }
            });
        let loaded = !d.is_null();
        let mut top = div().flex().items_center().gap(px(12.)).min_w_0().child(link);
        if loaded {
            top = top.child(
                div()
                    .debug_selector(|| "pr-header-state".into())
                    .flex()
                    .flex_shrink_0()
                    .items_center()
                    .gap(px(5.))
                    .text_size(px(10.5))
                    .text_color(color)
                    .child(crate::icon::stroke(PR_ICON, color, 12., 1.7))
                    .child(state),
            );
        }
        let mut header = div()
            .debug_selector(|| "pr-header".into())
            .flex()
            .flex_col()
            .flex_shrink_0()
            .gap(px(10.))
            .pb(px(12.))
            .border_b_1()
            .border_color(theme().border)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(10.))
                    .child(top)
                    .child(close),
            );
        if !loaded {
            return header.into_any_element();
        }
        header = header.child(
            div()
                .debug_selector(|| "pr-header-title".into())
                .text_size(px(15.))
                .line_height(px(21.))
                .text_color(theme().text)
                .child(crate::text::sanitize(string(d, "title"))),
        );
        let author = string(d, "author");
        if !author.is_empty() {
            header = header.child(
                div()
                    .text_size(px(12.))
                    .text_color(theme().text_secondary)
                    .child(crate::text::sanitize(author)),
            );
        }
        let (passed, failing, running) = check_counts(d);
        let mut checks = div()
            .debug_selector(|| "pr-header-checks".into())
            .flex()
            .items_center()
            .gap(px(8.));
        if passed + failing + running == 0 {
            checks = checks.child(div().text_color(theme().text_muted).child(
                if d["checksUnavailable"] == true { "Checks unavailable" } else { "No checks" },
            ));
        }
        for (n, label, color) in [
            (failing, "failing", theme().danger),
            (running, "running", theme().warning),
            (passed, "passed", theme().success),
        ] {
            if n > 0 {
                checks = checks.child(div().text_color(color).child(format!("{n} {label}")));
            }
        }
        let files = d["changedFiles"].as_u64().unwrap_or(0);
        header
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(px(10.))
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child(
                        div()
                            .debug_selector(|| "pr-header-branches".into())
                            .font_family(theme().font_mono)
                            .min_w_0()
                            .text_ellipsis()
                            .child(format!(
                                "{} ← {}",
                                string(d, "baseRefName"),
                                string(d, "headRefName")
                            )),
                    )
                    .child(
                        div()
                            .debug_selector(|| "pr-header-stats".into())
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(format!("{files} file{}", if files == 1 { "" } else { "s" }))
                            .child(div().text_color(theme().success).child(format!("+{}", d["additions"].as_u64().unwrap_or(0))))
                            .child(div().text_color(theme().danger).child(format!("−{}", d["deletions"].as_u64().unwrap_or(0))))
                            .child(checks),
                    ),
            )
            .into_any_element()
    }
}

/// One changed file: its path and counts, then the patch with added and
/// removed lines tinted. Long patches stop at a line budget.
pub(crate) fn file_diff(i: usize, f: &Value) -> AnyElement {
    const MAX_LINES: usize = 400;
    let mut lines = div()
        .flex()
        .flex_col()
        .font_family(theme().font_mono)
        .text_size(px(11.))
        .line_height(px(16.))
        .bg(theme().code_background)
        .rounded(px(6.))
        .py(px(4.));
    match f["patch"].as_str() {
        Some(patch) => {
            let all: Vec<&str> = patch.lines().collect();
            for line in all.iter().take(MAX_LINES) {
                let (fg, bg) = if line.starts_with("@@") {
                    (theme().text_muted, None)
                } else if line.starts_with('+') {
                    (theme().text, Some(theme().success_surface))
                } else if line.starts_with('-') {
                    (theme().text, Some(theme().danger_surface))
                } else {
                    (theme().text_secondary, None)
                };
                // Tabs would misalign the monospace grid.
                let mut row = div()
                    .px(px(8.))
                    .text_color(fg)
                    .whitespace_nowrap()
                    .child(crate::text::sanitize(&line.replace('\t', "    ")));
                if let Some(bg) = bg {
                    row = row.bg(bg);
                }
                lines = lines.child(row);
            }
            if all.len() > MAX_LINES {
                lines = lines.child(div().px(px(8.)).text_color(theme().text_muted).child(format!(
                    "{} more lines. Open GitHub for the full file.",
                    all.len() - MAX_LINES
                )));
            }
        }
        None => {
            lines = lines.child(
                div()
                    .px(px(8.))
                    .text_color(theme().text_muted)
                    .child("Patch unavailable. Open GitHub to inspect this file."),
            )
        }
    }
    div()
        .id(("pr-file", i))
        .debug_selector(move || format!("pr-file-{i}"))
        .flex()
        .flex_col()
        .flex_shrink_0()
        .gap(px(4.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .text_size(px(12.))
                .child(
                    div()
                        .min_w_0()
                        .text_ellipsis()
                        .font_family(theme().font_mono)
                        .child(crate::text::sanitize(string(f, "path"))),
                )
                .child(div().text_color(theme().text_muted).child(string(f, "status").to_owned()))
                .child(div().text_color(theme().success).child(format!("+{}", f["additions"].as_u64().unwrap_or(0))))
                .child(div().text_color(theme().danger).child(format!("−{}", f["deletions"].as_u64().unwrap_or(0)))),
        )
        .child(lines)
        .into_any_element()
}
