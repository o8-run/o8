use super::*;

/// The project bar over an empty chat's composer: which project the new chat
/// works in, and a list to start it in another one instead.
#[derive(Default)]
pub(crate) struct ProjectBar {
    /// (path, name) for every project this machine lists, read once.
    repos: Option<Vec<(String, String)>>,
    loading: bool,
    open: bool,
}

/// Every registered repository that still exists, as (path, name).
fn repos(body: &Value) -> Vec<(String, String)> {
    body["repos"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|repo| repo["exists"].as_bool() != Some(false))
        .filter_map(|repo| {
            let path = repo["localPath"].as_str()?.to_owned();
            let name = repo["name"]
                .as_str()
                .filter(|name| !name.trim().is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(&path).to_owned());
            Some((path, name))
        })
        .collect()
}

impl Surface {
    /// The selected chat's project while it has nothing in it yet: a chat New
    /// chat made, with no messages and no turn running.
    fn empty_chat_project(&self) -> Option<String> {
        let id = self.selected.as_ref()?;
        if !id.starts_with("thoughts-next-") || !self.rows.is_empty() || self.turn_running() {
            return None;
        }
        let session = self.sessions.iter().find(|s| &s.id == id)?;
        (session.message_count == 0)
            .then(|| session.repo_path.clone())
            .flatten()
    }

    fn load_project_bar(&mut self, cx: &mut Context<Self>) {
        if self.project_bar.repos.is_some() || self.project_bar.loading {
            return;
        }
        self.project_bar.loading = true;
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.get::<Value>("/api/panel/repos", &[]) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.project_bar.loading = false;
                // A failed read leaves the list unread, so the next open tries again.
                if let Ok(body) = result {
                    this.project_bar.repos = Some(repos(&body));
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn project_bar(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let Some(current) = self.empty_chat_project() else {
            self.project_bar.open = false;
            return None;
        };
        let name = current.rsplit('/').next().unwrap_or(&current).to_owned();
        let menu = self.project_bar.open.then(|| {
            let list = div()
                .id("composer-project-list")
                .debug_selector(|| "composer-project-list".into())
                .occlude()
                .w(px(240.))
                .max_h(px(280.))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap(px(1.))
                .p(px(5.))
                .rounded(px(12.))
                .border_1()
                .border_color(theme().border)
                .bg(crate::theme::popover_background())
                .shadow_lg()
                .text_size(px(12.5))
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    this.project_bar.open = false;
                    cx.notify();
                }))
                .child(
                    div()
                        .px(px(8.))
                        .py(px(5.))
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child("Work in"),
                )
                .when(self.project_bar.repos.is_none(), |list| {
                    list.child(
                        div()
                            .px(px(8.))
                            .h(px(30.))
                            .flex()
                            .items_center()
                            .text_color(theme().text_muted)
                            .child("Loading projects…"),
                    )
                })
                .children(self.project_bar.repos.iter().flatten().enumerate().map(
                    |(index, (path, label))| {
                        let chosen = *path == current;
                        let target = path.clone();
                        div()
                            .id(("composer-project", index))
                            .debug_selector(move || format!("composer-project-{index}"))
                            .flex_shrink_0()
                            .h(px(30.))
                            .px(px(8.))
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(10.))
                            .rounded(px(7.))
                            .cursor_pointer()
                            .hover(|row| row.bg(theme().hover))
                            .child(
                                div()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .whitespace_nowrap()
                                    .text_color(theme().text)
                                    .child(crate::text::sanitize(label)),
                            )
                            .when(chosen, |row| {
                                row.child(crate::icon::stroke(
                                    CHECK,
                                    theme().text_secondary,
                                    13.,
                                    1.8,
                                ))
                            })
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.project_bar.open = false;
                                if !chosen {
                                    crate::ui::open_link(
                                        &format!("o8-new-thread:{target}"),
                                        window,
                                        cx,
                                    );
                                }
                                cx.notify();
                            }))
                    },
                ));
            gpui::deferred(
                gpui::anchored()
                    .anchor(gpui::Corner::BottomLeft)
                    .snap_to_window_with_margin(px(12.))
                    .child(div().pb(px(6.)).child(list)),
            )
            .with_priority(1)
        });
        Some(
            div()
                .w_full()
                .flex()
                .pb(px(6.))
                .child(
                    div().relative().children(menu).child(
                        div()
                            .id("composer-project-chip")
                            .debug_selector(|| "composer-project-chip".into())
                            .h(px(26.))
                            .px(px(9.))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .rounded(px(8.))
                            .cursor_pointer()
                            .text_size(px(12.))
                            .text_color(theme().text_secondary)
                            .hover(|chip| chip.bg(theme().hover).text_color(theme().text))
                            .when(self.project_bar.open, |chip| chip.bg(theme().hover))
                            .child(crate::icon::stroke(FOLDER, theme().text_muted, 13., 1.7))
                            .child(crate::text::sanitize(&name))
                            .child(crate::icon::stroke(CHEVRON, theme().text_muted, 10., 1.8))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.project_bar.open = !this.project_bar.open;
                                if this.project_bar.open {
                                    this.load_project_bar(cx);
                                }
                                cx.notify();
                            })),
                    ),
                )
                .into_any_element(),
        )
    }
}

const FOLDER: &str = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z";
const CHEVRON: &str = "M6 9l6 6 6-6";
const CHECK: &str = "M5 12.5 10 17.5 19 7";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lists_existing_projects_by_name() {
        let body = json!({"repos": [
            {"localPath": "/r/o8", "name": "o8", "exists": true},
            {"localPath": "/r/gone", "name": "gone", "exists": false},
            {"localPath": "/r/site", "name": ""},
            {"name": "no path"}
        ]});
        assert_eq!(
            repos(&body),
            vec![
                ("/r/o8".to_owned(), "o8".to_owned()),
                ("/r/site".to_owned(), "site".to_owned())
            ]
        );
    }
}
