use super::*;

/// An empty chat's context row under the composer: which project the new
/// chat works in (with a list to start it in another one), the checkout, the
/// branch and access.
///
/// The empty chat's heading and row follow T3 Code
/// (https://github.com/pingdotgg/t3code, MIT),
/// apps/web/src/components/chat/DraftHeroHeadline.tsx and
/// DraftHeroProjectHeading.tsx at commit
/// f58fad04162165653bf06f0c987bbfb0074a8a4b. Copyright (c) 2026 T3 Tools Inc.
#[derive(Default)]
pub(crate) struct ProjectBar {
    /// (path, name) for every project this machine lists, read once.
    repos: Option<Vec<(String, String)>>,
    loading: bool,
    /// The last read failed; the next open tries again.
    failed: bool,
    open: bool,
    /// The press that just closed the list from outside, so the same press on
    /// the chip closes it rather than opening it again.
    dismissed: Option<gpui::Point<gpui::Pixels>>,
    /// (repo, its checked-out branch), read once per project; a new chat in
    /// the shared checkout works on that branch unless one is picked.
    checkout: Option<(String, Option<String>)>,
}

/// A project's folder name: the last non-empty path segment.
fn folder(path: &str) -> &str {
    path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(path)
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
                .unwrap_or_else(|| folder(&path).to_owned());
            Some((path, name))
        })
        .collect()
}

impl Surface {
    /// The selected chat's project while it has nothing in it yet: a chat New
    /// chat made, with no messages, no turn running and no send on its way.
    pub(crate) fn empty_chat_project(&self) -> Option<String> {
        let id = self.selected.as_ref()?;
        if !id.starts_with("thoughts-next-")
            || !self.rows.is_empty()
            || self.turn_running()
            || self.saving
            || self.pending.contains_key(id)
            || !self.queued_items().is_empty()
        {
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
        self.project_bar.failed = false;
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.get::<Value>("/api/panel/repos", &[]) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.project_bar.loading = false;
                // A failed read leaves the list unread, so the next open tries again.
                match result {
                    Ok(body) => this.project_bar.repos = Some(repos(&body)),
                    Err(_) => this.project_bar.failed = true,
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Reads the project's checked-out branch, once per project.
    fn load_checkout_branch(&mut self, repo: &str, cx: &mut Context<Self>) {
        if self
            .project_bar
            .checkout
            .as_ref()
            .is_some_and(|(r, _)| r == repo)
        {
            return;
        }
        self.project_bar.checkout = Some((repo.to_owned(), None));
        let client = self.client.clone();
        let path = repo.to_owned();
        let task = cx.background_executor().spawn(async move {
            client.get::<Value>("/api/panel/branches", &[("path", path.as_str())])
        });
        let repo = repo.to_owned();
        cx.spawn(async move |this, cx| {
            let branch = task.await.ok().and_then(|body| {
                body["branches"]
                    .as_array()?
                    .iter()
                    .find(|b| b["current"] == true)?["name"]
                    .as_str()
                    .map(str::to_owned)
            });
            let _ = this.update(cx, |this, cx| {
                if this
                    .project_bar
                    .checkout
                    .as_ref()
                    .is_some_and(|(r, _)| *r == repo)
                {
                    this.project_bar.checkout = Some((repo, branch));
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(super) fn project_bar(&mut self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let Some(current) = self.empty_chat_project() else {
            self.project_bar.open = false;
            return None;
        };
        // The registered name the list shows, once the list is read.
        let name = self
            .project_bar
            .repos
            .iter()
            .flatten()
            .find(|(path, _)| *path == current)
            .map_or_else(|| folder(&current).to_owned(), |(_, name)| name.clone());
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
                .on_mouse_down_out(cx.listener(|this, event: &gpui::MouseDownEvent, _, cx| {
                    this.project_bar.open = false;
                    this.project_bar.dismissed = Some(event.position);
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
                            .child(if self.project_bar.failed {
                                "Couldn't read projects. Open again to retry."
                            } else {
                                "Loading projects…"
                            }),
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
        let chip = div().relative().children(menu).child(
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
                .on_click(cx.listener(|this, event: &gpui::ClickEvent, _, cx| {
                    let press = match event {
                        gpui::ClickEvent::Mouse(click) => Some(click.down.position),
                        gpui::ClickEvent::Keyboard(_) => None,
                    };
                    if press.is_some() && this.project_bar.dismissed.take() == press {
                        return;
                    }
                    this.project_bar.open = !this.project_bar.open;
                    if this.project_bar.open {
                        this.load_project_bar(cx);
                    }
                    cx.notify();
                })),
        );
        let routing = self.composer_routing(cx).unwrap_or(Value::Null);
        let worktrees = routing["pickedMode"] == "multitask";
        let plan = routing["permissionMode"] == "plan";
        // The branch the chat will use: one picked in the composer, else the
        // branch the shared checkout has out (unknown until read, so hidden).
        self.load_checkout_branch(&current, cx);
        let picked = self.composer.read(cx).controls.prompt.branch.clone();
        let branch = (!picked.is_empty()).then_some(picked).or_else(|| {
            self.project_bar
                .checkout
                .as_ref()
                .filter(|(r, _)| *r == current)
                .and_then(|(_, b)| b.clone())
        });
        let quiet = |id: &'static str, glyph: &'static str, label: String| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .h(px(26.))
                .px(px(8.))
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(px(8.))
                .min_w_0()
                .text_size(px(12.))
                .text_color(theme().text_muted)
                .child(crate::icon::stroke(glyph, theme().text_faint, 13., 1.7))
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .child(label),
                )
        };
        let picker = |id: &'static str,
                      glyph: &'static str,
                      label: &'static str,
                      open: &'static str,
                      cx: &mut Context<Self>| {
            quiet(id, glyph, label.to_owned())
                .flex_shrink_0()
                .cursor_pointer()
                .hover(|chip| chip.bg(theme().hover).text_color(theme().text))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.open_composer_picker(open, window, cx)
                }))
        };
        // Q 2026-11-09, after T3 Code's new thread: where the chat works, on
        // one quiet row under the composer. Project and checkout on the left;
        // the branch and access on the right.
        Some(
            div()
                .debug_selector(|| "composer-context-row".into())
                .w_full()
                .pt(px(8.))
                .px(px(4.))
                .flex()
                .items_center()
                .gap(px(2.))
                .child(chip)
                .child(picker(
                    "composer-context-checkout",
                    CHECKOUT,
                    if worktrees {
                        "Worktrees"
                    } else {
                        "Current checkout"
                    },
                    "mode",
                    cx,
                ))
                .child(div().flex_1())
                .children(
                    branch.map(|branch| {
                        quiet("composer-context-branch", BRANCH, branch).flex_shrink()
                    }),
                )
                .child(picker(
                    "composer-context-access",
                    SHIELD,
                    if plan { "Plan only" } else { "Full access" },
                    "access",
                    cx,
                ))
                .into_any_element(),
        )
    }

    /// An empty chat's heading over the composer: the question in the
    /// project's name and, right under it, a way to start without one.
    pub(super) fn empty_chat_hero(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let current = self.empty_chat_project()?;
        let home = crate::shell::session::is_home(&current);
        let name = self
            .project_bar
            .repos
            .iter()
            .flatten()
            .find(|(path, _)| *path == current)
            .map_or_else(|| folder(&current).to_owned(), |(_, name)| name.clone());
        let title = if home {
            "What should we do?".to_owned()
        } else {
            format!("What should we build in {}?", crate::text::sanitize(&name))
        };
        let away = crate::shell::session::home_workspace().filter(|_| !home);
        Some(
            div()
                .debug_selector(|| "composer-empty-hero".into())
                .w_full()
                .pb(px(22.))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(6.))
                .child({
                    // Regular weight with tight tracking, as large display
                    // type wants; ExtraLight at 28px read thin and uneven.
                    let mut heading = div();
                    heading
                        .text_style()
                        .get_or_insert_with(Default::default)
                        .letter_spacing = Some(px(-0.6));
                    heading
                        .text_size(px(26.))
                        .font_weight(gpui::FontWeight::NORMAL)
                        .text_color(theme().text)
                        .text_center()
                        .child(title)
                })
                .children(away.map(|home| {
                    div()
                        .id("composer-start-without-project")
                        .debug_selector(|| "composer-start-without-project".into())
                        .px(px(8.))
                        .py(px(3.))
                        .rounded(px(7.))
                        .text_size(px(13.))
                        .text_color(theme().text_muted)
                        .cursor_pointer()
                        .hover(|link| link.bg(theme().hover).text_color(theme().text))
                        .child("or start without a project")
                        .on_click(cx.listener(move |_, _, window, cx| {
                            crate::ui::open_link(&format!("o8-new-thread:{home}"), window, cx);
                        }))
                }))
                .into_any_element(),
        )
    }
}

const FOLDER: &str = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z";
const CHEVRON: &str = "M6 9l6 6 6-6";
const CHECK: &str = "M5 12.5 10 17.5 19 7";
/// Lucide layers, git-branch and shield.
const CHECKOUT: &str = "M12 2 2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5";
const BRANCH: &str = "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9";
const SHIELD: &str = "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn empty_chat(
        cx: &mut gpui::TestAppContext,
    ) -> (gpui::Entity<Surface>, &mut gpui::VisualTestContext) {
        let client = crate::client::Client::new("http://127.0.0.1:9").unwrap();
        let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
        surface.update(cx, |s, _| {
            s.sessions = vec![
                serde_json::from_value(json!({
                    "id": "thoughts-next-1", "title": "New conversation", "repoPath": "/r/site",
                    "lastMessageAt": "1", "status": "idle", "messageCount": 0
                }))
                .unwrap(),
            ];
            s.selected = Some("thoughts-next-1".into());
        });
        (surface, cx)
    }

    #[gpui::test]
    fn the_chip_leaves_once_a_send_is_on_its_way(cx: &mut gpui::TestAppContext) {
        let (surface, cx) = empty_chat(cx);
        let project = |surface: &gpui::Entity<Surface>, cx: &mut gpui::VisualTestContext| {
            surface.read_with(cx, |s, _| s.empty_chat_project())
        };
        assert_eq!(project(&surface, cx).as_deref(), Some("/r/site"));
        surface.update(cx, |s, _| s.saving = true);
        assert_eq!(project(&surface, cx), None);
        surface.update(cx, |s, _| {
            s.saving = false;
            s.pending
                .insert("thoughts-next-1".into(), json!({"id": "q-1"}));
        });
        assert_eq!(project(&surface, cx), None);
    }

    #[gpui::test]
    fn the_chip_closes_its_own_list(cx: &mut gpui::TestAppContext) {
        let (surface, cx) = empty_chat(cx);
        let click = |cx: &mut gpui::VisualTestContext| {
            cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear();
            });
            let bounds = cx.debug_bounds("composer-project-chip").expect("chip");
            cx.simulate_click(bounds.center(), gpui::Modifiers::default());
        };
        click(cx);
        assert!(surface.read_with(cx, |s, _| s.project_bar.open));
        click(cx);
        assert!(!surface.read_with(cx, |s, _| s.project_bar.open));
    }

    #[test]
    fn a_trailing_slash_still_names_the_folder() {
        assert_eq!(folder("/r/site/"), "site");
        assert_eq!(folder("/r/site"), "site");
        let body = json!({"repos": [{"localPath": "/r/site/", "name": ""}]});
        assert_eq!(
            repos(&body),
            vec![("/r/site/".to_owned(), "site".to_owned())]
        );
    }

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
