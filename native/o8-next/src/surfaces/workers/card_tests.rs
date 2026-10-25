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
            .starts_with(&format!("GET /api/lanes/{lane}/events?"))
    }));
}
