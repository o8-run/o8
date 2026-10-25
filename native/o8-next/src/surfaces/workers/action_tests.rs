use super::*;
use crate::shell::test_support::*;

fn task(cx: &mut TestAppContext) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let fixture = Fixture::start_mode(false, "--workers");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("worker-actions.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-shift-p");
    visual.simulate_keystrokes("w o r k e r s enter");
    ready(&shell, &mut visual);
    super::tests::click(&mut visual, "workers-filter-2");
    (fixture, shell, visual)
}
fn receipt(fixture: &Fixture) -> Value {
    fixture.client.get("/api/workers-fixture", &[]).unwrap()
}

#[gpui::test]
fn workers_inspect_conflict_opens_real_worktree_diff(cx: &mut TestAppContext) {
    let (fixture, _shell, mut visual) = task(cx);
    super::tests::click(&mut visual, "worker-inspect-worker-blocked");
    assert!(
        visual.debug_bounds("diff-file-0").is_some(),
        "Inspect must paint the production diff in the native viewer"
    );
    let value = receipt(&fixture);
    let call = value["calls"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .find(|s| s.starts_with("GET /api/worktrees/diff?"))
        .unwrap();
    let url = url::Url::parse(&format!("http://fixture{}", &call[4..])).unwrap();
    assert!(
        url.query_pairs()
            .any(|(key, path)| key == "worktreePath" && path == value["repo"].as_str().unwrap())
    );
    assert!(
        url.query_pairs()
            .any(|(key, base)| key == "baseBranch" && base == "main")
    );
}

#[gpui::test]
fn workers_keep_waiting_reads_current_lane_and_preserves_queue(cx: &mut TestAppContext) {
    let (fixture, _shell, mut visual) = task(cx);
    let before: Value = fixture.client.get("/api/orchestrator/state", &[]).unwrap();
    super::tests::click(&mut visual, "worker-wait-worker-blocked");
    let after: Value = fixture.client.get("/api/orchestrator/state", &[]).unwrap();
    let packet = |v: &Value| {
        v["mission"]["packets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "worker-blocked")
            .unwrap()["queueState"]
            .clone()
    };
    assert_eq!(packet(&after), packet(&before));
    let value = receipt(&fixture);
    let lane = value["laneIds"]["worker-blocked"].as_str().unwrap();
    assert!(
        value["calls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c == &format!("GET /api/lanes/{lane}?events=0"))
    );
    assert!(
        value["bodies"].as_array().unwrap().is_empty(),
        "waiting must never resume or redispatch"
    );
}

#[gpui::test]
fn workers_adjust_uses_desktop_steer_route_and_operator_provenance(cx: &mut TestAppContext) {
    let (fixture, _shell, mut visual) = task(cx);
    super::tests::click(&mut visual, "worker-adjust-worker-blocked");
    visual.simulate_input("Check ownership before editing");
    super::tests::click(&mut visual, "worker-send-worker-blocked");
    let value = receipt(&fixture);
    let body = &value["bodies"][0];
    assert_eq!(body["packetId"], "worker-blocked");
    assert_eq!(body["message"], "Check ownership before editing");
    assert_eq!(body["source"], "operator");
    assert!(!body["idempotencyKey"].as_str().unwrap().is_empty());
    assert_eq!(value["deliveries"].as_array().unwrap().len(), 1);
    assert_eq!(value["deliveries"][0]["message"], body["message"]);
}

#[gpui::test]
fn workers_adjust_lost_response_reuses_one_persisted_steer(cx: &mut TestAppContext) {
    let (fixture, _shell, mut visual) = task(cx);
    let _: Value = fixture
        .client
        .get("/api/workers-fixture", &[("drop", "1")])
        .unwrap();
    super::tests::click(&mut visual, "worker-adjust-worker-blocked");
    visual.simulate_input("Adjust once");
    super::tests::click(&mut visual, "worker-send-worker-blocked");
    super::tests::click(&mut visual, "worker-send-worker-blocked");
    let value = receipt(&fixture);
    assert_eq!(value["bodies"].as_array().unwrap().len(), 2);
    assert_eq!(
        value["bodies"][0], value["bodies"][1],
        "retry must send the same frozen body and identity"
    );
    assert_eq!(
        value["deliveries"].as_array().unwrap().len(),
        1,
        "the production idempotency store must prevent a second steer"
    );
}

#[gpui::test]
fn workers_actions_are_reachable_by_tab_and_enter(cx: &mut TestAppContext) {
    let (fixture, _shell, mut visual) = task(cx);
    visual.simulate_keystrokes("tab enter");
    visual.run_until_parked();
    draw(&mut visual);
    assert!(visual.debug_bounds("diff-file-0").is_some());
    assert!(
        receipt(&fixture)["calls"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .any(|call| call.starts_with("GET /api/worktrees/diff?"))
    );
}
