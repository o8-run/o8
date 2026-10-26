use super::*;
use crate::shell::test_support::*;

#[gpui::test]
fn workers_card_activity_reads_real_events_and_keeps_position(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--workers");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("workers-card.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-shift-p");
    visual.simulate_keystrokes("w o r k e r s enter");
    ready(&shell, &mut visual);
    super::tests::click(&mut visual, "workers-filter-2");
    let before = visual
        .debug_bounds("worker-card-worker-blocked")
        .unwrap()
        .origin;
    assert!(
        visual
            .debug_bounds("worker-status-worker-blocked")
            .is_some()
    );
    super::tests::click(&mut visual, "worker-activity-worker-blocked");
    assert!(
        visual
            .debug_bounds("worker-step-worker-blocked-01")
            .is_some()
    );
    assert!(
        visual
            .debug_bounds("worker-step-worker-blocked-03")
            .is_some()
    );
    assert_eq!(
        visual
            .debug_bounds("worker-card-worker-blocked")
            .unwrap()
            .origin,
        before
    );
    let view = shell.read_with(&visual, |s, _| {
        let Content::Workers(v) = s.content.get(&s.key(&Tab::Workers)).unwrap() else {
            panic!("Workers")
        };
        v.clone()
    });
    let card = view.read_with(&visual, |v, _| v.cards["worker-blocked"].clone());
    assert!(card.read_with(&visual, |c, _| c.expanded));
    super::tests::click(&mut visual, "worker-activity-worker-blocked");
    assert!(!card.read_with(&visual, |c, _| c.expanded));
    assert_eq!(
        visual
            .debug_bounds("worker-card-worker-blocked")
            .unwrap()
            .origin,
        before
    );
    let receipt: Value = fixture.client.get("/api/workers-fixture", &[]).unwrap();
    let lane = receipt["laneIds"]["worker-blocked"].as_str().unwrap();
    assert!(receipt["calls"].as_array().unwrap().iter().any(|v| {
        v.as_str()
            .unwrap()
            .eq(&format!("GET /api/lanes/{lane}?events=500"))
    }));
}

fn review_open(
    option: &str,
    cx: &mut TestAppContext,
) -> (Fixture, Entity<View>, VisualTestContext) {
    let fixture = Fixture::start_mode(false, option);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("worker-review.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-shift-p");
    visual.simulate_keystrokes("w o r k e r s enter");
    ready(&shell, &mut visual);
    let view = shell.read_with(&visual, |s, _| {
        let Content::Workers(v) = s.content.get(&s.key(&Tab::Workers)).unwrap() else {
            panic!("Workers")
        };
        v.clone()
    });
    (fixture, view, visual)
}

#[gpui::test]
fn workers_enter_keeps_arrow_navigation_inside_card(cx: &mut TestAppContext) {
    let (_fixture, view, mut visual) = review_open("--workers --workers-navigation", cx);
    visual.simulate_keystrokes("down enter");
    visual.run_until_parked();
    draw(&mut visual);
    let first = view.read_with(&visual, |v, _| v.cards["worker-running"].clone());
    assert!(first.read_with(&visual, |c, _| c.expanded));
    visual.simulate_keystrokes("down");
    draw(&mut visual);
    assert_eq!(
        view.read_with(&visual, |v, _| v.selected.clone())
            .as_deref(),
        Some("worker-running-next"),
        "Down must leave the expanded card and select its next peer"
    );
    visual.simulate_keystrokes("up");
    draw(&mut visual);
    assert_eq!(
        view.read_with(&visual, |v, _| v.selected.clone())
            .as_deref(),
        Some("worker-running")
    );
}

#[gpui::test]
fn workers_clicked_activity_selects_card_before_enter_and_down(cx: &mut TestAppContext) {
    let (_fixture, view, mut visual) = review_open("--workers --workers-navigation", cx);
    visual.simulate_keystrokes("down");
    draw(&mut visual);
    assert_eq!(
        view.read_with(&visual, |v, _| v.selected.clone())
            .as_deref(),
        Some("worker-running"),
        "card A starts selected"
    );
    super::tests::click(&mut visual, "worker-activity-worker-running-next");
    let clicked = view.read_with(&visual, |v, _| v.selected.clone());
    visual.simulate_keystrokes("enter down");
    draw(&mut visual);
    assert_eq!(
        view.read_with(&visual, |v, _| v.selected.clone())
            .as_deref(),
        Some("worker-running-third"),
        "A selected, click B Activity, Enter, Down must select C"
    );
    assert_eq!(
        clicked.as_deref(),
        Some("worker-running-next"),
        "Activity must select B before handling its click"
    );
    assert!(visual.update(|window, cx| {
        view.read(cx).cards["worker-running-third"]
            .read(cx)
            .focus
            .is_focused(window)
    }));
}

#[gpui::test]
fn workers_escape_returns_focus_to_list(cx: &mut TestAppContext) {
    let (_fixture, view, mut visual) = review_open("--workers", cx);
    visual.simulate_keystrokes("down enter");
    visual.run_until_parked();
    draw(&mut visual);
    visual.simulate_keystrokes("escape");
    assert!(
        visual.update(|window, cx| view.read(cx).focus.is_focused(window)),
        "Escape must return focus from Activity to the list"
    );
    visual.simulate_keystrokes("right");
    draw(&mut visual);
    assert_eq!(view.read_with(&visual, |v, _| v.filter), 1);
}

#[gpui::test]
fn workers_latest_progress_survives_more_than_500_events_and_refresh(cx: &mut TestAppContext) {
    let (fixture, view, mut visual) = review_open("--workers --workers-long-activity", cx);
    super::tests::click(&mut visual, "workers-filter-2");
    super::tests::click(&mut visual, "worker-activity-worker-blocked");
    let card = view.read_with(&visual, |v, _| v.cards["worker-blocked"].clone());
    let latest = |card: &card::Card| {
        card.activity
            .iter()
            .filter_map(|event| event["payload"]["message"].as_str())
            .next_back()
            .map(str::to_owned)
    };
    assert_eq!(
        card.read_with(&visual, |c, _| latest(c)).as_deref(),
        Some("Progress 515"),
        "the newest persisted progress must be reachable beyond the first page"
    );
    assert_eq!(card.read_with(&visual, |c, _| c.activity.len()), 500);
    let _: Value = fixture
        .client
        .get("/api/workers-fixture", &[("progress", "1")])
        .unwrap();
    visual.simulate_keystrokes("escape f5");
    visual.run_until_parked();
    draw(&mut visual);
    assert_eq!(
        card.read_with(&visual, |c, _| latest(c)).as_deref(),
        Some("Progress after refresh")
    );
    let receipt: Value = fixture.client.get("/api/workers-fixture", &[]).unwrap();
    let lane = receipt["laneIds"]["worker-blocked"].as_str().unwrap();
    assert!(
        receipt["calls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|call| call == &format!("GET /api/lanes/{lane}?events=500"))
    );
}
