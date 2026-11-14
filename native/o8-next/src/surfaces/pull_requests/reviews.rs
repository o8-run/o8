use super::tabs::{age, markdown, muted};
use super::*;
use std::collections::BTreeMap;

impl PullRequests {
    pub(super) fn reviews_tab(&self) -> AnyElement {
        let d = &self.detail;
        // Namespaced provider IDs keep row identity stable across refresh/reordering.
        let mut entries = BTreeMap::new();
        for (kind, key) in [
            ("issue", "issueComments"),
            ("inline", "reviewComments"),
            ("submitted", "submittedReviews"),
        ] {
            for comment in array(d, key) {
                entries.insert(format!("{kind}-{}", comment["id"]), (kind, comment));
            }
        }
        let mut comments: Vec<_> = entries.into_iter().collect();
        let at = |c: &Value| {
            ["submittedAt", "createdAt", "created_at"]
                .into_iter()
                .map(|key| string(c, key))
                .find(|value| !value.is_empty())
                .unwrap_or("")
                .to_owned()
        };
        comments
            .sort_by_key(|(id, (_, c))| (crate::clock::timestamp(&at(c)).unwrap_or(0), id.clone()));
        let decision = match string(d, "reviewDecision").to_uppercase().as_str() {
            "APPROVED" => Some(("Approved", theme().success)),
            "CHANGES_REQUESTED" => Some(("Changes Requested", theme().danger)),
            "COMMENTED" => Some(("Commented", theme().text_muted)),
            "" => None,
            _ => Some(("Reviewed", theme().text_muted)),
        };
        div()
            .id("pr-review-discussion")
            .tab_group()
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
                        .child(
                            div()
                                .text_size(px(10.))
                                .text_color(theme().text_faint)
                                .child("Latest review:"),
                        )
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
                c.child(div().px(px(14.)).py(px(8.)).child(muted(
                    "Discussion is incomplete. Open GitHub for the full conversation.",
                )))
            })
            .when(
                comments.is_empty() && d["discussionIncomplete"] != true,
                |c| c.child(div().p(px(16.)).child(muted("No discussion reported."))),
            )
            .children(comments.into_iter().map(|(id, (kind, comment))| {
                let author = match string(&comment, "author") {
                    "" => string(&comment, "user"),
                    author => author,
                };
                let at = at(&comment);
                let body = string(&comment, "body");
                let path = match comment["line"].as_u64() {
                    Some(line) => format!("{}:{line}", string(&comment, "path")),
                    None => string(&comment, "path").to_owned(),
                };
                let submitted = kind == "submitted";
                let sha = string(&comment, "reviewedHeadSha");
                let state = match string(&comment, "state") {
                    "APPROVED" => "Approved",
                    "CHANGES_REQUESTED" => "Changes requested",
                    "COMMENTED" => "Commented",
                    "DISMISSED" => "Dismissed",
                    _ => "Review submitted",
                };
                let revision = if sha.is_empty() {
                    "Reviewed revision unavailable".to_owned()
                } else {
                    format!(
                        "Reviewed {} · {}",
                        sha.chars().take(8).collect::<String>(),
                        if string(d, "headSha").is_empty() {
                            "Current revision unavailable"
                        } else if sha == string(d, "headSha") {
                            "Current revision"
                        } else {
                            "Different revision"
                        }
                    )
                };
                let url = string(&comment, "url").to_owned();
                let key_url = url.clone();
                let row_id = format!("pr-discussion-{id}");
                div()
                    .id(gpui::SharedString::from(row_id.clone()))
                    .debug_selector(move || row_id.clone())
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
                            .child(
                                author
                                    .chars()
                                    .next()
                                    .map(|c| c.to_uppercase().to_string())
                                    .unwrap_or("?".into()),
                            ),
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
                                    .child(
                                        div()
                                            .text_size(px(13.5))
                                            .font_weight(gpui::FontWeight::LIGHT)
                                            .child(author.to_owned()),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(9.5))
                                            .text_color(theme().text_faint)
                                            .child(age(&at)),
                                    )
                                    .when(submitted, |h| {
                                        h.child(
                                            div()
                                                .text_size(px(11.))
                                                .text_color(theme().text_muted)
                                                .child(state),
                                        )
                                    })
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
                            .when(submitted, |row| {
                                row.child(
                                    div()
                                        .flex()
                                        .flex_wrap()
                                        .items_center()
                                        .gap(px(8.))
                                        .child(
                                            div()
                                                .text_size(px(9.5))
                                                .text_color(theme().text_muted)
                                                .child(revision),
                                        )
                                        .when(url.starts_with("https://"), |meta| {
                                            meta.child(
                                                div()
                                                    .id(gpui::SharedString::from(format!(
                                                        "pr-review-source-{id}"
                                                    )))
                                                    .debug_selector({
                                                        let id = id.clone();
                                                        move || format!("pr-review-source-{id}")
                                                    })
                                                    .tab_index(0)
                                                    .min_h(px(26.))
                                                    .px(px(8.))
                                                    .rounded(px(7.))
                                                    .border_1()
                                                    .border_color(gpui::Rgba {
                                                        a: 0.,
                                                        ..theme().border
                                                    })
                                                    .flex()
                                                    .items_center()
                                                    .text_size(px(11.))
                                                    .text_color(theme().text_secondary)
                                                    .cursor_pointer()
                                                    .hover(|b| b.bg(theme().hover))
                                                    .focus(|b| b.border_color(theme().text))
                                                    .child("Open review")
                                                    .on_click(move |_, _, cx| crate::external_open::url(cx, &url))
                                                    .on_key_down(
                                                        move |event: &gpui::KeyDownEvent, _, cx| {
                                                            if event.keystroke.key == "enter"
                                                                || event.keystroke.key == "space"
                                                            {
                                                                crate::external_open::url(cx, &key_url);
                                                                cx.stop_propagation();
                                                            }
                                                        },
                                                    ),
                                            )
                                        }),
                                )
                            })
                            .child(if body.trim().is_empty() {
                                muted("No comment text.").into_any_element()
                            } else {
                                markdown(&format!("pr-review-{id}"), body)
                            }),
                    )
            }))
            .into_any_element()
    }
}
