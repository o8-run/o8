use super::*;

fn uncertain(fixture: &Fixture, surface: &Entity<Surface>, cx: &mut VisualTestContext) {
    let _: Value = fixture.client.get("/fixture/fail-next", &[]).unwrap();
    surface.update(cx, |s, cx| {
        s.composer.update(cx, |i, cx| {
            i.set_text("Uncertain original send", cx);
            i.controls.prompt.prelude = "Keep this normal-chat prompt".into();
        });
        s.send(None, cx);
    });
    settle(surface, cx);
    assert_eq!(
        surface.read_with(cx, |s, _| s.pending.len()),
        1,
        "pre-acceptance 503 preserves the cached request"
    );
    surface.update(cx, |s, cx| s.reconcile(cx));
    for _ in 0..200 {
        cx.run_until_parked();
        draw(cx);
        if surface.read_with(cx, |s, _| !s.queued_items().is_empty()) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("held uncertain send was not loaded from the production queue");
}
fn click_queue(selector: &'static str, surface: &Entity<Surface>, cx: &mut VisualTestContext) {
    draw(cx);
    let bounds = cx.debug_bounds(selector).expect(selector);
    cx.simulate_click(bounds.center(), Modifiers::default());
    settle(surface, cx);
}
fn send_fresh(surface: &Entity<Surface>, cx: &mut VisualTestContext) {
    surface.update(cx, |s, cx| {
        s.composer
            .update(cx, |i, cx| i.set_text("A different next draft", cx));
        s.send(None, cx);
    });
    settle(surface, cx);
}

#[gpui::test]
fn bot_network_native_composer_removal_retires_only_the_confirmed_cached_send(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start();
    let (surface, cx) = open(cx, &fixture);
    uncertain(&fixture, &surface, cx);
    click_queue("remove-queued", &surface, cx);
    surface.read_with(cx, |s, cx| {
        assert!(s.pending.is_empty());
        assert_eq!(s.composer.read(cx).text, "Uncertain original send");
        assert_eq!(
            s.composer.read(cx).controls.prompt.prelude,
            "Keep this normal-chat prompt"
        );
    });
    send_fresh(&surface, cx);
    let state: Value = fixture.client.get("/fixture/state", &[]).unwrap();
    assert_eq!(state["messages"].as_array().unwrap().len(), 3);
    assert_eq!(state["messages"][2]["text"], "A different next draft");
    assert!(
        state["intents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["status"] == "cancelled")
    );
    assert_eq!(
        surface.read_with(cx, |s, cx| s
            .composer
            .read(cx)
            .controls
            .prompt
            .prelude
            .clone()),
        "Keep this normal-chat prompt"
    );
}

#[gpui::test]
fn bot_network_native_composer_retry_retires_its_cached_send_and_keeps_a_separate_draft(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start();
    let (surface, cx) = open(cx, &fixture);
    uncertain(&fixture, &surface, cx);
    surface.update(cx, |s, cx| {
        s.composer
            .update(cx, |i, cx| i.set_text("A different next draft", cx))
    });
    click_queue("retry-network-send", &surface, cx);
    surface.read_with(cx, |s, cx| {
        assert!(s.pending.is_empty());
        assert_eq!(s.composer.read(cx).text, "A different next draft");
    });
    let answer: Value = fixture.client.get("/fixture/answer", &[]).unwrap();
    assert_eq!(answer["ok"], true);
    surface.update(cx, |s, cx| s.send(None, cx));
    settle(&surface, cx);
    let state: Value = fixture.client.get("/fixture/state", &[]).unwrap();
    assert_eq!(state["messages"].as_array().unwrap().len(), 5);
    assert_eq!(state["messages"][4]["text"], "A different next draft");
}

#[gpui::test]
fn bot_network_native_composer_terminal_rejection_retires_a_previous_uncertain_identity(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::start();
    let (surface, cx) = open(cx, &fixture);
    uncertain(&fixture, &surface, cx);
    let _: Value = fixture.client.get("/fixture/disconnect", &[]).unwrap();
    surface.update(cx, |s, cx| s.send(None, cx));
    settle(&surface, cx);
    assert!(surface.read_with(cx, |s, _| s.pending.is_empty()));
    let _: Value = fixture.client.get("/fixture/reconnect", &[]).unwrap();
    send_fresh(&surface, cx);
    let state: Value = fixture.client.get("/fixture/state", &[]).unwrap();
    assert_eq!(state["messages"].as_array().unwrap().len(), 3);
    assert_eq!(state["messages"][2]["text"], "A different next draft");
}
