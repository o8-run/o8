use super::*;
#[path = "pr_status.rs"]
mod pr_status;
use pr_status::PrStatus;

/// Height of the pill row; the file list opens flush above it so the pointer
/// can move from the pill into the list without closing it.
const PILL_HEIGHT: f32 = 26.;
/// The room the transcript keeps under its last row while the pill floats:
/// the pill, its 8 px lift and the same again above it.
pub(crate) const PILL_INSET: f32 = PILL_HEIGHT + 16.;

/// The workspace's uncommitted changes above the composer: one pill with the
/// totals, a hover list with each file's counts, and a click that opens that
/// file's diff in Files › Changes.
#[derive(Default)]
pub(crate) struct ChangesPill {
    pr: PrStatus,
    files: Vec<(String, u64, u64)>,
    /// The workspace and turn state the files were read for. A finished turn
    /// or another thread reads them again.
    key: Option<(String, bool)>,
    generation: u64,
    over_pill: bool,
    over_list: bool,
}

/// Changed files from `/api/review/workspace`, as (path, additions, deletions).
/// An error body reads as no answer, so the last list stays.
fn changed_files(body: &Value) -> Vec<(String, u64, u64)> {
    if !body["error"].is_null() {
        return vec![];
    }
    body["changedFiles"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| {
            Some((
                f["path"].as_str()?.to_owned(),
                f["additions"].as_u64().unwrap_or(0),
                f["deletions"].as_u64().unwrap_or(0),
            ))
        })
        .collect()
}

/// The pill's label and its total additions and deletions.
/// The floating controls' glass: the popover fill, mostly opaque, so text
/// that runs under the pill and the jump arrow stays out of the way.
fn floating_glass() -> gpui::Rgba {
    gpui::Rgba {
        a: 0.86,
        ..crate::theme::popover_background()
    }
}

fn floating_shadow() -> Vec<gpui::BoxShadow> {
    vec![gpui::BoxShadow {
        color: gpui::hsla(0., 0., 0., 0.18),
        offset: gpui::point(px(0.), px(4.)),
        blur_radius: px(14.),
        spread_radius: px(0.),
    }]
}

fn summary(files: &[(String, u64, u64)]) -> (String, u64, u64) {
    let count = files.len();
    let noun = if count == 1 { "file" } else { "files" };
    (
        format!("{count} {noun} changed"),
        files.iter().map(|f| f.1).sum(),
        files.iter().map(|f| f.2).sum(),
    )
}

impl Surface {
    fn changes_workspace(&self) -> Option<String> {
        let id = self.selected.as_ref()?;
        // Runtime workers are read-only history, as in thread switching.
        if id.contains(':') {
            return None;
        }
        self.sessions
            .iter()
            .find(|s| &s.id == id)
            .and_then(|s| s.repo_path.clone())
    }

    pub(super) fn sync_changes_pill(&mut self, cx: &mut Context<Self>) {
        let Some(workspace) = self.changes_workspace() else {
            self.changes_pill = ChangesPill {
                generation: self.changes_pill.generation,
                pr: std::mem::take(&mut self.changes_pill.pr),
                ..Default::default()
            };
            return;
        };
        let key = (workspace.clone(), self.turn_running());
        if self.changes_pill.key.as_ref() == Some(&key) {
            return;
        }
        // Another workspace's files never show over this one, even while its
        // own read is in flight or after it fails.
        if self.changes_pill.key.as_ref().map(|k| &k.0) != Some(&workspace) {
            self.changes_pill.files.clear();
            self.changes_pill.over_pill = false;
            self.changes_pill.over_list = false;
        }
        self.changes_pill.key = Some(key);
        self.changes_pill.generation += 1;
        let generation = self.changes_pill.generation;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            client.get::<Value>(
                "/api/review/workspace",
                &[("workspace", workspace.as_str()), ("changesOnly", "1")],
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.changes_pill.generation {
                    return;
                }
                // A failed read keeps this workspace's last list rather than
                // flashing empty.
                let Ok(body) = result else { return };
                if !body["error"].is_null() {
                    return;
                }
                let files = changed_files(&body);
                if files != this.changes_pill.files {
                    this.changes_pill.files = files;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// Whether the floating changes pill is showing; it then carries the
    /// jump arrow beside it.
    pub(crate) fn changes_pill_shown(&self) -> bool {
        (!self.changes_pill.files.is_empty() || self.changes_pill.pr.detail.is_some())
            && self.empty_chat_project().is_none()
    }
    /// The jump-to-latest arrow: a glass circle the pill's height, so the two
    /// read as one row of floating controls.
    pub(crate) fn jump_arrow(&self, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        div()
            .id("transcript-jump-to-end")
            .debug_selector(|| "transcript-jump-to-end".into())
            .occlude()
            .size(px(PILL_HEIGHT - 2.))
            .flex_shrink_0()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .border_1()
            .border_color(theme().border)
            .bg(floating_glass())
            .shadow(floating_shadow())
            .hover(|d| d.bg(theme().hover))
            .tooltip(|_, cx| cx.new(|_| crate::icon::Tip("Jump to latest".into())).into())
            .on_click(cx.listener(|this, _, _, cx| {
                let last = this.list.item_count().saturating_sub(1);
                this.list.scroll_to_reveal_item(last);
                this.pinned = true;
                this.away_from_end = false;
                cx.notify();
            }))
            .child(crate::icon::stroke(
                "M12 5v14M5 12l7 7 7-7",
                theme().text_secondary,
                12.,
                2.2,
            ))
    }
    pub(super) fn changes_pill(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        self.sync_changes_pill(cx);
        self.sync_pr_status(cx);
        if self.changes_pill.pr.detail.is_some() && self.empty_chat_project().is_none() {
            return Some(self.pr_status_pill(window, cx));
        }
        let pill = &self.changes_pill;
        // A new chat has no changes of its own yet (Q 2026-11-09).
        if pill.files.is_empty() || self.empty_chat_project().is_some() {
            return None;
        }
        let (label, add, del) = summary(&pill.files);
        let open = pill.over_pill || pill.over_list;
        let counts = |add: u64, del: u64| {
            div()
                .flex()
                .gap(px(4.))
                .flex_shrink_0()
                .child(div().text_color(theme().success).child(format!("+{add}")))
                .child(div().text_color(theme().danger).child(format!("−{del}")))
        };
        let list = open.then(|| {
            // Painted after the transcript so its last rows can't draw over the list.
            gpui::deferred(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    // Above the floating pill and its 8px of air.
                    .bottom(px(PILL_HEIGHT + 8.))
                    .flex()
                    .justify_center()
                    .child(
                        div()
                            .id("composer-changes-list")
                            .debug_selector(|| "composer-changes-list".into())
                            .occlude()
                            .w(px(320.))
                            .max_h(px(260.))
                            .overflow_y_scroll()
                            .flex()
                            .flex_col()
                            .gap(px(1.))
                            .p(px(4.))
                            .rounded(px(10.))
                            .border_1()
                            .border_color(theme().border)
                            .bg(crate::theme::popover_background())
                            .shadow_lg()
                            .text_size(px(12.))
                            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                                this.changes_pill.over_list = *hovered;
                                cx.notify();
                            }))
                            .children(pill.files.iter().enumerate().map(
                                |(index, (path, add, del))| {
                                    let name = path.rsplit('/').next().unwrap_or(path).to_owned();
                                    let target = path.clone();
                                    div()
                                        .id(("composer-changes-file", index))
                                        .debug_selector(move || {
                                            format!("composer-changes-file-{index}")
                                        })
                                        .flex()
                                        .items_center()
                                        .justify_between()
                                        .gap(px(12.))
                                        .px(px(8.))
                                        .h(px(28.))
                                        .flex_shrink_0()
                                        .rounded(px(6.))
                                        .cursor_pointer()
                                        .hover(|d| d.bg(theme().hover))
                                        .child(
                                            div()
                                                .min_w_0()
                                                .overflow_hidden()
                                                .text_ellipsis()
                                                .whitespace_nowrap()
                                                .text_color(theme().text)
                                                .child(name),
                                        )
                                        .child(counts(*add, *del))
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.changes_pill.over_pill = false;
                                            this.changes_pill.over_list = false;
                                            crate::ui::open_link(
                                                &format!("o8-change:{target}"),
                                                window,
                                                cx,
                                            );
                                            cx.notify();
                                        }))
                                },
                            )),
                    ),
            )
            .with_priority(1)
        });
        // Q 2026-11-09: the pill floats over the transcript's last lines as
        // glass, instead of a strip of its own that cut the text off above it.
        let glass = floating_glass();
        Some(
            div()
                .relative()
                .w_full()
                .h(px(0.))
                .child(
                    div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .bottom(px(8.))
                        .flex()
                        .justify_center()
                        .items_center()
                        .gap(px(6.))
                        .child(
                            div()
                                .id("composer-changes-pill")
                                .debug_selector(|| "composer-changes-pill".into())
                                .occlude()
                                .h(px(PILL_HEIGHT - 2.))
                                .px(px(11.))
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .rounded_full()
                                .border_1()
                                .border_color(theme().border)
                                .bg(glass)
                                .shadow(floating_shadow())
                                .text_size(px(12.))
                                .cursor_default()
                                .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                                    this.changes_pill.over_pill = *hovered;
                                    cx.notify();
                                }))
                                .child(div().text_color(theme().text_secondary).child(label))
                                .child(counts(add, del)),
                        )
                        // Scrolled up, the jump arrow sits on the pill's line.
                        .when(self.away_from_end, |row| row.child(self.jump_arrow(cx))),
                )
                .children(list)
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_each_changed_file_with_its_counts() {
        let body = json!({"changedFiles": [
            {"path": "src/a.rs", "additions": 3, "deletions": 1},
            {"path": "b.md"},
            {"additions": 9}
        ]});
        assert_eq!(
            changed_files(&body),
            vec![("src/a.rs".into(), 3, 1), ("b.md".into(), 0, 0)]
        );
        assert!(changed_files(&json!({"error": "not a repo"})).is_empty());
    }

    #[test]
    fn the_label_counts_files_and_totals_lines() {
        let files = vec![("a".into(), 28, 4), ("b".into(), 0, 12)];
        assert_eq!(summary(&files), ("2 files changed".into(), 28, 16));
        assert_eq!(summary(&files[..1]).0, "1 file changed");
    }
}
