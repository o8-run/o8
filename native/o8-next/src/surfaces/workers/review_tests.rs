use super::*;
use crate::shell::test_support::*;

fn open_workers(
    fixture: &Fixture,
    file: PathBuf,
    cx: &mut TestAppContext,
) -> (Entity<Shell>, VisualTestContext, Entity<card::Card>) {
    let (shell, mut visual) = open(fixture.client.clone(), file, State::default(), cx);
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-shift-p");
    visual.simulate_keystrokes("w o r k e r s enter");
    ready(&shell, &mut visual);
    super::tests::click(&mut visual, "workers-filter-2");
    let card = shell.read_with(&visual, |s, cx| {
        let Content::Workers(view) = &s.content[&s.key(&Tab::Workers)] else {
            panic!("Workers")
        };
        view.read(cx).cards["worker-blocked"].clone()
    });
    (shell, visual, card)
}
fn control(fixture: &Fixture, key: &str) -> Value {
    fixture
        .client
        .get("/api/workers-fixture", &[(key, "1")])
        .unwrap()
}
fn receipt(fixture: &Fixture) -> Value {
    fixture.client.get("/api/workers-fixture", &[]).unwrap()
}
fn settle(
    visual: &mut VisualTestContext,
    fixture: &Fixture,
    mut done: impl FnMut(&VisualTestContext) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        visual.run_until_parked();
        visual.update(|window, cx| window.draw(cx).clear());
        if done(visual) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "worker action did not settle: {}",
            receipt(fixture)
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[gpui::test]
fn workers_keep_waiting_retains_fetched_lane_state(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--workers");
    let (_shell, mut visual, card) = open_workers(&fixture, fixture.root.join("review.json"), cx);
    let before = card.read_with(&visual, |c, _| c.revision);
    control(&fixture, "refresh");
    super::tests::click(&mut visual, "worker-wait-worker-blocked");
    settle(&mut visual, &fixture, |v| {
        card.read_with(v, |c, _| !c.action_busy())
    });
    let lane_id = receipt(&fixture)["laneIds"]["worker-blocked"]
        .as_str()
        .unwrap()
        .to_owned();
    let fetched: Value = fixture
        .client
        .get(&format!("/api/lanes/{lane_id}"), &[("events", "0")])
        .unwrap();
    // The GET is real and its status must survive the action, without redispatch.
    assert_eq!(fetched["lane"]["status"], "reviewing");
    assert_eq!(
        card.read_with(&visual, |c, _| c.task.lane["status"].clone()),
        fetched["lane"]["status"]
    );
    assert!(card.read_with(&visual, |c, _| c.revision) > before);
    assert!(receipt(&fixture)["bodies"].as_array().unwrap().is_empty());
}

fn submit_without_draining(visual: &mut VisualTestContext) {
    visual.update(|window, cx| {
        window.dispatch_keystroke(gpui::Keystroke::parse("enter").unwrap(), cx);
    });
}
#[gpui::test]
fn workers_edits_during_delivery_survive_ack(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--workers");
    let file = fixture.root.join("edit-during-delivery.json");
    let (_shell, mut visual, card) = open_workers(&fixture, file.clone(), cx);
    super::tests::click(&mut visual, "worker-adjust-worker-blocked");
    visual.simulate_input("Keep this adjustment");
    submit_without_draining(&mut visual);
    assert!(card.read_with(&visual, |c, _| c.action_busy()));
    let frozen = card.read_with(&visual, |c, _| c.pending.clone()).unwrap();
    visual.update(|window, cx| {
        window.dispatch_keystroke(gpui::Keystroke::parse("space").unwrap(), cx);
    });
    assert_eq!(
        card.read_with(&visual, |c, cx| c.composer.read(cx).text.clone()),
        "Keep this adjustment "
    );
    settle(&mut visual, &fixture, |v| {
        card.read_with(v, |c, _| c.pending.is_none())
    });
    assert_eq!(receipt(&fixture)["deliveries"].as_array().unwrap().len(), 1);
    assert_eq!(receipt(&fixture)["bodies"][0], frozen);
    assert_eq!(
        card.read_with(&visual, |c, cx| c.composer.read(cx).text.clone()),
        "Keep this adjustment ",
        "acknowledgement must preserve the operator's exact edit during delivery"
    );
    let saved: Value =
        serde_json::from_slice(&fs::read(file.with_extension("workers.json")).unwrap()).unwrap();
    assert!(saved.to_string().contains("Keep this adjustment "));
    assert!(
        !saved
            .to_string()
            .contains(frozen["idempotencyKey"].as_str().unwrap())
    );
}

#[gpui::test]
fn workers_workspace_isolation_preserves_peer_draft_during_lane_refresh(cx: &mut TestAppContext) {
    let a = Fixture::start_mode(false, "--workers");
    let b = Fixture::start_mode(false, "--workers");
    let file = a.root.join("shared-workspaces.json");
    let (_shell_a, mut visual_a, card_a) = open_workers(&a, file.clone(), cx);
    super::tests::click(&mut visual_a, "worker-adjust-worker-blocked");
    visual_a.simulate_input("Workspace A draft");
    visual_a.simulate_keystrokes("shift-tab");
    let (_shell_b, mut visual_b, card_b) = open_workers(&b, file.clone(), cx);
    super::tests::click(&mut visual_b, "worker-adjust-worker-blocked");
    visual_b.simulate_input("Workspace B pending draft");
    submit_without_draining(&mut visual_b);
    assert!(card_b.read_with(&visual_b, |c, _| c.action_busy()));
    let pending_b = card_b.read_with(&visual_b, |c, _| c.pending.clone());
    let lane_b = card_b.read_with(&visual_b, |c, _| c.task.lane.clone());
    control(&a, "refresh");
    submit_without_draining(&mut visual_a);
    assert!(card_a.read_with(&visual_a, |c, _| c.action_busy() && c.pending.is_none()));
    assert_eq!(
        card_b.read_with(&visual_b, |c, _| c.pending.clone()),
        pending_b
    );
    assert_eq!(
        card_b.read_with(&visual_b, |c, _| c.task.lane.clone()),
        lane_b
    );
    let saved: Value =
        serde_json::from_slice(&fs::read(file.with_extension("workers.json")).unwrap()).unwrap();
    assert_eq!(
        saved["entries"].as_object().unwrap().len(),
        2,
        "same packet ID in distinct workspaces must have independent persisted drafts"
    );
    assert!(saved.to_string().contains("Workspace A draft"));
    assert!(saved.to_string().contains("Workspace B pending draft"));
    settle(&mut visual_a, &a, |v| {
        card_a.read_with(v, |c, _| !c.action_busy())
    });
    settle(&mut visual_b, &b, |v| {
        card_b.read_with(v, |c, _| c.pending.is_none())
    });
    assert_eq!(
        card_b.read_with(&visual_b, |c, _| c.task.lane.clone()),
        lane_b
    );
    assert_eq!(
        receipt(&b)["deliveries"][0]["message"],
        "Workspace B pending draft"
    );
    assert!(receipt(&a)["bodies"].as_array().unwrap().is_empty());
    assert_eq!(
        card_a.read_with(&visual_a, |c, cx| c.composer.read(cx).text.clone()),
        "Workspace A draft"
    );
    let saved = fs::read_to_string(file.with_extension("workers.json")).unwrap();
    assert!(saved.contains("Workspace A draft"));
    assert!(!saved.contains("Workspace B pending draft"));
    assert_eq!(
        card_a.read_with(&visual_a, |c, _| c.task.lane["status"].clone()),
        "reviewing",
        "refreshing A must retain A's fetched state while B's same-ID card stays isolated"
    );
}
