use super::*;
use crate::pane_tree::{Leaf, MAIN, Node, Zone};
use gpui::{DragMoveEvent, SharedString};
use std::collections::{HashMap, HashSet};
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
}

#[derive(Default)]
struct State {
    /// The pane a rail drag is over, and where on it.
    hover: Option<(String, Zone)>,
    /// Terminal panes whose shell is being reserved, or failed to start.
    starting: HashSet<String>,
    failed: HashMap<String, String>,
    resizing: bool,
}

/// A dragged divider, by its split's id.
#[derive(Clone)]
struct Divider(String);
impl Render for Divider {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

fn workspace(s: &Shell) -> String {
    s.state.selected.clone().unwrap_or_default()
}
fn key(s: &Shell, leaf: &str) -> String {
    format!("pane|{}|{leaf}", workspace(s))
}
fn tree(s: &Shell) -> Node {
    s.current()
        .and_then(|w| w.panes.clone())
        .unwrap_or_else(Node::main)
}
fn save_tree(s: &mut Shell, tree: Node) {
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
                let client = s.client.in_workspace(&ws);
                let (ws, session) = (ws.clone(), session.clone());
                let view =
                    cx.new(|cx| super::super::terminal::View::pinned(client, ws, session, cx));
                s.content.insert(key, Content::Terminal(view));
            }
            Leaf::Terminal { session: None } => start_terminal(s, id.to_owned(), cx),
        }
    }
}

/// Reserves a pane's own shell, which it keeps across restarts.
fn start_terminal(s: &mut Shell, leaf: String, cx: &mut Context<Shell>) {
    let state = s.features.get::<State>();
    if state.failed.contains_key(&leaf) || !state.starting.insert(leaf.clone()) {
        return;
    }
    let ws = workspace(s);
    let client = s.client.in_workspace(&ws);
    let owner = format!("o8-next:{ws}:pane:{leaf}");
    let task = cx
        .background_executor()
        .spawn(async move { client.create_terminal(&ws, &owner) });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |s, cx| {
            s.features.get::<State>().starting.remove(&leaf);
            match result {
                Ok(session) => {
                    let mut tree = tree(s);
                    if let Some(Leaf::Terminal { session: slot }) = tree.leaf_mut(&leaf) {
                        *slot = Some(session);
                        save_tree(s, tree);
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
    let leaf = match pane {
        super::RailPane::Chat => match s.start_thread(false, cx) {
            Some(session) => Leaf::Chat { session },
            None => return,
        },
        super::RailPane::Terminal => Leaf::Terminal { session: None },
        super::RailPane::Thread { id, .. } => Leaf::Chat { session: id },
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
    let mut tree = tree(s);
    if tree.close(leaf) {
        let key = key(s, leaf);
        s.content.remove(&key);
        let state = s.features.get::<State>();
        state.failed.remove(leaf);
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
    node(s, &tree, &mut main, cx)
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
                        if tree.resize(&split, f32::from(at) / f32::from(size).max(1.)) {
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
                        .when(!vertical, |d| d.w_full().h(gpui::relative(ratio)))
                        .child(first),
                )
                .child(divider(id, vertical))
                .child(
                    div()
                        .flex()
                        .flex_1()
                        .min_w_0()
                        .min_h_0()
                        .overflow_hidden()
                        .child(second),
                )
                .into_any_element()
        }
    }
}

fn divider(id: &str, vertical: bool) -> impl IntoElement {
    let drag = Divider(id.to_owned());
    div()
        .id(SharedString::from(format!("pane-divider-{id}")))
        .debug_selector({
            let id = id.to_owned();
            move || format!("pane-divider-{id}")
        })
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .when(vertical, |d| d.w(px(6.)).h_full().cursor_col_resize())
        .when(!vertical, |d| d.h(px(6.)).w_full().cursor_row_resize())
        .child(
            div()
                .bg(theme().border)
                .when(vertical, |d| d.w(px(1.)).h_full())
                .when(!vertical, |d| d.h(px(1.)).w_full()),
        )
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
                track(s, &over, event.event.position, event.bounds, cx)
            })
        })
        // A header chat tab dragged here opens its thread beside this pane,
        // as classic's header tabs do.
        .on_drag_move(cx.listener(
            move |s, event: &DragMoveEvent<super::header_tabs::Dragged>, _, cx| {
                if thread_tab(s, event.drag(cx).index).is_some() {
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
            s.capture(window, cx);
            split(s, &dropped, zone, pane.clone(), cx);
        }))
        .on_drop({
            let dropped = id.to_owned();
            cx.listener(move |s, tab: &super::header_tabs::Dragged, window, cx| {
                let zone = s.features.get::<State>().hover.take();
                let Some(thread) = thread_tab(s, tab.index) else {
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

/// The thread behind header tab `index`, when it is a chat.
fn thread_tab(s: &Shell, index: usize) -> Option<super::RailPane> {
    let tab = s.current()?.tabs.get(index)?.clone();
    let Tab::Session(id) = tab else { return None };
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
