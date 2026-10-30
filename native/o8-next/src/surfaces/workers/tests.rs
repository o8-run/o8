use super::*;
use crate::shell::test_support::*;

pub(super) fn click(cx: &mut VisualTestContext, selector: &'static str) {
    draw(cx);
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("Missing {selector}"));
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
}

#[gpui::test]
fn workers_real_shell_filters_route_membership(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--workers");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("workers.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("w o r k e r s enter");
    ready(&shell, &mut visual);
    assert!(visual.debug_bounds("worker-card-worker-running").is_some());
    assert!(visual.debug_bounds("worker-card-worker-blocked").is_none());
    click(&mut visual, "workers-filter-2");
    assert!(visual.debug_bounds("worker-card-worker-blocked").is_some());
    click(&mut visual, "worker-card-worker-blocked");
    shell.read_with(&visual, |s, cx| {
        let Content::Workers(v) = s.content.get(&s.key(&Tab::Workers)).unwrap() else {
            panic!("Workers")
        };
        assert_eq!(v.read(cx).filter, 2);
        assert_eq!(v.read(cx).selected.as_deref(), Some("worker-blocked"));
    });
    click(&mut visual, "workers-filter-1");
    assert!(visual.debug_bounds("worker-card-worker-review").is_some());
    click(&mut visual, "workers-compact");
    click(&mut visual, "workers-filter-0");
    assert!(visual.debug_bounds("worker-card-worker-running").is_some());
}

#[gpui::test]
fn workers_live_route_retains_cards_selection_and_filter_scroll(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--workers");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("workers.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("w o r k e r s enter");
    ready(&shell, &mut visual);
    let view = shell.read_with(&visual, |s, _| {
        let Content::Workers(view) = s.content.get(&s.key(&Tab::Workers)).unwrap() else {
            panic!("Workers view")
        };
        view.clone()
    });
    let card = view.read_with(&visual, |v, _| v.cards["worker-running"].clone());
    click(&mut visual, "worker-card-worker-running");
    let offset = view.read_with(&visual, |v, _| v.scroll[0].offset());
    click(&mut visual, "workers-filter-2");
    click(&mut visual, "workers-filter-0");
    view.read_with(&visual, |v, _| {
        assert_eq!(v.selected.as_deref(), Some("worker-running"));
        assert_eq!(v.scroll[0].offset(), offset);
        assert_eq!(v.cards["worker-running"], card);
    });
    let before = card.read_with(&visual, |c, _| c.revision);
    let _: Value = fixture
        .client
        .get("/api/workers-fixture", &[("block", "1")])
        .unwrap();
    view.update(&mut visual, |v, cx| v.tick(false, cx));
    for _ in 0..40 {
        visual.run_until_parked();
        draw(&mut visual);
        if card.read_with(&visual, |c, _| c.task.filter == 2) {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    // A tick after five seconds first starts the periodic catalog scan. Drive
    // the following production tick too, so the event subscription starts
    // after that scan has completed, as it does in the running shell.
    view.update(&mut visual, |v, cx| v.tick(false, cx));
    visual.run_until_parked();
    draw(&mut visual);
    assert_eq!(
        card.read_with(&visual, |c, _| c.task.filter),
        2,
        "lane event must refetch the server projection"
    );
    assert!(card.read_with(&visual, |c, _| c.revision) > before);
    view.read_with(&visual, |v, cx| {
        assert_eq!(v.cards["worker-running"], card);
        assert_eq!(
            v.cards["worker-review"].read(cx).revision,
            0,
            "unchanged card must stay retained"
        );
        assert_eq!(v.selected.as_deref(), Some("worker-running"));
    });
    let receipt: Value = fixture.client.get("/api/workers-fixture", &[]).unwrap();
    assert!(receipt["calls"].as_array().unwrap().iter().any(|v| {
        v.as_str()
            .unwrap()
            .starts_with("GET /api/orchestrator/lane-events?")
    }));
}
