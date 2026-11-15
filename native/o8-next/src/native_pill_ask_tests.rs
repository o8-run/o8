//! The Ask panel in the real Pill model: drawing, intents and stale clicks.
use super::*;

fn future() -> u64 {
    capsules::now_ms() + 60_000
}
fn ask_frame(session: u64, rev: u64) -> Value {
    json!({"state":"ask","session":session,"ask":{"rev":rev,"listening":false,"turns":[
        {"index":0,"role":"user","text":"What changed?"},
        {"index":1,"role":"assistant","text":"Two things:\n\n- the **chip**\n- the `glint`","sources":"1 source · Notes"}
    ]}})
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
fn ask_panel_draws_the_thread_and_reports_close_and_copy_once(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    draw(&pill, ask_frame(3, 7), visual);
    assert!(visual.debug_bounds("native-dock-ask").is_some());
    assert!(visual.debug_bounds("native-ask-close").is_some());
    assert!(visual.debug_bounds("native-ask-copy-1").is_some());
    assert!(
        visual.debug_bounds("native-ask-copy-0").is_none(),
        "only answers copy"
    );
    click("native-ask-copy-1", visual);
    click("native-ask-close", visual);
    let reply = send(
        &pill,
        json!({"action":"frame","snapshot":ask_frame(3, 7)}),
        visual,
    );
    assert_eq!(
        reply["actions"],
        json!([
            {"session":3,"state":"ask","action":"ask-copy","value":1,"ref":"7"},
            {"session":3,"state":"ask","action":"ask-close","value":null,"ref":"7"}
        ])
    );
    let again = send(
        &pill,
        json!({"action":"frame","snapshot":ask_frame(3, 7)}),
        visual,
    );
    assert_eq!(again["actions"], json!([]), "reported once");
    assert_eq!(
        pill.read_with(visual, |p, _| p.hit_rects(capsules::now_ms())),
        vec![[420., 8., 380.]]
    );
    assert_eq!(
        pill.read_with(visual, |p, _| ask::panel_height(&p.snapshot)),
        452.
    );
}

#[gpui::test]
fn a_click_on_a_thread_that_has_since_changed_is_dropped(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    draw(&pill, ask_frame(3, 7), visual);
    click("native-ask-copy-1", visual);
    // The queue is cleared on a new Ask session, so the copy never reaches the web.
    let reply = send(
        &pill,
        json!({"action":"frame","snapshot":ask_frame(4, 1)}),
        visual,
    );
    assert_eq!(reply["actions"], json!([]));
    // A copy names the revision it was drawn for; the web drops it when the
    // thread has moved on (useNativeDictationPill), and the panel never offers
    // a copy for a turn that is not an answer on screen.
    pill.update(visual, |pill, _| {
        assert!(!pill.ask_act("ask-copy", Some(0)));
        assert!(!pill.ask_act("ask-copy", Some(9)));
        assert!(pill.ask_act("ask-copy", Some(1)));
        assert_eq!(pill.actions[0]["ref"], "1");
    });
    // After the lease expires nothing is accepted.
    pill.update(visual, |pill, _| {
        pill.heard = Instant::now() - Duration::from_millis(751);
        pill.expire();
        assert!(!pill.ask_act("ask-close", None));
        assert!(pill.take_actions().is_empty());
    });
}

#[gpui::test]
fn activity_is_reported_at_most_once_per_reply(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    draw(&pill, ask_frame(3, 7), visual);
    pill.update(visual, |pill, _| {
        assert!(pill.ask_act("ask-active", None));
        assert!(!pill.ask_act("ask-active", None));
    });
    let reply = send(
        &pill,
        json!({"action":"frame","snapshot":ask_frame(3, 7)}),
        visual,
    );
    assert_eq!(reply["actions"].as_array().unwrap().len(), 1);
    pill.update(visual, |pill, _| assert!(pill.ask_act("ask-active", None)));
}

#[gpui::test]
fn a_pending_turn_finishes_dictation_from_the_panel_and_listening_is_click_through(
    cx: &mut TestAppContext,
) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    let mut frame = ask_frame(5, 2);
    frame["ask"]["pending"] = json!({"phase":"listening","text":"and the"});
    draw(&pill, frame.clone(), visual);
    click("native-dock-ask", visual);
    let reply = send(&pill, json!({"action":"frame","snapshot":frame}), visual);
    assert_eq!(reply["finishSession"], 5);
    let mut polishing = ask_frame(5, 2);
    polishing["ask"]["pending"] = json!({"phase":"polishing","text":"and the"});
    draw(&pill, polishing.clone(), visual);
    click("native-dock-ask", visual);
    let reply = send(
        &pill,
        json!({"action":"frame","snapshot":polishing}),
        visual,
    );
    assert_eq!(reply["finishSession"], Value::Null);
    // Listening for the first question: the compact capsule takes no clicks.
    let listening = json!({"state":"ask","session":6,"ask":{"rev":0,"listening":true,"turns":[]}});
    draw(&pill, listening, visual);
    assert!(pill.read_with(visual, |p, _| p.hit_rects(capsules::now_ms()).is_empty()));
    assert_eq!(
        pill.read_with(visual, |p, _| capsules::size(&p.snapshot)),
        (248., 40.)
    );
    pill.update(visual, |pill, _| assert!(!pill.ask_act("ask-close", None)));
}

#[gpui::test]
fn a_release_names_the_ask_kind(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    draw(&pill, ask_frame(3, 7), visual);
    send(
        &pill,
        json!({"action":"release","session":3,"kind":"speaking"}),
        visual,
    );
    assert!(pill.read_with(visual, |p, _| p.target));
    send(
        &pill,
        json!({"action":"release","session":3,"kind":"ask"}),
        visual,
    );
    assert!(!pill.read_with(visual, |p, _| p.target));
    // A frame without its Ask detail never becomes visible.
    pill.update(visual, |pill, _| {
        pill.apply(Snapshot {
            state: "ask".into(),
            ..Default::default()
        });
        assert!(!pill.target);
    });
}

#[test]
fn answers_split_into_paragraphs_and_list_items_as_the_web_markdown_does() {
    assert_eq!(
        ask::blocks("Two things:\n\n- the **chip**\n- the `glint`\n\n1. one\n2. two"),
        vec![
            (None, "Two things:".into()),
            (Some("•".into()), "the chip".into()),
            (Some("•".into()), "the glint".into()),
            (Some("1.".into()), "one".into()),
            (Some("2.".into()), "two".into()),
        ]
    );
    assert_eq!(
        ask::blocks("line one\nline two"),
        vec![(None, "line one line two".into())]
    );
}
