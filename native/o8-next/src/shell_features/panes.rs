use super::*;
use crate::pane_tree::{Leaf, MAIN, Node, Zone};
use gpui::{DragMoveEvent, SharedString};
use std::collections::{HashMap, HashSet};
#[path = "panes/preview.rs"]
mod preview;
#[path = "panes/worker.rs"]
mod worker;
// The workspace's split panes, as classic's TileContainer: drag the rail's
// Run orchestrator or Run terminal onto any pane and let go near an edge to
// split it there, as many times as you like. Each pane after the first holds
// its own chat or terminal; dividers resize, and a pane's close returns its
// space to its neighbor. The main pane keeps the header tabs.
struct Panes;
register_shell_feature!(Panes);
impl ShellFeature for Panes {
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 60,
            run: |s, _, window, cx| ensure(s, window, cx),
        }]
    }
    fn commands(&self) -> &'static [PaletteCommands] {
        &[PaletteCommands {
            order: 80,
            collect: preview::commands,
        }]
    }
}

#[derive(Default)]
struct State {
    /// The pane a rail drag is over, and where on it.
    hover: Option<(String, Zone)>,
    /// Terminal panes whose shell is being reserved, or failed to start.
    starting: HashSet<String>,
    failed: HashMap<String, String>,
    resizing: bool,
    /// The worker grid's layout preview, shown instead of the saved panes.
    preview: Option<preview::Preview>,
    /// Bumped by each preview start or end, so an older run stops adding.
    preview_run: u64,
    /// Real worker panes, by their pane key.
    workers: HashMap<String, gpui::Entity<worker::WorkerPane>>,
    /// The workers each workspace closed: they don't join again.
    dismissed: HashMap<String, HashSet<String>>,
    /// The worker pane last clicked.
    focused: Option<String>,
    /// The panes' measured width, for how many worker columns fit.
    width: f32,
}

/// A dragged divider, by its split's id.
#[derive(Clone)]
struct Divider(String);
impl Render for Divider {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

/// The main pane never gets narrower than this beside a worker grid.
const MAIN_MIN: f32 = 400.;
/// The shortest a row of worker cards gets before the grid scrolls.
const WORKER_ROW_MIN: f32 = 150.;
/// The narrowest a worker card gets before the grid drops a column.
const CARD_MIN: f32 = 230.;

/// How many worker columns fit beside the main pane in `width`.
fn columns(width: f32) -> usize {
    if width <= 0. {
        return 4;
    }
    (((width - MAIN_MIN) / CARD_MIN).floor() as usize).clamp(1, 4)
}
/// The workers of a layout that is only the main pane and workers, in order.
fn worker_leaves(tree: &Node) -> Option<Vec<Node>> {
    let mut workers = vec![];
    for (id, leaf) in tree.leaves() {
        match leaf {
            Leaf::Main => {}
            Leaf::Worker { .. } => workers.push(Node::Leaf {
                id: id.to_owned(),
                content: leaf.clone(),
            }),
            _ => return None,
        }
    }
    Some(workers)
}
/// Whether `tree` is still the automatic grid of its workers: no divider
/// moved, so arrivals and closes may reflow it.
fn automatic(tree: &Node, workers: &[Node]) -> bool {
    workers.is_empty()
        || (1..=4)
            .any(|columns| *tree == Node::worker_grid(Node::main(), workers.to_vec(), columns))
}

fn workspace(s: &Shell) -> String {
    s.state.selected.clone().unwrap_or_default()
}
fn key(s: &Shell, leaf: &str) -> String {
    format!("pane|{}|{leaf}", workspace(s))
}
/// The worker preview this workspace shows, if any.
fn previewing(s: &Shell) -> Option<&preview::Preview> {
    let ws = workspace(s);
    s.features
        .read::<State>()?
        .preview
        .as_ref()
        .filter(|preview| preview.workspace == ws)
}
fn tree(s: &Shell) -> Node {
    match previewing(s) {
        Some(preview) => preview.tree.clone(),
        None => saved(s),
    }
}
/// The workspace's own panes, under any preview.
fn saved(s: &Shell) -> Node {
    s.current()
        .and_then(|w| w.panes.clone())
        .unwrap_or_else(Node::main)
}
fn save_tree(s: &mut Shell, tree: Node) {
    // A preview's panes are never saved.
    if previewing(s).is_some() {
        if let Some(preview) = s.features.get::<State>().preview.as_mut() {
            preview.tree = tree;
        }
        return;
    }
    save_saved(s, tree);
}
fn save_saved(s: &mut Shell, tree: Node) {
    let Some(w) = s
        .state
        .selected
        .clone()
        .and_then(|w| s.state.workspaces.get_mut(&w))
    else {
        return;
    };
    w.panes = (!tree.is_single()).then_some(tree);
    s.persist();
}

/// Creates each pane's content once its chat is listed or its shell exists.
fn ensure(s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    // A preview belongs to the workspace it started in.
    let state = s.features.get::<State>();
    if state.preview.is_some() && previewing(s).is_none() {
        preview::end(s, cx);
    }
    join(s, cx);
    let Some(panes) = s.current().and_then(|w| w.panes.clone()) else {
        return;
    };
    let ws = workspace(s);
    for (id, leaf) in panes.leaves() {
        let key = key(s, id);
        if s.content.contains_key(&key) {
            continue;
        }
        match leaf {
            Leaf::Main => {}
            Leaf::Chat { session } => {
                if !s.sessions.iter().any(|x| &x.id == session) {
                    let failed = s
                        .surfaces
                        .sidebar
                        .view
                        .as_ref()
                        .is_some_and(|list| list.read(cx).failed_starts.contains(session));
                    if failed {
                        let state = s.features.get::<State>();
                        if !state.failed.contains_key(id) {
                            state
                                .failed
                                .insert(id.to_owned(), "Could not start this chat.".into());
                            cx.notify();
                        }
                    }
                    continue;
                }
                let tab = Tab::Session(session.clone());
                if let Some(content) = (tab.registration().create)(s, tab, ws.clone(), window, cx) {
                    s.content.insert(key, content);
                }
            }
            Leaf::Terminal {
                session: Some(session),
            } => {
                let client = s.panel_client(&ws);
                let (ws, session) = (ws.clone(), session.clone());
                let view = cx.new(|cx| {
                    super::super::terminal::View::pinned(
                        client,
                        crate::shell::session::workspace_path(&ws).to_owned(),
                        session,
                        cx,
                    )
                });
                s.content.insert(key, Content::Terminal(view));
            }
            Leaf::Terminal { session: None } => start_terminal(s, id.to_owned(), cx),
            Leaf::Worker { agent } => {
                if s.features.get::<State>().workers.contains_key(&key) {
                    continue;
                }
                let Some(agent) = super::right_panel::find_subagent(s, agent, cx) else {
                    continue;
                };
                let client = s.panel_client(&ws);
                let view = cx.new(|cx| worker::WorkerPane::new(client, agent, cx));
                s.features.get::<State>().workers.insert(key, view);
            }
        }
    }
    // Each worker follows its agent as the lists read it.
    let prefix = key(s, "");
    let views = s
        .features
        .get::<State>()
        .workers
        .iter()
        .filter(|(key, _)| key.starts_with(&prefix))
        .map(|(_, view)| view.clone())
        .collect::<Vec<_>>();
    for view in views {
        let agent = super::right_panel::find_subagent(s, &view.read(cx).agent.id, cx);
        view.update(cx, |view, cx| view.update(agent, cx));
    }
}

/// A worker the workspace's chat starts joins the grid beside it, while the
/// layout is only that chat and its workers. One closed here stays closed,
/// and a split of the user's own stops workers joining.
fn join(s: &mut Shell, cx: &mut Context<Shell>) {
    if previewing(s).is_some() {
        return;
    }
    let tree = saved(s);
    let Some(mut workers) = worker_leaves(&tree) else {
        return;
    };
    let ws = workspace(s);
    let state = s.features.get::<State>();
    let columns = columns(state.width);
    let dismissed = state.dismissed.get(&ws).cloned().unwrap_or_default();
    let shown = tree
        .leaves()
        .into_iter()
        .filter_map(|(_, leaf)| match leaf {
            Leaf::Worker { agent } => Some(agent.clone()),
            _ => None,
        })
        .collect::<HashSet<_>>();
    let arrivals = super::right_panel::subagent_list(s, cx)
        .into_iter()
        .filter(|agent| {
            agent.group == crate::subagents::model::Group::Working
                && !agent.native
                && agent.session.is_some()
                && !shown.contains(&agent.id)
                && !dismissed.contains(&agent.id)
        })
        .collect::<Vec<_>>();
    if arrivals.is_empty() {
        return;
    }
    let auto = automatic(&tree, &workers);
    let mut next = tree;
    for agent in arrivals {
        let id = format!("worker-{}", agent.id);
        let leaf = Leaf::Worker { agent: agent.id };
        if !auto {
            // A moved divider keeps its place: the worker splits in beside
            // the last one.
            let last = workers
                .last()
                .map_or(MAIN.to_owned(), |w| w.id().to_owned());
            next.split(&last, Zone::Right, id.clone(), leaf.clone());
        }
        workers.push(Node::Leaf { id, content: leaf });
    }
    if auto {
        next = Node::worker_grid(Node::main(), workers, columns);
    }
    save_saved(s, next);
    cx.notify();
}

/// Reserves a pane's own shell, which it keeps across restarts.
fn start_terminal(s: &mut Shell, leaf: String, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    if state.failed.contains_key(&leaf) || !state.starting.insert(leaf.clone()) {
        return;
    }
    let ws = workspace(s);
    let client = s.panel_client(&ws);
    let owner = format!("o8-next:{ws}:pane:{leaf}");
    let task = cx.background_executor().spawn(async move {
        client.create_terminal(crate::shell::session::workspace_path(&ws), &owner)
    });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |s, cx| {
            s.features.get::<State>().starting.remove(&leaf);
            match result {
                Ok(session) => {
                    // The shell belongs to the workspace's own panes, even
                    // while a preview shows.
                    let mut tree = saved(s);
                    if let Some(Leaf::Terminal { session: slot }) = tree.leaf_mut(&leaf) {
                        *slot = Some(session);
                        save_saved(s, tree);
                    }
                }
                Err(error) => {
                    s.features.get::<State>().failed.insert(leaf, error);
                }
            }
            cx.notify();
        });
    })
    .detach();
}

/// Splits `target` with a new chat or terminal pane where it was dropped.
fn split(s: &mut Shell, target: &str, zone: Zone, pane: super::RailPane, cx: &mut Context<Shell>) {
    // Simulated workers take no real chat or shell beside them.
    if previewing(s).is_some() {
        return;
    }
    let leaf = match pane {
        super::RailPane::Chat => match s.start_thread(false, cx) {
            Some(session) => Leaf::Chat { session },
            None => return,
        },
        super::RailPane::Terminal => Leaf::Terminal { session: None },
        // placeThreadPane: a thread shows once. The main chat's own thread
        // stays put, and one already in a pane moves there.
        super::RailPane::Thread { id, .. } => {
            if main_thread(s, cx).as_ref() == Some(&id) {
                return;
            }
            let open = tree(s).leaves().into_iter().find_map(|(leaf, content)| {
                let Leaf::Chat { session } = content else {
                    return None;
                };
                // A pane's view may have moved off its own thread.
                let shown = match s.content.get(&key(s, leaf)) {
                    Some(Content::Session(view)) => view.read(cx).shown_thread(),
                    _ => None,
                };
                (shown.as_ref().unwrap_or(session) == &id).then(|| leaf.to_owned())
            });
            if let Some(leaf) = open {
                return move_pane(s, &leaf, target, zone, cx);
            }
            Leaf::Chat { session: id }
        }
        super::RailPane::Move { leaf, .. } => return move_pane(s, &leaf, target, zone, cx),
    };
    let id = format!(
        "pane-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let mut tree = tree(s);
    if tree.split(target, zone, id, leaf) {
        save_tree(s, tree);
    }
    cx.notify();
}

/// Moves a pane beside `target`, keeping its id so its chat or terminal view stays.
fn move_pane(s: &mut Shell, leaf: &str, target: &str, zone: Zone, cx: &mut Context<Shell>) {
    if previewing(s).is_some() {
        return;
    }
    let mut tree = tree(s);
    let Some(content) = tree
        .leaves()
        .into_iter()
        .find(|(id, _)| *id == leaf)
        .map(|(_, content)| content.clone())
    else {
        return;
    };
    if leaf == target || !tree.close(leaf) {
        return;
    }
    if tree.split(target, zone, leaf.to_owned(), content) {
        save_tree(s, tree);
    }
    cx.notify();
}

fn close(s: &mut Shell, leaf: &str, cx: &mut Context<Shell>) {
    if let Some(preview) = s.features.get::<State>().preview.as_mut() {
        preview.close(leaf);
        return cx.notify();
    }
    let mut tree = tree(s);
    let workers = worker_leaves(&tree);
    let closed = tree
        .leaves()
        .into_iter()
        .find_map(|(id, content)| match content {
            Leaf::Worker { agent } if id == leaf => Some(agent.clone()),
            _ => None,
        });
    if tree.close(leaf) {
        let key = key(s, leaf);
        s.content.remove(&key);
        let ws = workspace(s);
        let state = s.features.get::<State>();
        state.failed.remove(leaf);
        state.workers.remove(&key);
        if let Some(agent) = closed {
            state.dismissed.entry(ws).or_default().insert(agent);
            // closeSessionLeaf: the automatic grid reflows.
            if let Some(workers) = workers.filter(|workers| automatic(&saved(s), workers)) {
                let rest = workers.into_iter().filter(|w| w.id() != leaf).collect();
                tree =
                    Node::worker_grid(Node::main(), rest, columns(s.features.get::<State>().width));
            }
        }
        save_tree(s, tree);
    }
    cx.notify();
}

/// The workspace's panes, with `main` (the active header tab) in the main pane.
pub(super) fn element(s: &mut Shell, main: AnyElement, cx: &mut Context<Shell>) -> AnyElement {
    let state = s.features.get::<State>();
    if !cx.has_active_drag() {
        state.hover = None;
        if std::mem::take(&mut state.resizing) {
            s.persist();
        }
    }
    let tree = tree(s);
    let mut main = Some(main);
    let panes = node(s, &tree, &mut main, cx);
    let measured = cx.entity().downgrade();
    let measure = gpui::canvas(
        |_, _, _| (),
        move |bounds, _, _, cx| {
            let width = f32::from(bounds.size.width);
            let _ = measured.update(cx, |s, cx| fit(s, width, cx));
        },
    )
    .absolute()
    .size_full();
    let panes = div()
        .relative()
        .flex()
        .flex_1()
        .size_full()
        .min_w_0()
        .min_h_0()
        .child(measure)
        .child(panes)
        .into_any_element();
    preview::wrap(s, panes, cx)
}

/// The panes are `width` wide: worker grids take the columns that fit.
fn fit(s: &mut Shell, width: f32, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    if state.width == width {
        return;
    }
    state.width = width;
    let mut changed = state.preview.as_mut().is_some_and(|p| p.fit(width));
    let tree = saved(s);
    if let Some(workers) =
        worker_leaves(&tree).filter(|workers| !workers.is_empty() && automatic(&tree, workers))
    {
        let next = Node::worker_grid(Node::main(), workers, columns(width));
        if next != tree {
            save_saved(s, next);
            changed = true;
        }
    }
    if changed {
        cx.notify();
    }
}

fn node(
    s: &Shell,
    node: &Node,
    main: &mut Option<AnyElement>,
    cx: &mut Context<Shell>,
) -> AnyElement {
    match node {
        Node::Leaf { id, content } => leaf(s, id, content, main, cx),
        Node::Split {
            id,
            vertical,
            ratio,
            children,
        } => {
            let (vertical, ratio) = (*vertical, *ratio);
            let first = self::node(s, &children[0], main, cx);
            let second = self::node(s, &children[1], main, cx);
            let split = id.clone();
            div()
                .flex()
                .when(vertical, |d| d.flex_row())
                .when(!vertical, |d| d.flex_col())
                .flex_1()
                .size_full()
                .min_w_0()
                .min_h_0()
                .on_drag_move(
                    cx.listener(move |s, event: &DragMoveEvent<Divider>, _, cx| {
                        if event.drag(cx).0 != split {
                            return;
                        }
                        let (at, size) = if vertical {
                            (
                                event.event.position.x - event.bounds.left(),
                                event.bounds.size.width,
                            )
                        } else {
                            (
                                event.event.position.y - event.bounds.top(),
                                event.bounds.size.height,
                            )
                        };
                        let mut tree = tree(s);
                        let size = f32::from(size).max(1.);
                        // The main pane's floor beside a worker grid.
                        let floor = if split == "grid" { MAIN_MIN / size } else { 0. };
                        if tree.resize(&split, (f32::from(at) / size).max(floor)) {
                            if let Some(preview) = s.features.get::<State>().preview.as_mut() {
                                preview.tree = tree;
                                preview.manual = true;
                                return cx.notify();
                            }
                            if let Some(w) = s
                                .state
                                .selected
                                .clone()
                                .and_then(|w| s.state.workspaces.get_mut(&w))
                            {
                                w.panes = Some(tree);
                            }
                            s.features.get::<State>().resizing = true;
                            cx.notify();
                        }
                    }),
                )
                .child(
                    div()
                        .flex()
                        .flex_shrink_0()
                        .min_w_0()
                        .min_h_0()
                        .overflow_hidden()
                        .when(vertical, |d| d.h_full().w(gpui::relative(ratio)))
                        .when(id == "grid", |d| d.min_w(px(MAIN_MIN)))
                        .when(!vertical, |d| d.w_full().h(gpui::relative(ratio)))
                        .child(first),
                )
                .child(divider(id, vertical))
                .child(if id == "grid" {
                    // compactWorkerScrollRows: rows keep a readable height
                    // and the workers scroll beside the full-height main pane.
                    let rows = children[1].rows() as f32;
                    div()
                        .id("pane-grid-workers")
                        .flex_1()
                        .min_w_0()
                        .min_h_0()
                        .overflow_y_scroll()
                        .child(
                            div()
                                .flex()
                                .size_full()
                                .min_h(px(rows * WORKER_ROW_MIN))
                                .child(second),
                        )
                        .into_any_element()
                } else {
                    div()
                        .flex()
                        .flex_1()
                        .min_w_0()
                        .min_h_0()
                        .overflow_hidden()
                        .child(second)
                        .into_any_element()
                })
                .into_any_element()
        }
    }
}

fn divider(id: &str, vertical: bool) -> impl IntoElement {
    let drag = Divider(id.to_owned());
    // Worker cards carry their own edges; only the main pane's divider draws
    // a line.
    let line = !id.starts_with("grid-");
    let group = format!("pane-divider-{id}");
    div()
        .id(SharedString::from(format!("pane-divider-{id}")))
        .debug_selector({
            let id = id.to_owned();
            move || format!("pane-divider-{id}")
        })
        .relative()
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .when(vertical, |d| d.w(px(6.)).h_full().cursor_col_resize())
        .when(!vertical, |d| d.h(px(6.)).w_full().cursor_row_resize())
        .when(line, |d| {
            d.child(
                div()
                    .bg(theme().border)
                    .when(vertical, |d| d.w(px(1.)).h_full())
                    .when(!vertical, |d| d.h(px(1.)).w_full()),
            )
        })
        .child(crate::theme::split_line(group, vertical, 2.5, false))
        .on_drag(drag, |drag, _, _, cx| cx.new(|_| drag.clone()))
}

fn leaf(
    s: &Shell,
    id: &str,
    content: &Leaf,
    main: &mut Option<AnyElement>,
    cx: &mut Context<Shell>,
) -> AnyElement {
    let state = s.features.read::<State>();
    let hover = state
        .and_then(|state| state.hover.clone())
        .filter(|(leaf, _)| leaf == id)
        .map(|(_, zone)| zone);
    let body = match content {
        Leaf::Main => main.take().unwrap_or_else(|| div().into_any_element()),
        Leaf::Worker { agent } if previewing(s).is_some() => preview::card(s, id, agent, cx),
        Leaf::Worker { agent } => worker_card(s, id, agent, cx),
        _ => s
            .content
            .get(&key(s, id))
            .map(Content::element)
            .unwrap_or_else(|| {
                let failed = state.and_then(|state| state.failed.get(id)).cloned();
                div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(12.))
                    .text_color(theme().text_muted)
                    .child(failed.unwrap_or_else(|| match content {
                        Leaf::Terminal { .. } => "Starting terminal…".into(),
                        _ => "Starting chat…".into(),
                    }))
                    .into_any_element()
            }),
    };
    let title = match content {
        Leaf::Main => None,
        Leaf::Chat { session } => Some(
            s.sessions
                .iter()
                .find(|x| &x.id == session)
                .map(|x| crate::pane::title(&x.title))
                .unwrap_or_else(|| "New chat".into()),
        ),
        Leaf::Terminal { .. } => Some("Terminal".into()),
        // A worker's card is its own header.
        Leaf::Worker { .. } => None,
    };
    let (over, dropped) = (id.to_owned(), id.to_owned());
    div()
        .id(SharedString::from(format!("pane-{id}")))
        .debug_selector({
            let id = id.to_owned();
            move || format!("pane-{id}")
        })
        .relative()
        .flex()
        .flex_col()
        .flex_1()
        .size_full()
        .min_w_0()
        .min_h_0()
        .overflow_hidden()
        .when_some(title, |pane, title| {
            let terminal = matches!(content, Leaf::Terminal { .. });
            pane.child(header(id, title, terminal, cx))
        })
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .min_h_0()
                .child(body),
        )
        .on_drag_move({
            let over = over.clone();
            cx.listener(move |s, event: &DragMoveEvent<super::RailPane>, _, cx| {
                // The main chat's own thread doesn't land, so it shows no target.
                if let super::RailPane::Thread { id, .. } = event.drag(cx) {
                    if main_thread(s, cx).as_ref() == Some(id) {
                        return;
                    }
                }
                track(s, &over, event.event.position, event.bounds, cx)
            })
        })
        // A header chat tab dragged here opens its thread beside this pane,
        // as classic's header tabs do.
        .on_drag_move(cx.listener(
            move |s, event: &DragMoveEvent<super::header_tabs::Dragged>, _, cx| {
                if thread_tab(s, event.drag(cx).index, cx).is_some() {
                    track(s, &over, event.event.position, event.bounds, cx)
                }
            },
        ))
        .on_drop(cx.listener(move |s, pane: &super::RailPane, window, cx| {
            let zone = s
                .features
                .get::<State>()
                .hover
                .take()
                .filter(|(leaf, _)| *leaf == dropped)
                .map_or(Zone::Center, |(_, zone)| zone);
            if link_in_composer(s, pane, window.mouse_position(), cx) {
                return;
            }
            s.capture(window, cx);
            split(s, &dropped, zone, pane.clone(), cx);
        }))
        .on_drop({
            let dropped = id.to_owned();
            cx.listener(move |s, tab: &super::header_tabs::Dragged, window, cx| {
                let zone = s.features.get::<State>().hover.take();
                let Some(thread) = thread_tab(s, tab.index, cx) else {
                    return;
                };
                let zone = zone
                    .filter(|(leaf, _)| *leaf == dropped)
                    .map_or(Zone::Center, |(_, zone)| zone);
                s.capture(window, cx);
                split(s, &dropped, zone, thread, cx);
            })
        })
        .when_some(hover, |pane, zone| pane.child(overlay(zone)))
        .into_any_element()
}

/// Shows where a drag over pane `over` would land.
fn track(
    s: &mut Shell,
    over: &str,
    position: gpui::Point<gpui::Pixels>,
    bounds: gpui::Bounds<gpui::Pixels>,
    cx: &mut Context<Shell>,
) {
    // A preview takes no drops, so it shows no drop target.
    if previewing(s).is_some() {
        return;
    }
    let state = s.features.get::<State>();
    let next = if bounds.contains(&position) {
        let x = f32::from(position.x - bounds.left()) / f32::from(bounds.size.width).max(1.);
        let y = f32::from(position.y - bounds.top()) / f32::from(bounds.size.height).max(1.);
        Some((over.to_owned(), Zone::at(x, y)))
    } else if state.hover.as_ref().is_some_and(|(leaf, _)| leaf == over) {
        None
    } else {
        return;
    };
    if state.hover != next {
        state.hover = next;
        cx.notify();
    }
}

/// A thread let go over the main chat's composer becomes context for the next
/// prompt instead of a split. The main chat's own thread has nothing to add.
fn link_in_composer(
    s: &Shell,
    pane: &super::RailPane,
    position: gpui::Point<gpui::Pixels>,
    cx: &mut Context<Shell>,
) -> bool {
    let super::RailPane::Thread { id, title } = pane else {
        return false;
    };
    if main_thread(s, cx).as_ref() == Some(id) {
        return false;
    }
    let Some(tab) = s.active() else { return false };
    let Some(Content::Session(view)) = s.content.get(&s.key(&tab)) else {
        return false;
    };
    view.update(cx, |view, cx| {
        view.take_thread_drop(id, title, position, cx)
    })
}

/// The conversation the main pane shows.
fn main_thread(s: &Shell, cx: &gpui::App) -> Option<String> {
    s.active().and_then(|tab| shown(s, &tab, cx))
}

/// The conversation a chat tab shows: its view's own pick, else its thread.
fn shown(s: &Shell, tab: &Tab, cx: &gpui::App) -> Option<String> {
    let Tab::Session(id) = tab else { return None };
    match s.content.get(&s.key(tab)) {
        Some(Content::Session(view)) => view.read(cx).shown_thread().or_else(|| Some(id.clone())),
        _ => Some(id.clone()),
    }
}

/// The conversation behind header tab `index`, when it is a chat the main
/// pane isn't showing.
fn thread_tab(s: &Shell, index: usize, cx: &gpui::App) -> Option<super::RailPane> {
    let tab = s.current()?.tabs.get(index)?.clone();
    let id = shown(s, &tab, cx)?;
    if main_thread(s, cx).as_ref() == Some(&id) {
        return None;
    }
    let title = s
        .sessions
        .iter()
        .find(|x| x.id == id)
        .map(|x| crate::pane::title(&x.title))
        .unwrap_or_else(|| "New chat".into());
    Some(super::RailPane::Thread {
        id,
        title: title.into(),
    })
}

/// TileContainer's pane header: the pane's name and its close. Dragging it
/// moves the pane, as ThreadChatPane's header does.
fn header(id: &str, title: String, terminal: bool, cx: &mut Context<Shell>) -> impl IntoElement {
    let leaf = id.to_owned();
    let moved = super::RailPane::Move {
        leaf: id.to_owned(),
        title: title.clone().into(),
        terminal,
    };
    div()
        .id(SharedString::from(format!("pane-header-{id}")))
        .debug_selector({
            let id = id.to_owned();
            move || format!("pane-header-{id}")
        })
        .on_drag(moved, |drag, _, _, cx| cx.new(|_| drag.clone()))
        .flex()
        .items_center()
        .gap(px(6.))
        .h(px(34.))
        .flex_shrink_0()
        .pl(px(12.))
        .pr(px(8.))
        .border_b_1()
        .border_color(theme().border)
        .text_size(px(11.))
        .text_color(theme().text_muted)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(title),
        )
        .child(
            div()
                .id(SharedString::from(format!("pane-close-{id}")))
                .debug_selector({
                    let id = id.to_owned();
                    move || format!("pane-close-{id}")
                })
                .cursor_pointer()
                .px(px(6.))
                .rounded(px(4.))
                .hover(|d| d.bg(theme().hover))
                .child("×")
                .on_click(cx.listener(move |s, _, _, cx| close(s, &leaf, cx))),
        )
}

/// TileContainer's drop preview: 45% at an edge, the whole pane at its center.
fn overlay(zone: Zone) -> impl IntoElement {
    let accent = theme().accent;
    let part = gpui::relative(0.45);
    let rest = gpui::relative(0.55);
    div()
        .debug_selector(move || format!("pane-drop-{zone:?}").to_lowercase())
        .absolute()
        .flex()
        .items_center()
        .justify_center()
        .map(|d| match zone {
            Zone::Left => d.top_0().bottom_0().left_0().w(part),
            Zone::Right => d.top_0().bottom_0().left(rest).right_0(),
            Zone::Above => d.left_0().right_0().top_0().h(part),
            Zone::Below => d.left_0().right_0().top(rest).bottom_0(),
            Zone::Center => d.inset_0(),
        })
        .rounded(px(12.))
        .bg(gpui::Rgba { a: 0.13, ..accent })
        .border_1()
        .border_color(accent)
        .text_size(px(13.))
        .text_color(theme().text)
        .child(zone.label())
}

/// A worker card's header facts.
struct Header {
    name: String,
    /// What its color dot is read from.
    color: String,
    meta: String,
    status: String,
    tone: gpui::Rgba,
}

/// A worker's card, real or simulated: its color, name, model, status and
/// close over its body. A click focuses it.
fn card(
    id: &str,
    header: Header,
    focused: bool,
    body: AnyElement,
    cx: &mut Context<Shell>,
) -> AnyElement {
    let (focus, close) = (id.to_owned(), id.to_owned());
    div()
        .id(SharedString::from(format!("pane-worker-{id}")))
        .debug_selector({
            let id = id.to_owned();
            move || format!("pane-worker-{id}")
        })
        .size_full()
        .p(px(5.))
        .child(
            div()
                .size_full()
                .flex()
                .flex_col()
                .overflow_hidden()
                .rounded(px(12.))
                .border_1()
                .border_color(if focused {
                    gpui::Rgba {
                        a: 0.75,
                        ..theme().accent
                    }
                } else {
                    theme().border
                })
                .bg(theme().surface)
                .when(focused, |card| card.shadow_md())
                .child(
                    div()
                        .h(px(34.))
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .gap(px(7.))
                        .pl(px(11.))
                        .pr(px(6.))
                        .border_b_1()
                        .border_color(theme().border)
                        .text_size(px(12.))
                        .child(
                            div()
                                .size(px(7.))
                                .flex_shrink_0()
                                .rounded_full()
                                .bg(crate::subagents::trace::agent_color(&header.color)),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .flex_shrink()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_color(theme().text)
                                .child(header.name),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_size(px(11.))
                                .text_color(theme().text_faint)
                                .child(header.meta),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .flex()
                                .items_center()
                                .gap(px(5.))
                                .text_size(px(11.))
                                .text_color(theme().text_secondary)
                                .child(div().size(px(5.)).rounded_full().bg(header.tone))
                                .child(header.status),
                        )
                        .child(
                            div()
                                .id(SharedString::from(format!("pane-close-{id}")))
                                .debug_selector({
                                    let id = id.to_owned();
                                    move || format!("pane-close-{id}")
                                })
                                .flex_shrink_0()
                                .size(px(22.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(6.))
                                .cursor_pointer()
                                .text_color(theme().text_muted)
                                .hover(|d| d.bg(theme().hover).text_color(theme().text))
                                .child("×")
                                .on_click(cx.listener(move |s, _, _, cx| {
                                    cx.stop_propagation();
                                    self::close(s, &close, cx);
                                })),
                        ),
                )
                .child(body),
        )
        .on_click(cx.listener(move |s, _, _, cx| {
            let state = s.features.get::<State>();
            match state.preview.as_mut() {
                Some(preview) => preview.focused = Some(focus.clone()),
                None => state.focused = Some(focus.clone()),
            }
            cx.notify();
        }))
        .into_any_element()
}

/// A real worker's card: its live transcript and steer box.
fn worker_card(s: &Shell, id: &str, agent: &str, cx: &mut Context<Shell>) -> AnyElement {
    let state = s.features.read::<State>();
    let focused = state.and_then(|state| state.focused.as_deref()) == Some(id);
    let view = state
        .and_then(|state| state.workers.get(&key(s, id)))
        .cloned();
    let Some(view) = view else {
        let header = Header {
            name: agent.to_owned(),
            color: agent.to_owned(),
            meta: String::new(),
            status: String::new(),
            tone: theme().text_faint,
        };
        let body = div()
            .flex_1()
            .px(px(12.))
            .py(px(10.))
            .text_size(px(12.))
            .text_color(theme().text_muted)
            .child("Looking for this worker…")
            .into_any_element();
        return card(id, header, focused, body, cx);
    };
    let pane = view.read(cx);
    let (name, meta, status, tone) = worker::facts(&pane.agent, pane.gone);
    let header = Header {
        color: pane.agent.id.clone(),
        name,
        meta,
        status,
        tone,
    };
    let body = div()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .child(view)
        .into_any_element();
    card(id, header, focused, body, cx)
}
