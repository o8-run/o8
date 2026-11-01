//! User paths through the shell, retained traces and persisted mission state.
use super::*;
use crate::shell::test_support::open;
use crate::shell::test_support::*;

#[track_caller]
fn click(v: &mut VisualTestContext, selector: &'static str) {
    draw(v);
    let bounds = v
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("Missing {selector}"));
    v.simulate_click(bounds.center(), gpui::Modifiers::default());
    v.run_until_parked();
    draw(v);
}
#[track_caller]
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
    setup_mode(cx, "--subagents")
}
fn setup_mode(cx: &mut TestAppContext, mode: &str) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let f = Fixture::start_mode(false, mode);
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
    let original_steps = main.read_with(&v, |m, _| m.shell_steps().0);
    assert!(
        original_steps
            .iter()
            .any(|s| s.command.contains("preserved.rs"))
    );
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
    click(&mut v, "subagents-close");
    s.update_in(&mut v, |s, w, cx| s.tick(false, w, cx));
    assert!(!s.read_with(&v, |s, _| s.state.right_panel.visible));
    assert_eq!(
        original_steps,
        main.read_with(&v, |m, _| m.shell_steps().0),
        "the inspector must extend the existing trace without replacing its steps"
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

fn wait_probe(s: &Entity<Shell>, v: &mut VisualTestContext, ready: impl Fn(&Value) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        s.update_in(v, |s, w, cx| s.tick(false, w, cx));
        v.run_until_parked();
        draw(v);
        let data = s.read_with(v, |s, cx| subagents::probe(s, cx));
        if ready(&data) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "Inspector did not settle: {data}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[gpui::test]
fn subagents_late_history_cannot_restore_cleared_detail(cx: &mut TestAppContext) {
    let (f, s, mut v) = setup(cx);
    click(&mut v, "header-subagents");
    wait(&s, &mut v, "subagent-row-subagent-calculation");
    let inspector = s.read_with(&v, |s, cx| {
        let tab = s.active().unwrap();
        let Content::Session(view) = &s.content[&s.key(&tab)] else {
            panic!("chat")
        };
        view.read(cx).shell_subagents().unwrap()
    });
    // Queue the production read, then leave detail before its completion can
    // run on the foreground executor. Blocking HTTP cannot be held across
    // run_until_parked in GPUI's deterministic test executor.
    inspector.update_in(&mut v, |i, w, cx| {
        i.inspect(Some("subagent-calculation".into()), w, cx);
        i.inspect(None, w, cx);
    });
    v.run_until_parked();
    wait(&s, &mut v, "subagent-row-subagent-calculation");
    let detail = s.read_with(&v, |s, cx| subagents::probe(s, cx));
    assert!(detail["selected"].is_null());
    assert_eq!(
        detail["rows"],
        Value::Null,
        "an old read cannot restore a cleared transcript"
    );
    assert!(detail["readyImages"].is_null());
    let snapshot: Value = f.client.get("/api/subagents-fixture", &[]).unwrap();
    assert!(
        snapshot["calls"].as_array().unwrap().iter().any(|call| {
            let call = call.as_str().unwrap();
            call.starts_with("GET /api/mobile/history")
                && call.contains("thoughts-subagent-calculation")
        }),
        "the cleared selection must still exercise a real history read"
    );
}

#[gpui::test]
fn subagents_transcript_loads_images_and_retries_earlier_history(cx: &mut TestAppContext) {
    let (f, s, mut v) = setup(cx);
    wait(&s, &mut v, "subagent-trace-subagent-calculation");
    click(&mut v, "subagent-trace-subagent-calculation");
    wait(&s, &mut v, "subagents-load-older");
    wait_probe(&s, &mut v, |p| p["readyImages"] == 1);
    let _: Value = f
        .client
        .get("/api/subagents-fixture", &[("mode", "fail-page")])
        .unwrap();
    click(&mut v, "subagents-load-older");
    wait(&s, &mut v, "subagents-retry-history");
    let _: Value = f
        .client
        .get("/api/subagents-fixture", &[("mode", "ready-page")])
        .unwrap();
    click(&mut v, "subagents-retry-history");
    wait_probe(&s, &mut v, |p| {
        p["rows"].as_u64().is_some_and(|n| n >= 124) && p["detailPending"] == false
    });
    assert!(v.debug_bounds("subagents-load-older").is_none());
    assert_eq!(
        s.read_with(&v, |s, cx| subagents::probe(s, cx)["readyImages"].clone()),
        1
    );
}

#[gpui::test]
fn subagents_grid_follows_focused_parent_and_fits_compact_window(cx: &mut TestAppContext) {
    let (f, s, mut v) = setup(cx);
    let repo = s.read_with(&v, |s, _| s.state.selected.clone().unwrap());
    let options = crate::pane_layout::Options {
        size: 2,
        workspace: repo,
        file: f.root.join("subagents.json").with_extension("grid.json"),
    };
    options
        .save(&crate::pane_layout::Layout::new(
            2,
            [
                "llm-chat:thoughts-review".into(),
                "llm-chat:thoughts-tools".into(),
            ]
            .into_iter(),
        ))
        .unwrap();
    s.update_in(&mut v, |s, w, cx| s.execute(Command::Grid, w, cx));
    ready(&s, &mut v);
    click(&mut v, "header-subagents");
    wait(&s, &mut v, "subagent-row-subagent-calculation");
    let grid = s.read_with(&v, |s, _| {
        let Content::Grid(g) = &s.content[&s.key(&Tab::Grid)] else {
            panic!("Grid")
        };
        g.clone()
    });
    grid.update_in(&mut v, |g, w, cx| g.shell_focus(w, cx));
    v.simulate_keystrokes("ctrl-alt-right");
    wait(&s, &mut v, "subagent-row-subagent-unrelated");
    assert!(
        v.debug_bounds("subagent-row-subagent-calculation")
            .is_none(),
        "a focused grid parent must not retain another parent's agents"
    );
    v.simulate_resize(gpui::size(px(900.), px(700.)));
    s.update_in(&mut v, |s, w, cx| s.tick(false, w, cx));
    draw(&mut v);
    let bounds = v
        .debug_bounds("subagents-inspector")
        .expect("compact inspector remains reachable");
    assert!(bounds.right() <= px(900.) && bounds.bottom() <= px(700.));
    click(&mut v, "subagents-close");
}

#[gpui::test]
fn subagents_side_chat_returns_to_its_parent_and_split(cx: &mut TestAppContext) {
    let (_f, s, mut v) = setup(cx);
    s.update_in(&mut v, |s, w, cx| {
        s.execute(Command::Session("thoughts-tools".into()), w, cx);
        let repo = s.state.selected.clone().unwrap();
        s.state
            .right_panel
            .side_chats
            .insert(repo, "thoughts-review".into());
        show(s, Tool::SideChat, w, cx);
        s.features.get::<Panel>().into_lower = true;
        show(s, Tool::Targeting, w, cx);
    });
    wait(&s, &mut v, "subagent-trace-subagent-calculation");
    let side = s.read_with(&v, |s, _| {
        let Content::Session(view) = &s.content[&key(s, Tool::SideChat)] else {
            panic!("side chat")
        };
        view.clone()
    });
    side.update_in(&mut v, |side, w, cx| side.shell_focus(true, w, cx));
    v.simulate_input("Side draft");
    click(&mut v, "subagent-trace-subagent-calculation");
    wait(&s, &mut v, "subagents-detail-subagent-calculation");
    click(&mut v, "subagents-close");
    s.update_in(&mut v, |s, w, cx| s.tick(false, w, cx));
    assert!(s.read_with(&v, |s, _| s.state.right_panel.visible));
    assert!(s.read_with(&v, |s, _| {
        let p = s.features.read::<Panel>().unwrap();
        p.selected == Tool::SideChat && p.lower == Some(Tool::Targeting)
    }));
    assert_eq!(
        side.read_with(&v, |side, cx| side.shell_issue_state(cx)["draft"].clone()),
        "Side draft",
        "inspection must preserve the side chat's draft"
    );
    v.simulate_keystrokes("enter");
    wait(&s, &mut v, "subagents-detail-subagent-calculation");
}

#[gpui::test]
fn subagents_workers_action_returns_keyboard_focus_to_its_card(cx: &mut TestAppContext) {
    let (_f, s, mut v) = setup(cx);
    s.update_in(&mut v, |s, w, cx| s.execute(Command::Workers, w, cx));
    wait(&s, &mut v, "worker-inspect-agent-subagent-calculation");
    click(&mut v, "worker-inspect-agent-subagent-calculation");
    wait(&s, &mut v, "subagents-detail-subagent-calculation");
    assert_eq!(s.read_with(&v, |s, _| s.active()), Some(Tab::Workers));
    v.simulate_keystrokes("escape");
    wait(&s, &mut v, "subagent-row-subagent-calculation");
    v.simulate_keystrokes("escape");
    s.update_in(&mut v, |s, w, cx| s.tick(false, w, cx));
    assert!(!s.read_with(&v, |s, _| s.state.right_panel.visible));
    v.simulate_keystrokes("enter");
    wait(&s, &mut v, "subagents-detail-subagent-calculation");
}

#[gpui::test]
fn subagents_lower_split_keeps_its_slot_and_original_return_layout(cx: &mut TestAppContext) {
    let (_f, s, mut v) = setup(cx);
    s.update_in(&mut v, |s, w, cx| {
        show(s, Tool::Targeting, w, cx);
        s.features.get::<Panel>().into_lower = true;
        show(s, Tool::Subagents, w, cx);
    });
    wait(&s, &mut v, "subagent-row-subagent-calculation");
    click(&mut v, "subagent-row-subagent-calculation");
    wait(&s, &mut v, "subagents-detail-subagent-calculation");
    assert!(
        s.read_with(&v, |s, _| {
            let panel = s.features.read::<Panel>().unwrap();
            panel.selected == Tool::Targeting && panel.lower == Some(Tool::Subagents)
        }),
        "detail must stay in the lower inspector slot"
    );
    click(&mut v, "subagents-close");
    s.update_in(&mut v, |s, w, cx| s.tick(false, w, cx));
    assert!(
        s.read_with(&v, |s, _| {
            let panel = s.features.read::<Panel>().unwrap();
            panel.selected == Tool::Targeting && panel.lower.is_none() && panel.motion.is_open()
        }),
        "close must restore the tools from before inspection"
    );
}

#[gpui::test]
fn subagents_shared_results_keep_held_delivery_in_attention(cx: &mut TestAppContext) {
    let (f, s, mut v) = setup_mode(cx, "--subagents --subagents-shared");
    wait(&s, &mut v, "subagent-trace-opencode-owned:subagent-shared");
    click(&mut v, "subagent-trace-opencode-owned:subagent-shared");
    wait(
        &s,
        &mut v,
        "subagents-detail-opencode-owned:subagent-shared",
    );
    wait_probe(&s, &mut v, |p| p["rows"].as_u64().is_some_and(|n| n > 0));
    click(&mut v, "subagents-back");
    wait(&s, &mut v, "subagents-group-done-2");
    let _: Value = f
        .client
        .get("/api/subagents-fixture", &[("mode", "held")])
        .unwrap();
    click(&mut v, "subagents-refresh");
    wait(&s, &mut v, "subagents-group-attention-2");
    assert!(v.debug_bounds("subagents-group-done-1").is_some());
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
