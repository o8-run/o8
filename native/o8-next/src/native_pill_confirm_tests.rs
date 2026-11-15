//! The confirmation card in the real Pill model: one decision per exact card.
use super::*;

fn future() -> u64 {
    capsules::now_ms() + 60_000
}
fn card(session: u64, id: &str) -> Value {
    json!({"state":"confirm","session":session,"confirm":{
        "id":id,"task":"task-1","kind":"action","summary":"Send the draft to the team"}})
}
fn draw(pill: &Entity<Pill>, frame: Value, visual: &mut gpui::VisualTestContext) {
    pill.update_in(visual, |pill, _, cx| {
        pill.apply(serde_json::from_value(frame).unwrap());
        pill.motion = crate::motion::Transition::settled(160, true);
        cx.notify();
    });
    visual.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}
fn send(pill: &Entity<Pill>, args: Value, visual: &mut gpui::VisualTestContext) -> Value {
    let reply = std::rc::Rc::new(std::cell::RefCell::new(Value::Null));
    let received = reply.clone();
    visual.update(|window, cx| {
        dispatch(
            pill,
            json!({"expiresAt":future(), "args":args}),
            window,
            cx,
            move |value| *received.borrow_mut() = value,
        )
    });
    visual.run_until_parked();
    reply.take()
}
fn click(selector: &'static str, visual: &mut gpui::VisualTestContext) {
    let bounds = visual.debug_bounds(selector).expect(selector);
    visual.simulate_click(bounds.center(), gpui::Modifiers::default());
}

#[gpui::test]
fn a_decision_names_the_exact_card_and_is_reported_once(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    draw(&pill, card(2, "c-1"), visual);
    assert!(visual.debug_bounds("native-dock-confirm").is_some());
    click("native-confirm-allow", visual);
    click("native-confirm-deny", visual);
    click("native-confirm-allow", visual);
    let reply = send(
        &pill,
        json!({"action":"frame","snapshot":card(2, "c-1")}),
        visual,
    );
    assert_eq!(
        reply["actions"],
        json!([{"session":2,"state":"confirm","action":"confirm-allow","value":null,
            "ref":"c-1","task":"task-1"}]),
        "three clicks, one decision"
    );
    assert_eq!(
        pill.read_with(visual, |p, _| p.hit_rects(capsules::now_ms())),
        vec![[420., 8., 96.]]
    );
}

#[gpui::test]
fn a_click_on_a_card_that_has_since_changed_does_nothing(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    draw(&pill, card(2, "c-1"), visual);
    click("native-confirm-deny", visual);
    // A newer card arrives before the reply: the queued decision is dropped.
    let reply = send(
        &pill,
        json!({"action":"frame","snapshot":card(3, "c-2")}),
        visual,
    );
    assert_eq!(reply["actions"], json!([]));
    // The new card takes its own decision.
    pill.update(visual, |pill, _| assert!(pill.decide(true)));
    let reply = send(
        &pill,
        json!({"action":"frame","snapshot":card(3, "c-2")}),
        visual,
    );
    assert_eq!(reply["actions"][0]["ref"], "c-2");
    // Expired or retired cards accept nothing.
    pill.update(visual, |pill, _| {
        pill.heard = Instant::now() - Duration::from_millis(751);
        pill.expire();
        assert!(!pill.decide(true));
    });
    send(
        &pill,
        json!({"action":"frame","snapshot":card(4, "c-3")}),
        visual,
    );
    send(
        &pill,
        json!({"action":"release","session":4,"kind":"confirm"}),
        visual,
    );
    assert!(!pill.read_with(visual, |p, _| p.target));
    pill.update(visual, |pill, _| assert!(!pill.decide(false)));
}

#[gpui::test]
fn plan_cards_list_steps_and_a_card_without_identity_never_shows(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    let plan = json!({"state":"confirm","session":1,"confirm":{"id":"p","task":"t","kind":"plan",
        "summary":"Plan","steps":[{"index":1,"summary":"Read"},{"index":2,"summary":"Write"}]}});
    draw(&pill, plan, visual);
    assert!(visual.debug_bounds("native-confirm-allow").is_some());
    pill.update(visual, |pill, _| {
        pill.apply(
            serde_json::from_value(
                json!({"state":"confirm","session":2,"confirm":{"id":"","task":"t"}}),
            )
            .unwrap(),
        );
        assert!(!pill.target);
    });
}
