// The main pane beside a chat pane: its close hands its place to that chat,
// and closing its last tab does the same, so it never sits empty beside it.
use super::*;
use crate::shell::test_support::*;
use gpui::Modifiers;

fn setup(cx: &mut TestAppContext) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let f = Fixture::start(false);
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("main-pane.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    v.simulate_resize(size(px(1600.), px(1000.)));
    s.update_in(&mut v, |s, w, cx| {
        s.execute(Command::Session("thoughts-composer-first".into()), w, cx)
    });
    ready(&s, &mut v);
    let mut tree = Node::main();
    tree.split(
        MAIN,
        Zone::Left,
        "pane-side".into(),
        Leaf::Chat {
            session: "thoughts-composer-second".into(),
        },
    );
    s.update_in(&mut v, |s, _, cx| {
        save_saved(s, tree);
        cx.notify();
    });
    ready(&s, &mut v);
    (f, s, v)
}
fn tabs(s: &Entity<Shell>, v: &VisualTestContext) -> (Vec<Tab>, Option<Tab>) {
    s.read_with(v, |s, _| (s.current().unwrap().tabs.clone(), s.active()))
}

#[gpui::test]
fn closing_the_main_pane_hands_its_place_to_the_chat_beside_it(cx: &mut TestAppContext) {
    let (_f, s, mut v) = setup(cx);
    draw(&mut v);
    let close = v
        .debug_bounds("pane-close-main")
        .expect("the main pane shows a close beside a chat pane");
    v.simulate_click(close.center(), Modifiers::default());
    ready(&s, &mut v);
    assert!(s.read_with(&v, |s, _| s.current().unwrap().panes.is_none()));
    let (tabs, active) = tabs(&s, &v);
    assert_eq!(
        active,
        Some(Tab::Session("thoughts-composer-second".into()))
    );
    assert!(
        tabs.contains(&Tab::Session("thoughts-composer-first".into())),
        "the main pane's own tab stays"
    );
    draw(&mut v);
    assert!(
        v.debug_bounds("pane-header-main").is_none(),
        "alone, it has no header"
    );
}

#[gpui::test]
fn closing_the_last_tab_brings_the_side_chat_into_the_main_pane(cx: &mut TestAppContext) {
    let (_f, s, mut v) = setup(cx);
    let count = tabs(&s, &v).0.len();
    for _ in 0..count {
        s.update_in(&mut v, |s, w, cx| {
            super::super::header::close_tab(s, 0, w, cx)
        });
    }
    s.update_in(&mut v, |s, w, cx| s.tick(true, w, cx));
    ready(&s, &mut v);
    assert!(s.read_with(&v, |s, _| s.current().unwrap().panes.is_none()));
    assert_eq!(
        tabs(&s, &v),
        (
            vec![Tab::Session("thoughts-composer-second".into())],
            Some(Tab::Session("thoughts-composer-second".into()))
        )
    );
}

#[gpui::test]
fn offline_the_side_chat_waits_instead_of_being_closed(cx: &mut TestAppContext) {
    let (_f, s, mut v) = setup(cx);
    let count = tabs(&s, &v).0.len();
    s.update_in(&mut v, |s, w, cx| {
        s.connected = false;
        for _ in 0..count {
            super::super::header::close_tab(s, 0, w, cx);
        }
    });
    // The panes' own tick, so no reconnect can land in between.
    for _ in 0..5 {
        s.update_in(&mut v, |s, w, cx| ensure(s, w, cx));
        v.run_until_parked();
    }
    assert!(
        s.read_with(&v, |s, _| side_chat(&saved(s)).is_some()),
        "no tab can open offline, so the chat keeps its pane"
    );
    s.update_in(&mut v, |s, w, cx| {
        s.connected = true;
        ensure(s, w, cx)
    });
    ready(&s, &mut v);
    assert!(s.read_with(&v, |s, _| s.current().unwrap().panes.is_none()));
}

#[gpui::test]
fn an_info_toast_sits_below_the_split_pane_headers(cx: &mut TestAppContext) {
    // From #5580: the stack covered the right pane's header controls.
    let (_f, s, mut v) = setup(cx);
    let id = s.update_in(&mut v, |_, _, cx| {
        crate::shell::toasts::show(
            crate::shell::toasts::Kind::Info,
            "Copied.",
            vec![],
            None,
            cx,
        )
    });
    v.run_until_parked();
    v.cx.executor().advance_clock(Duration::from_millis(250));
    v.run_until_parked();
    draw(&mut v);
    let header = v
        .debug_bounds("pane-header-main")
        .expect("split panes show headers");
    let toast = v
        .debug_bounds(Box::leak(format!("toast-{id}").into_boxed_str()))
        .expect("the toast shows");
    assert!(
        toast.right() > header.left(),
        "the toast is over the right pane"
    );
    assert!(
        toast.top() >= header.bottom(),
        "the toast starts below the pane header ({:?} vs {:?})",
        toast.top(),
        header.bottom()
    );
}
