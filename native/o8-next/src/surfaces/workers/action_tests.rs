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

#[gpui::test]
fn workers_lost_steer_reopens_with_same_key_and_draft(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual) = task(cx);
    let state_file = fixture.root.join("worker-actions.json");
    let _: Value = fixture.client.get("/api/workers-fixture", &[("drop", "1")]).unwrap();
    super::tests::click(&mut visual, "worker-adjust-worker-blocked");
    visual.simulate_input("Retain this adjustment");
    super::tests::click(&mut visual, "worker-send-worker-blocked");
    let first = receipt(&fixture)["bodies"][0].clone();
    assert_eq!(receipt(&fixture)["deliveries"].as_array().unwrap().len(), 1);
    visual.simulate_keystrokes("ctrl-w"); visual.run_until_parked(); draw(&mut visual);
    assert!(shell.read_with(&visual, |s, _| !s.content.contains_key(&s.key(&Tab::Workers))), "the original Workers entity must be removed");

    // A fresh shell has no retained Card, runtime slot or in-memory request.
    let (fresh, mut reopened) = open(fixture.client.clone(), state_file.clone(), State::load(&state_file).unwrap(), cx);
    ready(&fresh, &mut reopened);
    reopened.simulate_keystrokes("ctrl-shift-p"); reopened.simulate_keystrokes("w o r k e r s enter"); ready(&fresh, &mut reopened);
    let view = fresh.read_with(&reopened, |s, _| { let Content::Workers(v) = s.content.get(&s.key(&Tab::Workers)).unwrap() else { panic!("Workers") }; v.clone() });
    let card = view.read_with(&reopened, |v, _| v.cards["worker-blocked"].clone());
    assert_eq!(card.read_with(&reopened, |c, cx| c.composer.read(cx).text.clone()), "Retain this adjustment", "an unconfirmed draft must survive closing Workers");
    assert_eq!(card.read_with(&reopened, |c, _| c.pending.clone()), Some(first.clone()), "reopening must retain the original idempotency identity");
    let private_file = state_file.with_extension("workers.json");
    let saved: Value = serde_json::from_slice(&fs::read(&private_file).unwrap()).unwrap();
    assert!(saved.to_string().contains(first["idempotencyKey"].as_str().unwrap()));
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&private_file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    super::tests::click(&mut reopened, "worker-adjust-worker-running"); reopened.simulate_input("Separate task draft");
    view.read_with(&reopened, |v, _| v.scroll[v.filter].scroll_to_bottom()); draw(&mut reopened);
    super::tests::click(&mut reopened, "worker-send-worker-blocked");
    let replay = receipt(&fixture);
    assert_eq!(replay["bodies"].as_array().unwrap().len(), 2);
    assert_eq!(replay["bodies"][1], first);
    assert_eq!(replay["deliveries"].as_array().unwrap().len(), 1, "reopening must not deliver another steer");
    assert!(card.read_with(&reopened, |c, _| c.pending.is_none()));
    assert!(card.read_with(&reopened, |c, cx| c.composer.read(cx).text.is_empty()));
    let saved = fs::read_to_string(&private_file).unwrap();
    assert!(!saved.contains(first["idempotencyKey"].as_str().unwrap()), "only a confirmed response may release the pending key");
    assert!(saved.contains("Separate task draft"), "confirming one card must retain another card's draft");
}
