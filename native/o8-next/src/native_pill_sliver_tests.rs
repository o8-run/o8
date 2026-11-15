//! The resting sliver and its Voice settings double click in the real Pill model.
use super::*;

fn future() -> u64 {
    capsules::now_ms() + 60_000
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
fn double_click(visual: &mut gpui::VisualTestContext) {
    let at = visual.debug_bounds("native-dock-capsule").unwrap().center();
    for count in 1..=2 {
        visual.simulate_event(gpui::MouseDownEvent {
            position: at,
            button: gpui::MouseButton::Left,
            modifiers: gpui::Modifiers::default(),
            click_count: count,
            first_mouse: false,
        });
        visual.simulate_event(gpui::MouseUpEvent {
            position: at,
            button: gpui::MouseButton::Left,
            modifiers: gpui::Modifiers::default(),
            click_count: count,
        });
    }
}

#[gpui::test]
fn the_sliver_reports_voice_settings_on_a_double_click_only(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    let sliver = json!({"state":"sliver","session":1,"holdMs":5000});
    draw(&pill, sliver.clone(), visual);
    assert_eq!(
        pill.read_with(visual, |p, _| p.hit_rects(capsules::now_ms())),
        vec![[128., 8., 16.]]
    );
    let bounds = visual.debug_bounds("native-dock-capsule").unwrap();
    visual.simulate_click(bounds.center(), gpui::Modifiers::default());
    let reply = send(&pill, json!({"action":"frame","snapshot":sliver}), visual);
    assert_eq!(reply["actions"], json!([]), "a single click does nothing");
    double_click(visual);
    let reply = send(&pill, json!({"action":"frame","snapshot":sliver}), visual);
    assert_eq!(
        reply["actions"],
        json!([{"session":1,"state":"sliver","action":"voice-settings","value":null}])
    );
    // The fleet orbit is the resting dock too: one expand per click, then settings.
    let orbit =
        json!({"state":"workers","session":2,"holdMs":5000,"workers":{"count":1,"working":1}});
    draw(&pill, orbit.clone(), visual);
    double_click(visual);
    let reply = send(&pill, json!({"action":"frame","snapshot":orbit}), visual);
    let actions: Vec<_> = reply["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["action"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        actions,
        ["workers-expand", "workers-expand", "voice-settings"]
    );
    // Nothing else accepts it, and a stale sliver accepts nothing.
    draw(
        &pill,
        json!({"state":"speaking","session":3,"speed":1.0}),
        visual,
    );
    pill.update(visual, |pill, _| assert!(!pill.act("voice-settings", None)));
    draw(
        &pill,
        json!({"state":"sliver","session":4,"holdMs":5000}),
        visual,
    );
    pill.update(visual, |pill, _| {
        pill.heard = Instant::now() - Duration::from_millis(5001);
        pill.expire();
        assert!(!pill.act("voice-settings", None));
    });
}
