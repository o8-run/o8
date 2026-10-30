//! Persistent workspace rail. Owns its lifecycle, layout, navigation and fixtures.
use super::*;
use crate::projects_model::Ledger;
#[path = "sidebar/thread_list.rs"]
mod thread_list;
/// Local weekday, hour and minute, for the rail usage card's reset times.
pub(crate) use thread_list::recents::calendar::clock as calendar_clock;
/// Local day boundaries, for Activity's Today / Yesterday / "Oct 24" headings.
pub(crate) use thread_list::recents::calendar::{
    date as calendar_date, midnight as calendar_midnight,
};
#[path = "sidebar/thread_list_client.rs"]
mod thread_list_client;
#[path = "sidebar/thread_mutations_client.rs"]
mod thread_mutations_client;
use thread_list::{Event as ThreadEvent, ThreadList};
pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    pub view: Option<Entity<ThreadList>>,
    /// The header's sidebar toggle (Cmd+B) hides the column.
    pub hidden: bool,
    /// The column's edge is being dragged; the width saves on release.
    pub resizing: bool,
    /// Where the press on the edge began and the width then (useColumnResize's
    /// startX and startWidth), so the drag threshold never shifts the edge.
    pub press: std::rc::Rc<std::cell::Cell<Option<(f32, f32)>>>,
    workspace_ledger: Option<Ledger>,
    bootstrapped: bool,
}
/// The sidebar column; the header lays its toggle and search over it.
pub(super) const WIDTH: f32 = 280.;
const MIN_WIDTH: f32 = 160.;
const MAX_WIDTH: f32 = 500.;
/// The edge's grab target reaches this far either side of the boundary.
const EDGE_SLOP: f32 = 8.;

/// The column's width: the dragged one, else the default.
pub(super) fn width(shell: &Shell) -> f32 {
    shell
        .state
        .sidebar_width
        .filter(|width| width.is_finite())
        .map_or(WIDTH, |width| width.clamp(MIN_WIDTH, MAX_WIDTH))
}

/// A drag of the column's edge.
pub(super) struct Resize;
impl Render for Resize {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        gpui::Empty
    }
}

/// Moves the edge with the pointer from where the press began.
pub(super) fn resize(shell: &mut Shell, event: &gpui::DragMoveEvent<Resize>) {
    let Some((from, start)) = shell.surfaces.sidebar.press.get() else {
        return;
    };
    let width = start + f32::from(event.event.position.x) - from;
    shell.state.sidebar_width = Some(width.clamp(MIN_WIDTH, MAX_WIDTH));
    shell.surfaces.sidebar.resizing = true;
}

/// A wide grab target over the boundary with a quiet line that glows on hover.
fn edge(
    width: f32,
    resizing: bool,
    glass: bool,
    press: std::rc::Rc<std::cell::Cell<Option<(f32, f32)>>>,
) -> impl IntoElement {
    let accent = crate::theme::current().accent;
    div()
        .id("sidebar-resize")
        .debug_selector(|| "sidebar-resize".into())
        .group("sidebar-resize")
        .absolute()
        .top_0()
        .bottom_0()
        .left(px(width - EDGE_SLOP - 0.5))
        .w(px(EDGE_SLOP * 2. + 1.))
        .cursor(gpui::CursorStyle::ResizeLeftRight)
        .on_mouse_down(gpui::MouseButton::Left, move |event, _, _| {
            press.set(Some((f32::from(event.position.x), width)));
        })
        .on_drag(Resize, |_, _, _, cx| cx.new(|_| Resize))
        .child(
            div()
                .absolute()
                .top(px(18.))
                .bottom(px(if glass { 0. } else { 18. }))
                .left(px(EDGE_SLOP))
                .w(px(1.))
                .bg(accent)
                .shadow(vec![gpui::BoxShadow {
                    color: accent.into(),
                    offset: gpui::point(px(0.), px(0.)),
                    blur_radius: px(8.),
                    spread_radius: px(0.),
                }])
                .opacity(if resizing { 0.85 } else { 0. })
                .group_hover("sidebar-resize", |style| style.opacity(0.85)),
        )
}
pub(super) const REGISTRATION: Registration = Registration {
    initialize,
    overlay_command: true,
    load: |shell, cx| {
        if !shell.loading {
            shell.loading = true;
            // Stream wakeups refresh the catalog constantly; only the first connect is announced.
            if !shell.connected {
                shell.notice = "Connecting to local o8 server…".into();
            }
            shell
                .surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .update(cx, |sidebar, cx| sidebar.load(cx));
            cx.notify();
        }
        true
    },
    tick: |shell, window, cx| {
        let selected = shell
            .active()
            .and_then(|tab| shell.content.get(&shell.key(&tab)))
            .and_then(|content| match content {
                Content::Session(surface) => surface.read(cx).shell_selection(window, cx).0,
                _ => None,
            });
        let workspace = shell.state.selected.clone();
        shell
            .surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .update(cx, |sidebar, cx| {
                sidebar.set_workspace(workspace);
                if let Some(id) = selected {
                    sidebar.sync_selection(id, cx);
                }
                sidebar.tick(cx);
            });
    },
    decorate: |shell, content| {
        if shell.surfaces.sidebar.hidden {
            return div()
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .min_w_0()
                .child(content)
                .into_any_element();
        }
        let width = width(shell);
        div()
            .relative()
            .flex()
            .flex_1()
            .min_h_0()
            // This row sits inside the panel and resize row; its automatic
            // minimum width must not widen the workspace past the window.
            .min_w_0()
            .child(
                gpui::AnyView::from(shell.surfaces.sidebar.view.as_ref().unwrap().clone()).cached(
                    gpui::StyleRefinement::default()
                        .w(px(width))
                        .h_full()
                        .flex_shrink_0(),
                ),
            )
            .child(div().flex().flex_col().flex_1().min_w_0().child(content))
            .child(edge(
                width,
                shell.surfaces.sidebar.resizing,
                shell.system_glass,
                shell.surfaces.sidebar.press.clone(),
            ))
            .into_any_element()
    },
    key_down: |shell, event, window, cx| {
        if shell.surfaces.sidebar.view.as_ref().is_some_and(|view| {
            view.update(cx, |sidebar, cx| {
                sidebar.header_key(event, window, cx) || sidebar.settle_key(event, cx)
            })
        }) {
            return true;
        }
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        let search = shell.surfaces.settings.view.is_none()
            && (modifiers.control || modifiers.platform)
            && key == "f";
        if search || key == "f8" {
            if search {
                shell
                    .surfaces
                    .sidebar
                    .view
                    .as_ref()
                    .unwrap()
                    .update(cx, |sidebar, cx| sidebar.search(window, cx));
            } else {
                shell.execute(Command::Sidebar, window, cx);
            }
            true
        } else {
            false
        }
    },
    catalog_changed: |shell, cx| {
        if let Some(projects) = &shell.surfaces.projects.view {
            shell.surfaces.sidebar.workspace_ledger = Some(projects.read(cx).workspace_ledger());
            shell
                .surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .update(cx, |sidebar, _| sidebar.catalog_changed());
        }
    },
    ..Registration::new("", "", |shell, _, window, cx| {
        shell
            .surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .update(cx, |sidebar, cx| sidebar.focus(window, cx));
        None
    })
};
fn initialize(shell: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let sidebar = cx.new(|cx| ThreadList::new(shell.client.clone(), cx));
    let scopes = shell.state.sidebar_scope.clone();
    let (views, closed) = (
        shell.state.sidebar_view.clone(),
        shell.state.sidebar_closed_folders.clone(),
    );
    sidebar.update(cx, |sidebar, _| {
        sidebar.restore_scopes(scopes);
        sidebar.restore_views(&views, &closed);
    });
    shell.subscriptions.push(
        cx.subscribe_in(&sidebar, window, |shell, _, event, window, cx| {
            match event {
                ThreadEvent::Loaded(sessions) => {
                    shell.install_sessions(sessions.clone(), false, cx)
                }
                ThreadEvent::Refreshed(sessions, ledger) => {
                    shell.surfaces.sidebar.workspace_ledger = ledger.clone();
                    shell.install_sessions(sessions.clone(), true, cx);
                }
                ThreadEvent::Workspace(path, ledger) => {
                    shell
                        .workspaces
                        .extend(ledger.projects.iter().flat_map(|p| p.repo_paths.clone()));
                    shell.workspaces.sort();
                    shell.workspaces.dedup();
                    shell.surfaces.sidebar.workspace_ledger = Some(ledger.clone());
                    if let Some(path) = path {
                        shell.switch(path.clone(), window, cx);
                    } else {
                        shell.state.selected = None;
                        shell.persist();
                    }
                }
                ThreadEvent::WorkspacePicker(previous) => {
                    if let Some(focus) = previous {
                        focus.focus(window);
                    }
                    super::palette::open_workspaces(shell, window, cx);
                }
                ThreadEvent::Selected(id) => shell.open_thread(id.clone(), window, cx),
                ThreadEvent::UiCommand(frame) => shell.ui_command(frame, window, cx),
                ThreadEvent::Scope(project, keys) => {
                    if keys.is_empty() {
                        shell.state.sidebar_scope.remove(project);
                    } else {
                        shell.state.sidebar_scope.insert(project.clone(), keys.clone());
                    }
                    shell.persist();
                }
                ThreadEvent::View(project, view) => {
                    shell.state.sidebar_view.insert(project.clone(), (*view).into());
                    shell.persist();
                }
                ThreadEvent::Folders(closed) => {
                    shell.state.sidebar_closed_folders = closed.iter().cloned().collect();
                    shell.persist();
                }
                ThreadEvent::Error(error) => {
                    shell.loading = false;
                    shell.connected = false;
                    shell.notice = format!(
                        "Local server unavailable: {error}. Start the local o8 server, then Retry."
                    );
                }
            }
            cx.notify();
        }),
    );
    shell.surfaces.sidebar.view = Some(sidebar);
}
impl Shell {
    fn install_sessions(
        &mut self,
        sessions: Vec<Session>,
        refreshed: bool,
        cx: &mut Context<Self>,
    ) {
        // Loading also describes healthy maintenance and recovery requests.
        // Only the first catalog adopts the server's active project; subsequent
        // catalogs keep the user's workspace as long as it still exists.
        let bootstrap = !self.surfaces.sidebar.bootstrapped;
        self.sessions = sessions;
        let mut workspaces = self
            .sessions
            .iter()
            .map(|s| s.repo_path.clone().unwrap_or_else(|| "Unassigned".into()))
            .collect::<BTreeSet<_>>();
        if let Some(ledger) = &self.surfaces.sidebar.workspace_ledger {
            workspaces.extend(ledger.projects.iter().flat_map(|p| p.repo_paths.clone()));
        }
        self.workspaces = workspaces.into_iter().collect();
        if refreshed {
            self.surfaces.sidebar.bootstrapped = true;
            self.loading = false;
            self.connected = true;
            let missing = !self
                .state
                .selected
                .as_ref()
                .is_some_and(|w| self.workspaces.contains(w));
            if bootstrap || missing {
                let active = self
                    .surfaces
                    .sidebar
                    .workspace_ledger
                    .as_ref()
                    .and_then(|ledger| {
                        ledger
                            .projects
                            .iter()
                            .find(|p| p.id == ledger.active_project_id && p.id != "default")
                    });
                if let Some(active) = active {
                    if !self
                        .state
                        .selected
                        .as_ref()
                        .is_some_and(|w| active.repo_paths.contains(w))
                    {
                        self.state.selected = active.repo_paths.first().cloned();
                    }
                } else if !self
                    .state
                    .selected
                    .as_ref()
                    .is_some_and(|w| self.workspaces.contains(w))
                {
                    self.state.selected = self.workspaces.first().cloned();
                }
            }
        }
        if self.connected {
            self.notice.clear();
        }
        for content in self.content.values() {
            if let Content::Grid(grid) = content {
                grid.update(cx, |g, cx| g.load(cx));
            }
        }
        self.persist();
    }
    fn open_thread(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(workspace) = self
            .sessions
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.repo_path.clone().unwrap_or_else(|| "Unassigned".into()))
        else {
            return;
        };
        self.surfaces.projects.open = false;
        self.surfaces.settings.view = None;
        self.surfaces.settings.subscription = None;
        if self.state.selected.as_ref() != Some(&workspace) {
            self.switch(workspace, window, cx);
        }
        if let Some(Tab::Session(original)) = self.active() {
            let key = self.key(&Tab::Session(original.clone()));
            let sessions = self.workspace_sessions();
            if let Some(Content::Session(surface)) = self.content.get(&key) {
                surface.update(cx, |s, cx| s.shell_select(sessions, id.clone(), cx));
                self.state
                    .workspaces
                    .get_mut(self.state.selected.as_ref().unwrap())
                    .unwrap()
                    .selections
                    .insert(original, id);
                self.persist();
                cx.notify();
                return;
            }
        }
        self.execute(Command::Session(id), window, cx);
    }
}
#[cfg(test)]
#[path = "sidebar/sidebar_tests.rs"]
mod tests;
