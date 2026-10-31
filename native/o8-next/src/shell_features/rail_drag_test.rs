use super::*;
use crate::pane_tree::{Leaf, Node};
use crate::shell::test_support::*;
use gpui::{Modifiers, MouseButton};
struct RailDragTests;
register_shell_feature!(RailDragTests);
impl ShellFeature for RailDragTests {}

fn bounds(v: &mut VisualTestContext, id: &str) -> Bounds<gpui::Pixels> {
    draw(v);
    v.debug_bounds(Box::leak(id.to_owned().into_boxed_str()))
        .unwrap_or_else(|| panic!("missing {id}"))
}
fn settle(v: &mut VisualTestContext) {
    let until = Instant::now() + Duration::from_millis(300);
    while Instant::now() < until {
        v.run_until_parked();
        draw(v);
        std::thread::sleep(Duration::from_millis(10));
    }
}
/// Presses `id`, drags it to `to`, and returns the drop preview shown just
/// before letting go.
fn drag(
    v: &mut VisualTestContext,
    id: &str,
    to: gpui::Point<gpui::Pixels>,
) -> Option<&'static str> {
    let from = bounds(v, id).center();
    v.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    let nudge = from + gpui::point(px(12.), px(0.));
    v.simulate_mouse_move(nudge, Some(MouseButton::Left), Modifiers::default());
    draw(v);
    v.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::default());
    draw(v);
    let shown = [
        "pane-drop-left",
        "pane-drop-right",
        "pane-drop-above",
        "pane-drop-below",
        "pane-drop-center",
    ]
    .into_iter()
    .find(|id| v.debug_bounds(id).is_some());
    v.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    settle(v);
    shown
}
fn panes(s: &Entity<Shell>, v: &VisualTestContext) -> Option<Node> {
    s.read_with(v, |s, _| s.current().and_then(|w| w.panes.clone()))
}

#[gpui::test]
fn rail_drags_split_workspace_panes_like_classic(cx: &mut TestAppContext) {
    let f = Fixture::start(true);
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("rail-drag.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    v.simulate_resize(size(px(1600.), px(1000.)));
    settle(&mut v);
    let chat = s.read_with(&v, |s, _| s.active());
    assert!(matches!(chat, Some(Tab::Session(_))), "{chat:?}");
    assert_eq!(panes(&s, &v), None);

    // Run terminal near the main pane's right edge splits it side by side.
    let main = bounds(&mut v, "pane-main");
    let right = gpui::point(main.right() - px(20.), main.center().y);
    assert_eq!(
        drag(&mut v, "rail-terminal", right),
        Some("pane-drop-right")
    );
    assert!(
        v.debug_bounds("pane-drop-right").is_none(),
        "the preview clears on drop"
    );
    assert_eq!(
        s.read_with(&v, |s, _| s.active()),
        chat,
        "the main pane keeps its tab"
    );
    let Some(Node::Split {
        vertical: true,
        children,
        ..
    }) = panes(&s, &v)
    else {
        panic!("no side-by-side split: {:?}", panes(&s, &v));
    };
    let [
        Node::Leaf { id: first, .. },
        Node::Leaf {
            id: terminal,
            content,
        },
    ] = &*children
    else {
        panic!("{children:?}");
    };
    assert_eq!(first, "main");
    assert!(matches!(content, Leaf::Terminal { .. }), "{content:?}");
    bounds(&mut v, &format!("pane-close-{terminal}"));

    // Run orchestrator near the terminal pane's bottom splits it top and bottom
    // with a new chat on the lead.
    let pane = bounds(&mut v, &format!("pane-{terminal}"));
    let below = gpui::point(pane.center().x, pane.bottom() - px(20.));
    assert_eq!(
        drag(&mut v, "rail-orchestrator", below),
        Some("pane-drop-below")
    );
    let tree = panes(&s, &v).unwrap();
    let leaves = tree.leaves();
    assert_eq!(leaves.len(), 3, "{tree:?}");
    let (chat_pane, Leaf::Chat { session }) = leaves[2] else {
        panic!("{tree:?}");
    };
    assert!(session.starts_with("thoughts-next-"), "{session}");
    let chat_pane = chat_pane.to_owned();
    let record: Value = f
        .client
        .get("/api/v2/chat-history", &[("tabId", session.as_str())])
        .unwrap();
    let workspace = s.read_with(&v, |s, _| s.state.selected.clone()).unwrap();
    assert_eq!(record["repoPath"], workspace);

    // The divider resizes; the layout saves when the drag ends.
    let Node::Split { id: outer, .. } = &tree else {
        panic!()
    };
    let divider = bounds(&mut v, &format!("pane-divider-{outer}")).center();
    v.simulate_mouse_down(divider, MouseButton::Left, Modifiers::default());
    v.simulate_mouse_move(
        divider + gpui::point(px(8.), px(0.)),
        Some(MouseButton::Left),
        Modifiers::default(),
    );
    draw(&mut v);
    let to = gpui::point(main.left() + main.size.width * 0.3, divider.y);
    v.simulate_mouse_move(to, Some(MouseButton::Left), Modifiers::default());
    draw(&mut v);
    v.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    settle(&mut v);
    let Some(Node::Split { ratio, .. }) = panes(&s, &v) else {
        panic!()
    };
    assert!((0.25..0.35).contains(&ratio), "{ratio}");
    let saved: Value =
        serde_json::from_slice(&fs::read(f.root.join("rail-drag.json")).unwrap()).unwrap();
    let selected = saved["selected"].as_str().unwrap();
    let saved_ratio = saved["workspaces"][selected]["panes"]["ratio"]
        .as_f64()
        .unwrap();
    assert!(
        (saved_ratio - ratio as f64).abs() < 1e-4,
        "{saved_ratio} vs {ratio}"
    );

    // Closing panes returns their space; the last one leaves no split.
    for pane in [&chat_pane, terminal] {
        let close = bounds(&mut v, &format!("pane-close-{pane}")).center();
        v.simulate_click(close, Modifiers::default());
        settle(&mut v);
    }
    assert_eq!(panes(&s, &v), None);
    assert!(v.debug_bounds("pane-main").is_some());

    // A click still opens in place.
    let terminal_button = bounds(&mut v, "rail-terminal").center();
    v.simulate_click(terminal_button, Modifiers::default());
    settle(&mut v);
    assert_eq!(s.read_with(&v, |s, _| s.active()), Some(Tab::Terminal));
}

#[gpui::test]
fn sidebar_threads_and_pane_headers_drag_like_classic(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("thread-drag.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    v.simulate_resize(size(px(1600.), px(1000.)));
    settle(&mut v);
    let list = s.read_with(&v, |s, _| s.surfaces.sidebar.view.as_ref().unwrap().clone());
    let start = Instant::now();
    let (row, thread) = loop {
        settle(&mut v);
        let found = list.read_with(&v, |l, _| {
            l.rows
                .iter()
                .enumerate()
                .find_map(|(i, r)| r.id.clone().map(|id| (i, id)))
        });
        if let Some(found) = found {
            break found;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "no sidebar thread"
        );
    };

    // A sidebar thread dropped near the main pane's right edge opens beside it.
    let main = bounds(&mut v, "pane-main");
    let right = gpui::point(main.right() - px(20.), main.center().y);
    assert_eq!(
        drag(&mut v, &format!("thread-row-{row}"), right),
        Some("pane-drop-right")
    );
    let Some(Node::Split { children, .. }) = panes(&s, &v) else {
        panic!("no split: {:?}", panes(&s, &v));
    };
    let [
        Node::Leaf { id: first, .. },
        Node::Leaf { id: pane, content },
    ] = &*children
    else {
        panic!("{children:?}");
    };
    assert_eq!(first, "main");
    assert_eq!(
        content,
        &Leaf::Chat {
            session: thread.clone()
        }
    );
    let pane = pane.clone();

    // Its header drags the pane to the main pane's left, keeping its id.
    let main = bounds(&mut v, "pane-main");
    let left = gpui::point(main.left() + px(20.), main.center().y);
    assert_eq!(
        drag(&mut v, &format!("pane-header-{pane}"), left),
        Some("pane-drop-left")
    );
    let Some(Node::Split { children, .. }) = panes(&s, &v) else {
        panic!("moved pane lost: {:?}", panes(&s, &v));
    };
    let ids: Vec<_> = children.iter().map(|c| c.id().to_owned()).collect();
    assert_eq!(ids, [pane.clone(), "main".to_owned()]);
    assert_eq!(panes(&s, &v).unwrap().leaves().len(), 2);

    // A header chat tab dropped near a pane's bottom opens its thread below
    // it and stays in the header, as in classic.
    let tabs = s.read_with(&v, |s, _| s.current().unwrap().tabs.clone());
    let (index, session) = tabs
        .iter()
        .enumerate()
        .find_map(|(i, t)| match t {
            Tab::Session(id) => Some((i, id.clone())),
            _ => None,
        })
        .expect("a chat tab");
    let moved = bounds(&mut v, &format!("pane-{pane}"));
    let below = gpui::point(moved.center().x, moved.bottom() - px(20.));
    assert_eq!(
        drag(&mut v, &format!("surface-tab-{index}"), below),
        Some("pane-drop-below")
    );
    let tree = panes(&s, &v).unwrap();
    let leaves = tree.leaves();
    assert_eq!(leaves.len(), 3, "{tree:?}");
    assert_eq!(leaves[1].1, &Leaf::Chat { session }, "{tree:?}");
    assert_eq!(
        s.read_with(&v, |s, _| s.current().unwrap().tabs.clone()),
        tabs
    );
}

#[gpui::test]
fn header_play_menu_items_drag_onto_panes_like_classic(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("play-drag.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    v.simulate_resize(size(px(1600.), px(1000.)));
    settle(&mut v);
    let play = bounds(&mut v, "header-play").center();
    v.simulate_click(play, Modifiers::default());
    settle(&mut v);
    bounds(&mut v, "header-play-menu");

    // Terminal leaves the menu for the main pane's bottom edge; the menu closes.
    let main = bounds(&mut v, "pane-main");
    let below = gpui::point(main.center().x, main.bottom() - px(20.));
    assert_eq!(
        drag(&mut v, "header-play-terminal", below),
        Some("pane-drop-below")
    );
    assert!(
        v.debug_bounds("header-play-menu").is_none(),
        "the menu closes"
    );
    let Some(Node::Split {
        vertical: false,
        children,
        ..
    }) = panes(&s, &v)
    else {
        panic!("no stacked split: {:?}", panes(&s, &v));
    };
    let [Node::Leaf { id: first, .. }, Node::Leaf { content, .. }] = &*children else {
        panic!("{children:?}");
    };
    assert_eq!(first, "main");
    assert!(matches!(content, Leaf::Terminal { .. }), "{content:?}");
}
