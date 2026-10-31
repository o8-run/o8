//! The list's views, from o8 classic's ChatGroupPicker: Chronological, By date
//! and By repo. By repo folds threads into T3 Code's boring-sidebar project
//! folders, with o8 repositories as the projects.
//!
//! Adapted from T3 Code (https://github.com/pingdotgg/t3code),
//! apps/web/src/components/sidebar/SidebarProjectFolderHeader.tsx and
//! apps/web/src/components/Sidebar.logic.ts (groupSidebarThreadsByProject,
//! resolveSidebarFolderDot), commit f58fad04162165653bf06f0c987bbfb0074a8a4b.
//! Copyright (c) 2026 T3 Tools Inc. MIT; full notice retained in
//! src/lib/usage/history-readers/LICENSE.txt. Adaptations: Rust and GPUI,
//! repositories as folders, threads of other repositories in folders of their
//! own, o8 presentation.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, px};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum View {
    Inbox,
    Chronological,
    #[default]
    Date,
    Repo,
}
impl View {
    pub(crate) const ALL: [View; 4] = [View::Inbox, View::Chronological, View::Repo, View::Date];
    pub(crate) fn key(self) -> &'static str {
        match self {
            View::Inbox => "inbox",
            View::Chronological => "chronological",
            View::Date => "date",
            View::Repo => "repo",
        }
    }
    pub(crate) fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|view| view.key() == key)
    }
    /// CHAT_VIEW_LABELS; the groupings read "Group by …" as in classic.
    pub(crate) fn label(self) -> &'static str {
        match self {
            View::Inbox => "Inbox",
            View::Chronological => "Chronological",
            View::Date => "Group by date",
            View::Repo => "Group by repo",
        }
    }
}

/// A folder row: open or closed, its hidden thread count, and the dot a
/// closed folder shows.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Folder {
    pub open: bool,
    pub count: usize,
    pub dot: &'static str,
}

/// resolveSidebarFolderDot: the most urgent state among a closed folder's
/// threads. Attention outranks failure, then an unseen finish, then work.
pub(super) fn dot(sessions: &[&Session]) -> &'static str {
    if sessions.iter().any(|s| matches!(sidebar::rank(s), 2 | 3)) {
        "attention"
    } else if sessions.iter().any(|s| sidebar::rank(s) >= 4) {
        "failed"
    } else if sessions.iter().any(|s| s.unread && !sidebar::working(s)) {
        "unread"
    } else if sessions.iter().any(|s| sidebar::working(s)) {
        "working"
    } else {
        ""
    }
}

fn split<'a>(visible: Vec<&'a Session>) -> (Vec<&'a Session>, Vec<&'a Session>) {
    visible.into_iter().partition(|s| s.status != "archived")
}

/// One list, newest activity first; archived threads stay in Archived.
pub(super) fn chronological(
    sessions: &[Session],
    query: &str,
    matches: &HashSet<String>,
    expanded: &HashSet<String>,
    branches: &HashSet<String>,
) -> Vec<Row> {
    let now = recents::now();
    let searching = !query.trim().is_empty();
    let (live, archived) = split(recents::visible(sessions, query, matches));
    let mut rows = vec![recents::header("section", "Recents", "")];
    let open = searching || expanded.contains("Chronological");
    let count = if open { live.len() } else { live.len().min(50) };
    rows.extend(
        live.iter()
            .take(count)
            .map(|s| recents::thread_row(s, now, branches)),
    );
    if count < live.len() {
        rows.push(recents::header(
            "more",
            &format!("Show {} more", live.len() - count),
            "Chronological",
        ));
    }
    let open = searching || expanded.contains("Archived");
    recents::group_rows(&mut rows, "Archived", &archived, 12, open, now, branches);
    rows
}

/// groupSidebarThreadsByProject: a folder per repository in the project's
/// order, then other repositories' threads, then Unassigned. Empty project
/// folders show only while a scope is chosen (keepEmptyFolders).
#[allow(clippy::too_many_arguments)]
pub(super) fn by_repo(
    sessions: &[Session],
    query: &str,
    matches: &HashSet<String>,
    expanded: &HashSet<String>,
    branches: &HashSet<String>,
    repos: &[(String, String)],
    closed: &HashSet<String>,
    keep_empty: bool,
) -> Vec<Row> {
    let now = recents::now();
    let searching = !query.trim().is_empty();
    let (live, archived) = split(recents::visible(sessions, query, matches));
    let mut folders: Vec<(String, String, Vec<&Session>)> = repos
        .iter()
        .map(|(path, name)| (path.clone(), name.clone(), vec![]))
        .collect();
    for session in live {
        let path = session.repo_path.clone().unwrap_or_default();
        match folders.iter_mut().find(|folder| folder.0 == path) {
            Some(folder) => folder.2.push(session),
            None => {
                let name = if path.is_empty() {
                    "Unassigned".into()
                } else {
                    label(&path)
                };
                folders.push((path, name, vec![session]));
            }
        }
    }
    if let Some(index) = folders.iter().position(|folder| folder.0.is_empty()) {
        let unassigned = folders.remove(index);
        folders.push(unassigned);
    }
    let mut rows = vec![recents::header("section", "Recents", "")];
    for (path, name, threads) in folders {
        if threads.is_empty() && (searching || !keep_empty) {
            continue;
        }
        // A search opens every folder, so a match is never hidden.
        let open = searching || !closed.contains(&path);
        rows.push(Row {
            kind: "folder".into(),
            workspace: path,
            folder: Some(Folder {
                open,
                count: threads.len(),
                dot: if open { "" } else { dot(&threads) },
            }),
            ..recents::header("folder", &name, "")
        });
        if open {
            rows.extend(
                threads
                    .iter()
                    .map(|s| recents::thread_row(s, now, branches)),
            );
        }
    }
    let open = searching || expanded.contains("Archived");
    recents::group_rows(&mut rows, "Archived", &archived, 12, open, now, branches);
    rows
}

/// Lucide square-pen: a folder's New thread.
pub(super) const NEW_THREAD: &str = "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z";
const CHEVRON_DOWN: &str = "M6 9l6 6 6-6";
const CHEVRON_RIGHT: &str = "M9 6l6 6-6 6";
/// ChatGroupPicker's trigger: three dots.
const DOTS: &str = "M5 12h.001 M12 12h.001 M19 12h.001";
pub(super) const CHECK: &str = "M20 6 9 17l-5-5";

impl ThreadList {
    /// The active project's view; By date until one is chosen.
    pub(super) fn view(&self) -> View {
        self.header
            .ledger
            .projects
            .iter()
            .find(|p| p.id == self.header.ledger.active_project_id)
            .and_then(|p| self.views.get(&p.id))
            .copied()
            // A host without inbox settlement keeps the sidebar it had.
            .filter(|view| *view != View::Inbox || self.inbox_ready())
            .unwrap_or_default()
    }
    /// Restores each project's view and the closed folders from the shell state.
    pub fn restore_views(
        &mut self,
        views: &std::collections::BTreeMap<String, String>,
        closed: &std::collections::BTreeSet<String>,
    ) {
        self.views = views
            .iter()
            .filter_map(|(project, key)| Some((project.clone(), View::from_key(key)?)))
            .collect();
        self.closed = closed.iter().cloned().collect();
        self.rebuild();
    }
    pub(super) fn set_view(&mut self, view: View, cx: &mut Context<Self>) {
        self.view_menu = false;
        let project = self.header.ledger.active_project_id.clone();
        if !project.is_empty() {
            self.views.insert(project.clone(), view);
            cx.emit(Event::View(project, view.key()));
        }
        self.rebuild();
        cx.notify();
    }
    pub(super) fn toggle_folder(&mut self, path: String, cx: &mut Context<Self>) {
        if !self.closed.remove(&path) {
            self.closed.insert(path);
        }
        self.rebuild();
        let mut closed: Vec<_> = self.closed.iter().cloned().collect();
        closed.sort();
        cx.emit(Event::Folders(closed));
        cx.notify();
    }
    /// The view trigger on the list's heading, and its menu while open.
    pub(super) fn view_picker(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let open = self.view_menu;
        let current = self.view();
        let inbox = self.inbox_ready();
        let trigger = div()
            .id("sidebar-view")
            .debug_selector(|| "sidebar-view".into())
            .size(px(18.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(4.))
            .cursor_pointer()
            .when(open, |v| v.bg(theme().hover))
            .hover(|v| v.bg(theme().hover))
            .when(!open, |v| {
                v.tooltip(|_, cx| {
                    cx.new(|_| crate::icon::Tip("Change chat view".into()))
                        .into()
                })
            })
            .child(crate::icon::stroke(DOTS, theme().text_muted, 12., 3.))
            .on_click(cx.listener(|this, event: &gpui::ClickEvent, window, cx| {
                if !this.dismissing(event) {
                    this.view_menu = !this.view_menu;
                }
                this.focus.focus(window);
                cx.notify();
            }));
        let item = |view: View, cx: &mut Context<Self>| {
            let selector = format!("sidebar-view-{}", view.key());
            div()
                .id(gpui::ElementId::Name(selector.clone().into()))
                .debug_selector(move || selector.clone())
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(10.))
                .py(px(6.))
                .text_size(px(12.))
                .text_color(theme().text)
                .cursor_pointer()
                .hover(|v| v.bg(theme().hover))
                .child(
                    div()
                        .w(px(14.))
                        .flex()
                        .justify_center()
                        .when(view == current, |v| {
                            v.child(crate::icon::stroke(CHECK, theme().accent, 11., 2.6))
                        }),
                )
                .child(view.label())
                .on_click(cx.listener(move |this, _, _, cx| this.set_view(view, cx)))
        };
        let menu = open.then(|| {
            gpui::deferred(
                gpui::anchored()
                    .anchor(gpui::Corner::TopRight)
                    // Right edges align: the trigger is 18px wide.
                    .position_mode(gpui::AnchoredPositionMode::Local)
                    .position(gpui::point(px(18.), px(0.)))
                    .snap_to_window_with_margin(px(12.))
                    .child(
                        div()
                            .id("sidebar-view-menu")
                            .debug_selector(|| "sidebar-view-menu".into())
                            .occlude()
                            .mt(px(22.))
                            .w(px(168.))
                            .py(px(8.))
                            .rounded(px(12.))
                            .bg(crate::theme::popover_background())
                            .border_1()
                            .border_color(theme().border)
                            .shadow_lg()
                            // The press stays in the menu, off the rows beneath it.
                            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| {
                                cx.stop_propagation()
                            })
                            .on_mouse_down_out(cx.listener(
                                |this, event: &gpui::MouseDownEvent, _, cx| {
                                    this.view_menu = false;
                                    this.dismissed(event);
                                    cx.notify();
                                },
                            ))
                            .when(inbox, |menu| menu.child(item(View::Inbox, cx)))
                            .child(item(View::Chronological, cx))
                            .child(div().my(px(4.)).h(px(1.)).bg(theme().border))
                            .child(item(View::Repo, cx))
                            .child(item(View::Date, cx)),
                    ),
            )
            .with_priority(1)
        });
        div()
            .relative()
            .child(trigger)
            .children(menu)
            .into_any_element()
    }
}

impl ThreadList {
    /// Starts a conversation in `repo` on the operator's lead and opens it, as
    /// the composer's lead picker does. Without a lead the server would save a
    /// runtime placeholder ("claude-code") as the model, and the first send
    /// would fail.
    pub(crate) fn new_thread(&mut self, repo: String, cx: &mut Context<Self>) {
        self.start_thread(repo, true, cx);
    }
    /// Starts a conversation without opening it in the main pane when `open`
    /// is false (a split pane shows it); returns its id.
    pub(crate) fn start_thread(&mut self, repo: String, open: bool, cx: &mut Context<Self>) -> String {
        self.new_menu = false;
        let id = format!(
            "thoughts-next-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let started = id.clone();
        let client = self.client.clone();
        let (thread, name) = (id.clone(), label(&repo));
        let task = cx.background_executor().spawn(async move {
            // Without the lead the server would save its runtime placeholder,
            // and the first send would fail, so an unreadable lead fails here.
            let defaults: Value = client
                .get("/api/panel/operator-defaults", &[("include", "values")])
                .map_err(|e| e.to_string())?;
            let mut body = json!({
                "tabId": thread, "messages": [], "repoPath": repo,
                "repoName": name, "title": "New conversation",
            });
            let lead = &defaults["values"];
            if let Some(backend) = lead["orchestratorBackend"].as_str().filter(|b| *b != "auto") {
                body["backend"] = json!(backend);
            }
            if let Some(model) = lead["orchestratorModel"].as_str().filter(|m| !m.is_empty()) {
                body["model"] = json!(model);
            }
            let url = client
                .url("/api/v2/chat-history")
                .map_err(|e| e.to_string())?;
            client
                .request("POST", &url)
                .send_json(body)
                .map(|_| ())
                .map_err(|e| e.to_string())
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(()) => {
                        // The shell opens threads from the list it was sent,
                        // so the new thread opens after the next load.
                        if open {
                            this.selected = Some(id.clone());
                            this.follow_selection = true;
                            this.pending_open = Some(id);
                        }
                        this.load(cx);
                    }
                    Err(error) => {
                        crate::shell::toasts::show(
                            crate::shell::toasts::Kind::SpawnError {
                                detail: error.into(),
                            },
                            "Could not start a thread.",
                            vec![],
                            Some(crate::shell::toasts::ERROR_TIMEOUT),
                            cx,
                        );
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
        started
    }
    /// A New thread whose POST has returned and whose load has not.
    #[cfg(test)]
    pub(crate) fn expect_open(&mut self, id: &str) {
        self.pending_open = Some(id.to_owned());
    }
    /// A menu's outside press closed it: remember the press for its trigger.
    pub(super) fn dismissed(&mut self, event: &gpui::MouseDownEvent) {
        self.menu_press = Some(event.position);
    }
    /// Whether this click is the press that just closed a menu from outside;
    /// on the menu's own trigger that press closes the menu and nothing more.
    pub(super) fn dismissing(&mut self, event: &gpui::ClickEvent) -> bool {
        match event {
            gpui::ClickEvent::Mouse(click) => self.menu_press.take() == Some(click.down.position),
            gpui::ClickEvent::Keyboard(_) => false,
        }
    }
    /// SidebarThreadHeader's New thread: the current repository in By repo,
    /// with one repository, or with Shift; otherwise a repository menu.
    fn header_new_thread(&mut self, shift: bool, cx: &mut Context<Self>) {
        let repos = self.scope_repos();
        let current = self
            .workspace
            .clone()
            .filter(|path| repos.iter().any(|(p, _)| p == path))
            .or_else(|| repos.first().map(|(path, _)| path.clone()));
        match current {
            Some(repo) if shift || repos.len() == 1 || self.view() == View::Repo => {
                self.new_thread(repo, cx)
            }
            Some(_) => {
                self.new_menu = !self.new_menu;
                cx.notify();
            }
            None => {}
        }
    }
    pub(super) fn new_thread_button(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let repos = self.scope_repos();
        let menu = self.new_menu.then(|| {
            let mut list = div()
                .id("sidebar-new-thread-menu")
                .debug_selector(|| "sidebar-new-thread-menu".into())
                .occlude()
                .mt(px(32.))
                .w(px(220.))
                .max_h(px(320.))
                .overflow_y_scroll()
                .p(px(5.))
                .rounded(px(12.))
                .bg(crate::theme::popover_background())
                .border_1()
                .border_color(theme().border)
                .shadow_lg()
                .on_mouse_down_out(cx.listener(|this, event: &gpui::MouseDownEvent, _, cx| {
                    this.new_menu = false;
                    this.dismissed(event);
                    cx.notify();
                }))
                .child(
                    div()
                        .px(px(8.))
                        .py(px(5.))
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child("New thread in"),
                );
            for (path, name) in repos {
                let selector = format!("sidebar-new-thread-in-{name}");
                list = list.child(
                    div()
                        .id(gpui::ElementId::Name(selector.clone().into()))
                        .debug_selector(move || selector.clone())
                        .h(px(30.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(9.))
                        .rounded(px(7.))
                        .text_size(px(12.5))
                        .cursor_pointer()
                        .hover(|s| s.bg(theme().hover))
                        .child(project_header::repo_identity(
                            &name,
                            None,
                            self.repo_icon(&path),
                            15.,
                            "sidebar-new-thread-identity",
                        ))
                        .child(crate::text::sanitize(&name))
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.new_thread(path.clone(), cx)),
                        ),
                );
            }
            gpui::deferred(
                gpui::anchored()
                    .anchor(gpui::Corner::TopRight)
                    // Right edges align: the trigger is 28px wide.
                    .position_mode(gpui::AnchoredPositionMode::Local)
                    .position(gpui::point(px(28.), px(0.)))
                    .snap_to_window_with_margin(px(12.))
                    .child(list),
            )
            .with_priority(1)
        });
        div()
            .relative()
            .child(
                div()
                    .id("sidebar-new-thread")
                    .debug_selector(|| "sidebar-new-thread".into())
                    .size(px(28.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(8.))
                    .cursor_pointer()
                    .hover(|style| style.bg(theme().hover))
                    .when(self.new_menu, |v| v.bg(theme().hover))
                    .when(!self.new_menu, |v| {
                        v.tooltip(|_, cx| {
                            cx.new(|_| {
                                crate::icon::Tip(
                                    "New thread · Shift-click for the current repository".into(),
                                )
                            })
                            .into()
                        })
                    })
                    .child(crate::icon::stroke(
                        NEW_THREAD,
                        theme().text_muted,
                        15.,
                        1.7,
                    ))
                    .on_click(cx.listener(|this, event: &gpui::ClickEvent, _, cx| {
                        if !this.dismissing(event) {
                            this.header_new_thread(event.modifiers().shift, cx)
                        }
                    })),
            )
            .children(menu)
            .into_any_element()
    }
    /// SidebarProjectFolderHeader: mark, name, then the closed folder's dot
    /// and count, and a chevron; New thread shows on hover over the count.
    pub(super) fn folder_row(
        &mut self,
        row: &Row,
        folder: &Folder,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let path = row.workspace.clone();
        let name = crate::text::sanitize(&row.title);
        let dot = match folder.dot {
            "attention" => Some(theme().warning),
            "failed" => Some(theme().danger),
            "unread" => Some(theme().success),
            "working" => Some(theme().accent),
            _ => None,
        };
        let selector = format!("sidebar-folder-{name}");
        let new_selector = format!("sidebar-folder-new-{name}");
        let (toggle, start) = (path.clone(), path.clone());
        div()
            .id(gpui::ElementId::Name(format!("folder:{path}").into()))
            .debug_selector(move || selector.clone())
            .group("sidebar-folder")
            .relative()
            .w_full()
            .min_w_0()
            .h(px(28.))
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(12.))
            .rounded(px(8.))
            .cursor_pointer()
            .hover(|style| style.bg(theme().hover))
            .child(project_header::repo_identity(
                &name,
                None,
                self.repo_icon(&path),
                15.,
                "sidebar-folder-identity",
            ))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .whitespace_normal()
                    .line_clamp(1)
                    .text_ellipsis()
                    .text_size(px(12.5))
                    .font_weight(gpui::FontWeight::NORMAL)
                    .text_color(theme().text_secondary)
                    .child(name),
            )
            .when_some(dot, |v, color| {
                v.child(
                    div()
                        .debug_selector(|| "sidebar-folder-dot".into())
                        .size(px(6.))
                        .flex_shrink_0()
                        .rounded_full()
                        .bg(color),
                )
            })
            .when(!folder.open && folder.count > 0, |v| {
                let count = folder.count;
                v.child(
                    div()
                        .debug_selector(move || format!("sidebar-folder-count:{count}"))
                        .flex_shrink_0()
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .group_hover("sidebar-folder", |s| s.invisible())
                        .child(count.to_string()),
                )
            })
            .child(crate::icon::stroke(
                if folder.open {
                    CHEVRON_DOWN
                } else {
                    CHEVRON_RIGHT
                },
                theme().text_muted,
                12.,
                2.,
            ))
            .when(!path.is_empty(), |v| {
                v.child(
                    div()
                        .id(gpui::ElementId::Name(format!("folder-new:{path}").into()))
                        .debug_selector(move || new_selector.clone())
                        .absolute()
                        .right(px(30.))
                        .top(px(4.))
                        .size(px(20.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(5.))
                        // Transparent rather than hidden, so the pen keeps its
                        // hit area for the press that arrives with the hover.
                        .opacity(0.)
                        .group_hover("sidebar-folder", |s| s.opacity(1.))
                        .hover(|s| s.bg(theme().selection))
                        .tooltip(|_, cx| {
                            cx.new(|_| crate::icon::Tip("New thread in this repository".into()))
                                .into()
                        })
                        .child(crate::icon::stroke(
                            NEW_THREAD,
                            theme().text_muted,
                            12.,
                            1.8,
                        ))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.new_thread(start.clone(), cx)
                        })),
                )
            })
            .on_click(cx.listener(move |this, _, _, cx| this.toggle_folder(toggle.clone(), cx)))
    }
}
