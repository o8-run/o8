//! User paths through the shell, retained traces and persisted mission state.
use super::*;
use crate::shell::test_support::*;
use crate::shell::test_support::open;

fn click(v: &mut VisualTestContext, selector: &'static str) {
    draw(v);
    let bounds = v
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("Missing {selector}"));
    v.simulate_click(bounds.center(), gpui::Modifiers::default());
    v.run_until_parked();
    draw(v);
}
fn wait(s: &Entity<Shell>, v: &mut VisualTestContext, selector: &'static str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        s.update_in(v, |s, w, cx| s.tick(true, w, cx));
        v.run_until_parked();
        draw(v);
        if v.debug_bounds(selector).is_some() {
            return;
        }
        assert!(Instant::now() < deadline, "Missing {selector}");
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn setup(cx: &mut TestAppContext) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let f = Fixture::start_mode(false, "--subagents");
    let state = crate::shell_state::State {
        bounds: [0., 0., 1680., 1050.],
        ..Default::default()
    };
    let (s, mut v) = open(f.client.clone(), f.root.join("subagents.json"), state, cx);
    v.simulate_resize(gpui::size(px(1680.), px(1050.)));
    ready(&s, &mut v);
    s.update_in(&mut v, |s, w, cx| {
        s.execute(Command::Session("thoughts-review".into()), w, cx)
    });
    ready(&s, &mut v);
    (f, s, v)
}

#[gpui::test]
fn subagents_trace_opens_detail_without_replacing_steps_or_parent(cx: &mut TestAppContext) {
    let (f, s, mut v) = setup(cx);
    let (tab, main) = s.read_with(&v, |s, _| {
        let tab = s.active().unwrap();
        let Content::Session(view) = &s.content[&s.key(&tab)] else {
            panic!("chat")
        };
        (tab, view.clone())
    });
    main.update_in(&mut v, |view, w, cx| view.shell_focus(true, w, cx));
    v.simulate_input("Keep my parent draft");
    wait(&s, &mut v, "subagent-trace-subagent-calculation");
    click(&mut v, "subagent-trace-subagent-calculation");
    wait(&s, &mut v, "subagents-detail-subagent-calculation");
    assert_eq!(s.read_with(&v, |s, _| s.active()), Some(tab));
    assert_eq!(
        main.read_with(&v, |main, cx| main.shell_issue_state(cx)["draft"].clone()),
        "Keep my parent draft"
    );
    click(&mut v, "subagents-back");
    wait(&s, &mut v, "subagents-group-working-1");
    assert!(v.debug_bounds("subagents-group-attention-1").is_some());
    assert!(v.debug_bounds("subagents-group-done-1").is_some());
    assert!(v.debug_bounds("subagent-row-subagent-unrelated").is_none());
    click(&mut v, "subagent-row-subagent-fruit");
    wait(&s, &mut v, "subagents-detail-subagent-fruit");
    click(&mut v, "subagents-copy");
    assert_eq!(
        v.read_from_clipboard().unwrap().text().unwrap(),
        "apple, banana, cherry, mango, pear"
    );
    let snapshot: Value = f.client.get("/api/subagents-fixture", &[]).unwrap();
    assert!(
        snapshot["calls"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c.as_str().unwrap().starts_with("GET ")),
        "inspection must not dispatch or steer work"
    );
}

#[gpui::test]
fn subagents_shared_panel_refreshes_counts_and_keeps_error_recovery(cx: &mut TestAppContext) {
    let (f, s, mut v) = setup(cx);
    wait(&s, &mut v, "header-subagents");
    click(&mut v, "header-subagents");
    wait(&s, &mut v, "subagents-group-working-1");
    let _: Value = f
        .client
        .get("/api/subagents-fixture", &[("mode", "done")])
        .unwrap();
    click(&mut v, "subagents-refresh");
    wait(&s, &mut v, "subagents-group-done-2");
    let _: Value = f
        .client
        .get("/api/subagents-fixture", &[("mode", "fail")])
        .unwrap();
    click(&mut v, "subagents-refresh");
    wait(&s, &mut v, "subagents-error");
    assert!(
        v.debug_bounds("subagents-group-done-2").is_some(),
        "last known work remains readable on a failed refresh"
    );
    let _: Value = f
        .client
        .get("/api/subagents-fixture", &[("mode", "ready")])
        .unwrap();
    click(&mut v, "subagents-refresh");
    wait(&s, &mut v, "subagents-current");
    click(&mut v, "subagents-search");
    v.simulate_input("Sort fruit");
    draw(&mut v);
    assert!(v.debug_bounds("subagent-row-subagent-fruit").is_some());
    assert!(v.debug_bounds("subagent-row-subagent-sentence").is_none());
}
