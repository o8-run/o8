use super::*;

/// Height of the pill row; the file list opens flush above it so the pointer
/// can move from the pill into the list without closing it.
const PILL_HEIGHT: f32 = 26.;

/// The workspace's uncommitted changes above the composer: one pill with the
/// totals, a hover list with each file's counts, and a click that opens that
/// file's diff in Files › Changes.
#[derive(Default)]
pub(crate) struct ChangesPill {
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

    pub(super) fn changes_pill(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        self.sync_changes_pill(cx);
        let pill = &self.changes_pill;
        if pill.files.is_empty() {
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
                    .bottom(px(PILL_HEIGHT))
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
        Some(
            div()
                .relative()
                .w_full()
                .flex()
                .justify_center()
                .pb(px(8.))
                .child(
                    div()
                        .id("composer-changes-pill")
                        .debug_selector(|| "composer-changes-pill".into())
                        .h(px(PILL_HEIGHT - 4.))
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .rounded_full()
                        .border_1()
                        .border_color(theme().border)
                        .bg(theme().surface_raised)
                        .text_size(px(12.))
                        .cursor_default()
                        .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                            this.changes_pill.over_pill = *hovered;
                            cx.notify();
                        }))
                        .child(div().text_color(theme().text_secondary).child(label))
                        .child(counts(add, del)),
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
