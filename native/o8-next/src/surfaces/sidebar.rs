//! Persistent workspace rail. Owns its lifecycle, layout, navigation and fixtures.
use super::*;
use crate::projects_model::Ledger;
#[path = "sidebar/thread_list.rs"]
mod thread_list;
/// Local weekday, hour and minute, for the rail usage card's reset times.
pub(crate) use thread_list::recents::calendar::clock as calendar_clock;
/// Local day boundaries, for Activity's Today / Yesterday / "Oct 24" headings.
pub(crate) use thread_list::recents::calendar::{
    date as calendar_date, midnight as calendar_midnight, moment as calendar_moment,
};
/// A repository's icon override or monogram, for the Projects page.
pub(crate) use thread_list::repo_identity;
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
    /// The column's open or close in flight; None at rest.
    pub motion: Option<crate::motion::Transition>,
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

/// Open and close travel for the column (Q 2026-10-31). It grows out of the
/// rail's o8 mark and folds back into it, as the phone's drawer leaves its chip.
const TRAVEL_MS: u64 = 340;

/// Starts the column toward shown or hidden; opening fades its rows in.
pub(super) fn toggle(shell: &mut Shell, cx: &mut gpui::App) {
    let sidebar = &mut shell.surfaces.sidebar;
    sidebar.hidden = !sidebar.hidden;
    sidebar
        .motion
        .get_or_insert(crate::motion::Transition::settled(TRAVEL_MS, sidebar.hidden))
        .set(!sidebar.hidden);
    if !sidebar.hidden
        && let Some(view) = &sidebar.view
    {
        view.update(cx, |list, cx| list.stagger_in(cx));
    }
}

/// How open the column is now (0 hidden, 1 shown) and whether it is moving.
pub(super) fn travel(shell: &Shell) -> (f32, bool) {
    let sidebar = &shell.surfaces.sidebar;
    let smooth = |x: f32| x * x * (3. - 2. * x);
    match sidebar.motion.map(|motion| (motion.position(), motion.is_open())) {
        // Opening eases out with a soft start, so the card stays on the mark
        // for its first frames; closing eases in and out, so the fold back
        // into the mark reads as clearly as the way out.
        Some(((x, true), opening)) => (
            if opening { smooth(crate::motion::ease_out(x)) } else { smooth(x) },
            true,
        ),
        _ => (if sidebar.hidden { 0. } else { 1. }, false),
    }
}

/// The column's width: the dragged one, else the default.
pub(super) fn width(shell: &Shell) -> f32 {
    shell
        .state
        .sidebar_width
        .filter(|width| width.is_finite())
        .map_or(WIDTH, |width| width.clamp(MIN_WIDTH, MAX_WIDTH))
}

/// The space left of the workspace once the sidebar has settled.
pub(super) fn workspace_inset(shell: &Shell) -> f32 {
    WORKSPACE_INSET + if shell.surfaces.sidebar.hidden { 0. } else { COLUMN_HANDLE }
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

/// Classic's `workspaceInset` left of the workspace card, and the column handle
/// (COLUMN_HANDLE_WIDTH) that sits before it while the sidebar is open.
const WORKSPACE_INSET: f32 = 4.;
const COLUMN_HANDLE: f32 = 4.;
/// The handle sits mid-gap between the column and the workspace card.
pub(super) const EDGE_GAP: f32 = COLUMN_HANDLE;
/// A wide grab target over the boundary, from the window's top edge so the
/// header's mark is part of it, with a line that lights when the cursor is near.
fn edge(
    width: f32,
    resizing: bool,
    press: std::rc::Rc<std::cell::Cell<Option<(f32, f32)>>>,
) -> impl IntoElement {
    div()
        .id("sidebar-resize")
        .debug_selector(|| "sidebar-resize".into())
        .absolute()
        .top(px(-crate::theme::GEOMETRY.header))
        .bottom_0()
        .left(px(width - EDGE_SLOP - 0.5 + EDGE_GAP))
        .w(px(EDGE_SLOP * 2. + 1.))
        .cursor(gpui::CursorStyle::ResizeLeftRight)
        .on_mouse_down(gpui::MouseButton::Left, move |event, _, _| {
            press.set(Some((f32::from(event.position.x), width)));
        })
        .on_drag(Resize, |_, _, _, cx| cx.new(|_| Resize))
        .child(crate::theme::split_line(
            "sidebar-resize",
            true,
            EDGE_SLOP,
            resizing,
        ))
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
        // A far workspace's thread goes by its own server's id in its surface.
        let selected = selected.map(|id| {
            match workspace.as_deref().and_then(session::machine_workspace) {
                Some((machine, _)) => session::machine_thread_id(machine, &id),
                None => id,
            }
        });
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
        let (open, moving) = travel(shell);
        let inset = WORKSPACE_INSET + COLUMN_HANDLE * open;
        if shell.surfaces.sidebar.hidden && !moving {
            return div()
                .pl(px(inset))
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .min_w_0()
                .child(content)
                .into_any_element();
        }
        let width = width(shell);
        let list = gpui::AnyView::from(shell.surfaces.sidebar.view.as_ref().unwrap().clone())
            .cached(
                gpui::StyleRefinement::default()
                    .w(px(width))
                    .h_full()
                    .flex_shrink_0(),
            );
        div()
            .relative()
            .flex()
            .flex_1()
            .min_h_0()
            // This row sits inside the panel and resize row; its automatic
            // minimum width must not widen the workspace past the window.
            .min_w_0()
            .map(|row| {
                if !moving {
                    return row.child(list);
                }
                // In flight the workspace makes room while a card carries the
                // full-width rows out of the rail's o8 mark: it starts as the
                // mark's tile, lifts with a fill and shadow, and lands flush.
                let mix = |from: f32, to: f32| from + (to - from) * open;
                let mark_left = -(crate::shell::rail::WIDTH + crate::shell::rail::TARGET) / 2.;
                let lift = (open / 0.12).min(1.) * ((1. - open) / 0.25).min(1.);
                let tint = |color: gpui::Rgba| gpui::Rgba { a: color.a * lift, ..color };
                let card = div()
                    .absolute()
                    .left(px(mix(mark_left, 0.)))
                    .top(px(mix(crate::shell::rail::PAD, 0.)))
                    .w(px(mix(crate::shell::rail::TARGET, width)))
                    .h(gpui::relative(open))
                    .min_h(px(crate::shell::rail::TARGET))
                    .overflow_hidden()
                    .rounded(px(mix(10., 0.)))
                    .bg(tint(crate::theme::current().surface_raised))
                    .border_1()
                    .border_color(tint(crate::theme::current().border))
                    .shadow(vec![gpui::BoxShadow {
                        color: gpui::black().opacity(0.4 * lift),
                        offset: gpui::point(px(0.), px(10.)),
                        blur_radius: px(28.),
                        spread_radius: px(0.),
                    }])
                    // The rows keep the row's height while the card is shorter.
                    .child(
                        div()
                            .absolute()
                            .top_0()
                            .left_0()
                            .w(px(width))
                            .h(gpui::relative(1. / open.max(0.01)))
                            .when(shell.surfaces.sidebar.hidden, |rows| {
                                rows.opacity(((open - 0.5) / 0.5).clamp(0., 1.))
                            })
                            .child(list),
                    )
                    // The mark itself, fading as the card leaves it.
                    .child(
                        div()
                            .absolute()
                            .left(px((crate::shell::rail::TARGET - 24.) / 2. - 1.))
                            .top(px((crate::shell::rail::TARGET - 24.) / 2. - 1.))
                            .opacity((1. - open / 0.3).max(0.))
                            .child(crate::shell::rail::brand()),
                    );
                row.child(div().w(px(width * open)).h_full().flex_shrink_0())
                    .child(gpui::deferred(card).with_priority(1))
            })
            .child(
                div()
                    .pl(px(inset))
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(content),
            )
            .when(!moving, |row| {
                row.child(edge(
                    width,
                    shell.surfaces.sidebar.resizing,
                    shell.surfaces.sidebar.press.clone(),
                ))
            })
            .into_any_element()
    },
    key_down: |shell, event, window, cx| {
        if shell.surfaces.sidebar.view.as_ref().is_some_and(|view| {
            view.update(cx, |sidebar, cx| {
                sidebar.header_key(event, window, cx)
                    || sidebar.settle_key(event, cx)
                    || sidebar.undo_key(event, window, cx)
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
    claim_link: |shell, url, window, cx| {
        let Some(id) = crate::lineage::parse_link(url) else {
            return false;
        };
        shell.open_thread_by_id(id.to_owned(), window, cx);
        true
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
    let links = shell.links.clone();
    let sidebar = cx.new(|cx| {
        let mut list = ThreadList::new(shell.client.clone(), cx);
        list.links = links;
        list
    });
    let scopes = shell.state.sidebar_scope.clone();
    let (views, closed) = (
        shell.state.sidebar_view.clone(),
        shell.state.sidebar_closed_folders.clone(),
    );
    let snoozes = shell.state.sidebar_snoozes.clone();
    let (detailed, working) = (
        shell.state.sidebar_detailed_rows,
        shell.state.sidebar_working_section,
    );
    sidebar.update(cx, |sidebar, _| {
        sidebar.restore_scopes(scopes);
        sidebar.restore_views(&views, &closed);
        sidebar.restore_snoozes(&snoozes);
        sidebar.restore_row_mode(detailed, working);
    });
    shell.subscriptions.push(
        cx.subscribe_in(&sidebar, window, |shell, _, event, window, cx| {
            match event {
                ThreadEvent::Loaded(sessions) => {
                    shell.install_sessions(session::with_server_ids(sessions), false, cx)
                }
                ThreadEvent::Refreshed(sessions, ledger) => {
                    shell.surfaces.sidebar.workspace_ledger = ledger.clone();
                    shell.install_sessions(session::with_server_ids(sessions), true, cx);
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
                ThreadEvent::Selected(id) => match shell.unreachable_machine(id) {
                    Some(machine) => {
                        toasts::info(format!("{machine} can't be reached right now."), cx);
                    }
                    None => shell.open_thread(id.clone(), window, cx),
                },
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
                ThreadEvent::RowMode(detailed, working) => {
                    shell.state.sidebar_detailed_rows = *detailed;
                    shell.state.sidebar_working_section = *working;
                    shell.persist();
                }
                ThreadEvent::Snoozes(snoozes) => {
                    shell.state.sidebar_snoozes = snoozes.iter().cloned().collect();
                    shell.persist();
                }
                ThreadEvent::Error(error) => {
                    shell.loading = false;
                    // A busy response retains a healthy connection. A transport
                    // timeout has spent the load budget and must settle offline.
                    if !shell.connected
                        || !crate::client::transient(error)
                        || error.ends_with("Request timed out")
                    {
                        shell.connected = false;
                        shell.notice = format!(
                            "Local server unavailable: {error}. Start the local o8 server, then Retry."
                        );
                    }
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
            .map(Session::workspace)
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
                    // Choosing for the person stays on this computer.
                    self.state.selected = self
                        .workspaces
                        .iter()
                        .find(|workspace| session::machine_workspace(workspace).is_none())
                        .cloned();
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
    /// Starts a thread on the operator's lead in the open repository, as the
    /// sidebar's New thread does, opening it in the main pane when `open`;
    /// None when no repository is open.
    pub(crate) fn start_thread(&mut self, open: bool, cx: &mut Context<Self>) -> Option<String> {
        let repo = self.state.selected.clone().filter(|w| w != "Unassigned")?;
        let list = self.surfaces.sidebar.view.clone()?;
        Some(list.update(cx, |list, cx| list.start_thread(repo, open, cx)))
    }
    /// Opens a thread a lineage row, created-thread link or "started by"
    /// marker named, or says so when this machine does not list it.
    pub(crate) fn open_thread_by_id(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.sessions.iter().any(|s| s.id == id) {
            self.open_thread(id, window, cx);
        } else {
            toasts::show(
                toasts::Kind::Info,
                "That thread is not on this machine yet.",
                vec![],
                Some(toasts::NOTICE_TIMEOUT),
                cx,
            );
        }
    }
    pub(super) fn open_thread(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        // A sidebar id names one computer's thread; a link from inside a far
        // thread names a thread in that thread's own workspace.
        let selected = self.state.selected.clone();
        let Some(session) = self
            .sessions
            .iter()
            .find(|s| s.list_id() == id)
            .or_else(|| {
                self.sessions
                    .iter()
                    .find(|s| s.id == id && Some(s.workspace()) == selected)
            })
        else {
            return;
        };
        let (workspace, id) = (session.workspace(), session.id.clone());
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
