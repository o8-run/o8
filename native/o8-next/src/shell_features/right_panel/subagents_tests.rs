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
    wait_with_timeout(s, v, selector, Duration::from_secs(20));
}
#[track_caller]
fn wait_with_timeout(
    s: &Entity<Shell>,
    v: &mut VisualTestContext,
    selector: &'static str,
    timeout: Duration,
) {
    let deadline = Instant::now() + timeout;
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
#[track_caller]
fn wait_gone(s: &Entity<Shell>, v: &mut VisualTestContext, selector: &'static str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        s.update_in(v, |s, w, cx| s.tick(false, w, cx));
        v.run_until_parked();
        draw(v);
        if v.debug_bounds(selector).is_none() {
            return;
        }
        assert!(Instant::now() < deadline, "Still visible: {selector}");
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

/// Opens every agent in the Subagents panel from the Activity dock's Agents pane.
fn open_agents(s: &Entity<Shell>, v: &mut VisualTestContext) {
    open_dock_agents(s, v);
    click(v, "activity-agents-all");
}
/// Opens the dock's Agents card and waits out its height animation, so its
/// last row, See all, is inside the card.
fn open_dock_agents(s: &Entity<Shell>, v: &mut VisualTestContext) {
    click(v, "header-activity");
    wait(s, v, "activity-tab-agents");
    click(v, "activity-tab-agents");
    wait(s, v, "activity-agents-all");
    let deadline = Instant::now() + Duration::from_millis(400);
    while Instant::now() < deadline {
        s.update_in(v, |s, w, cx| s.tick(false, w, cx));
        v.run_until_parked();
        draw(v);
        std::thread::sleep(Duration::from_millis(20));
    }
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
    open_agents(&s, &mut v);
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
    open_agents(&s, &mut v);
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
fn subagents_grid_updated_trace_keeps_keyboard_return(cx: &mut TestAppContext) {
    let (f, s, mut v) = setup(cx);
    let repo = s.read_with(&v, |s, _| s.state.selected.clone().unwrap());
    let options = crate::pane_layout::Options {
        size: 1,
        workspace: repo,
        file: f.root.join("subagents.json").with_extension("grid.json"),
    };
    options
        .save(&crate::pane_layout::Layout::new(
            1,
            ["llm-chat:thoughts-review".into()].into_iter(),
        ))
        .unwrap();
    s.update_in(&mut v, |s, w, cx| s.execute(Command::Grid, w, cx));
    ready(&s, &mut v);
    wait(&s, &mut v, "subagent-trace-subagent-calculation");
    click(&mut v, "subagent-trace-subagent-calculation");
    wait(&s, &mut v, "subagents-detail-subagent-calculation");
    let grid = s.read_with(&v, |s, _| {
        let Content::Grid(g) = &s.content[&s.key(&Tab::Grid)] else {
            panic!("Grid")
        };
        g.clone()
    });
    let _: Value = f
        .client
        .get("/api/subagents-fixture", &[("mode", "update-parent")])
        .unwrap();
    let history = f.client.history("llm-chat:thoughts-review").unwrap();
    grid.update_in(&mut v, |g, _, cx| {
        g.panes[0].install(history, f.client.clone());
        g.shell_subagents()
            .unwrap()
            .update(cx, |i, cx| i.tick(true, cx));
        cx.notify();
    });
    wait(&s, &mut v, "subagent-trace-subagent-calculation");
    assert!(grid.read_with(&v, |g, _| g.panes[0].rows.iter().any(|row| {
        matches!(&row.borrow().row, crate::model::Row::Activity { steps, .. }
            if steps.iter().any(|step| step.command.contains("updated.rs")))
    })));
    // A click can land while the inspector still slides in on a slow runner.
    let deadline = Instant::now() + Duration::from_secs(20);
    while v.debug_bounds("subagents-inspector").is_some() {
        assert!(
            Instant::now() < deadline,
            "Still visible: subagents-inspector"
        );
        // The sliding panel outlives its close button by a frame.
        if let Some(close) = v.debug_bounds("subagents-close") {
            v.simulate_click(close.center(), gpui::Modifiers::default());
        }
        s.update_in(&mut v, |s, w, cx| s.tick(false, w, cx));
        v.run_until_parked();
        draw(&mut v);
        std::thread::sleep(Duration::from_millis(20));
    }
    v.simulate_keystrokes("enter");
    wait(&s, &mut v, "subagents-detail-subagent-calculation");
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
    wait_gone(&s, &mut v, "subagents-inspector");
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
    wait_gone(&s, &mut v, "subagents-inspector");
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
    // The shared snapshot's two HTTP reads can lag its transcript under load.
    wait_with_timeout(
        &s,
        &mut v,
        "subagents-group-done-2",
        Duration::from_secs(120),
    );
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
    open_agents(&s, &mut v);
    // See all counts the other chat's running agent too.
    wait(&s, &mut v, "subagents-group-working-2");
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

#[gpui::test]
fn each_opened_subagent_gets_a_tab_and_the_tools_list_them(cx: &mut TestAppContext) {
    assert!(
        Tool::GROUPS[0].1.contains(&Tool::Subagents),
        "every worker is one tool button away"
    );
    let (_f, s, mut v) = setup(cx);
    wait(&s, &mut v, "subagent-trace-subagent-calculation");
    click(&mut v, "subagent-trace-subagent-calculation");
    wait(&s, &mut v, "subagents-detail-subagent-calculation");
    wait(&s, &mut v, "panel-subagent-tab-subagent-calculation");
    click(&mut v, "subagents-back");
    wait(&s, &mut v, "subagent-row-subagent-fruit");
    assert!(
        v.debug_bounds("panel-subagent-tab-subagent-calculation")
            .is_some()
    );
    click(&mut v, "subagent-row-subagent-fruit");
    wait(&s, &mut v, "subagents-detail-subagent-fruit");
    wait(&s, &mut v, "panel-subagent-tab-subagent-fruit");
    assert!(
        v.debug_bounds("panel-subagent-tab-subagent-calculation")
            .is_some()
    );
    click(&mut v, "panel-subagent-subagent-calculation");
    wait(&s, &mut v, "subagents-detail-subagent-calculation");
    assert!(
        v.debug_bounds("panel-subagent-tab-subagent-fruit")
            .is_some()
    );
}

#[gpui::test]
fn native_agents_out_of_title_order_settle_after_one_notify(cx: &mut TestAppContext) {
    let agent = |id: &str, title: &str| crate::subagents::model::Agent {
        shared: false,
        native: true,
        cleanup: None,
        prompt: None,
        run: id.into(),
        id: id.into(),
        title: title.into(),
        runtime: String::new(),
        model: None,
        effort: None,
        parent: None,
        session: None,
        group: crate::subagents::model::Group::Done,
        status: "Done".into(),
        progress: None,
        result: None,
        started: None,
        finished: None,
        facts: Default::default(),
    };
    // An inspector with no transcript behind it, so only this test feeds it.
    let (f, _s, mut v) = setup(cx);
    let client = f.client.clone();
    let view = v.update(|_, cx| {
        cx.new(|cx| {
            crate::subagents::Inspector::new(
                client,
                crate::subagents::model::Scope {
                    repo: "/nowhere".into(),
                    parent: None,
                },
                cx,
            )
        })
    });
    v.run_until_parked();
    let notified = std::rc::Rc::new(std::cell::Cell::new(0));
    let count = notified.clone();
    let _watch = v.update(|_, cx| cx.observe(&view, move |_, _| count.set(count.get() + 1)));
    let agents = vec![agent("a", "Sort fruit"), agent("b", "Quick calculation")];
    for _ in 0..3 {
        let agents = agents.clone();
        view.update(&mut v, |view, cx| view.set_native(agents, cx));
        v.run_until_parked();
    }
    let titles: Vec<String> = view.read_with(&v, |view, _| {
        view.agents
            .iter()
            .filter(|a| a.native)
            .map(|a| a.title.clone())
            .collect()
    });
    assert_eq!(titles, ["Quick calculation", "Sort fruit"]);
    assert_eq!(notified.get(), 1, "the same agents must not notify again");
}

#[gpui::test]
fn the_dock_lists_this_chats_agents_and_see_all_opens_the_workspace(cx: &mut TestAppContext) {
    let (_f, s, mut v) = setup(cx);
    open_dock_agents(&s, &mut v);
    wait(&s, &mut v, "activity-agent-subagent-calculation");
    assert!(
        v.debug_bounds("activity-agent-subagent-unrelated")
            .is_none(),
        "another chat's agent waits behind See all"
    );
    click(&mut v, "activity-agents-all");
    wait(&s, &mut v, "subagent-row-subagent-unrelated");
    assert!(
        v.debug_bounds("subagent-row-subagent-calculation")
            .is_some()
    );
}

#[gpui::test]
fn the_subagents_tool_opens_every_agent(cx: &mut TestAppContext) {
    let (_f, s, mut v) = setup(cx);
    click(&mut v, "header-right-panel");
    wait(&s, &mut v, "panel-tool-subagents");
    click(&mut v, "panel-tool-subagents");
    wait(&s, &mut v, "subagent-row-subagent-unrelated");
    assert!(
        v.debug_bounds("subagent-row-subagent-calculation")
            .is_some()
    );
}

#[gpui::test]
fn see_all_keeps_the_agents_a_chat_read_from_its_transcript(cx: &mut TestAppContext) {
    let (_f, s, mut v) = setup(cx);
    wait(&s, &mut v, "subagent-trace-subagent-calculation");
    let native = crate::subagents::model::Agent {
        shared: false,
        native: true,
        cleanup: None,
        prompt: Some("Check the sums".into()),
        run: "native-sums".into(),
        id: "native-sums".into(),
        title: "Check the sums".into(),
        runtime: String::new(),
        model: None,
        effort: None,
        parent: None,
        session: None,
        group: crate::subagents::model::Group::Working,
        status: "Working".into(),
        progress: None,
        result: None,
        started: None,
        finished: None,
        facts: Default::default(),
    };
    // One update: the chat's transcript observer would replace the injected
    // agent once effects flush, so See all must read it before then.
    s.update_in(&mut v, |s, w, cx| {
        let chat = subagents::chat(s, cx).expect("the chat's inspector");
        chat.update(cx, |chat, cx| {
            let mut agents: Vec<_> = chat.agents.iter().filter(|a| a.native).cloned().collect();
            agents.push(native.clone());
            chat.set_native(agents, cx)
        });
        subagents::all(s, w, cx);
        show(s, Tool::Subagents, w, cx);
    });
    let listed = s.read_with(&v, |s, cx| {
        let repo = s.state.selected.clone().unwrap();
        s.features
            .read::<subagents::Inspectors>()
            .unwrap()
            .workspace[&repo]
            .read(cx)
            .agents
            .iter()
            .any(|a| a.id == "native-sums")
    });
    assert!(listed, "See all lists the chat's transcript agents too");
}

#[gpui::test]
fn the_shown_workspace_list_follows_a_chats_transcript_agents_with_the_dock_closed(
    cx: &mut TestAppContext,
) {
    let (_f, s, mut v) = setup(cx);
    wait(&s, &mut v, "subagent-trace-subagent-calculation");
    s.update_in(&mut v, |s, w, cx| {
        subagents::all(s, w, cx);
        show(s, Tool::Subagents, w, cx);
    });
    let native = |id: &str| crate::subagents::model::Agent {
        shared: false,
        native: true,
        cleanup: None,
        prompt: None,
        run: id.into(),
        id: id.into(),
        title: id.into(),
        runtime: String::new(),
        model: None,
        effort: None,
        parent: None,
        session: None,
        group: crate::subagents::model::Group::Working,
        status: "Working".into(),
        progress: None,
        result: None,
        started: None,
        finished: None,
        facts: Default::default(),
    };
    // A tick with the dock closed, in the same update as the chat's new
    // agent, before its transcript observer replaces it.
    s.update_in(&mut v, |s, w, cx| {
        assert!(!super::super::activity_dock::is_shown(s));
        let chat = subagents::chat(s, cx).expect("the chat's inspector");
        chat.update(cx, |chat, cx| {
            let mut agents: Vec<_> = chat.agents.iter().filter(|a| a.native).cloned().collect();
            agents.push(native("native-late"));
            chat.set_native(agents, cx)
        });
        let _ = w;
        subagents::tick(s, false, cx);
    });
    let listed = s.read_with(&v, |s, cx| {
        let repo = s.state.selected.clone().unwrap();
        s.features
            .read::<subagents::Inspectors>()
            .unwrap()
            .workspace[&repo]
            .read(cx)
            .agents
            .iter()
            .any(|a| a.id == "native-late")
    });
    assert!(listed, "the shown workspace list takes a chat's new agent");
}
