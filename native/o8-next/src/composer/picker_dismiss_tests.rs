use super::*;

fn dismiss_picker(trigger: &'static str, picker: &'static str, cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    surface.update(cx, |s, cx| {
        s.routing.as_mut().unwrap()["backend"] = json!("codex");
        cx.notify();
    });
    click("composer-input", cx);
    cx.simulate_input("Keep this draft 🦀");
    draw(cx);
    let draft = cx.debug_bounds("composer-input").unwrap();
    let routing = surface.read_with(cx, |s, cx| s.composer_routing(cx).unwrap());

    click(trigger, cx);
    assert!(cx.debug_bounds("composer-picker").is_some());
    click(trigger, cx);
    assert!(
        cx.debug_bounds("composer-picker").is_none(),
        "pressing the {picker} chip again closes its picker"
    );
    click(trigger, cx);
    assert!(cx.debug_bounds("composer-picker").is_some());
    if picker == "model" {
        click("composer-model-input", cx);
        cx.simulate_input("son");
        draw(cx);
        assert!(cx.debug_bounds("model-claude-sonnet-5").is_some());
    }

    let transcript = cx.debug_bounds("conversation-column").unwrap();
    let outside = transcript.origin + gpui::point(px(16.), px(16.));
    assert!(
        !cx.debug_bounds("composer-picker")
            .unwrap()
            .contains(&outside)
    );
    cx.simulate_click(outside, Modifiers::default());
    cx.run_until_parked();
    draw(cx);
    assert!(
        cx.debug_bounds("composer-picker").is_none(),
        "clicking the transcript must dismiss the {picker} picker"
    );
    cx.simulate_click(draft.center(), Modifiers::default());
    cx.simulate_input(" continues");
    surface.update_in(cx, |s, window, cx| {
        let input = s.composer.read(cx);
        assert_eq!(input.text, "Keep this draft 🦀 continues");
        assert!(input.focus.is_focused(window));
        assert!(input.controls.open.is_none());
        assert!(input.controls.model.is_none());
        assert_eq!(s.composer_routing(cx).unwrap(), routing);
        assert!(s.queue["items"].as_array().unwrap().is_empty());
    });
}

#[gpui::test]
fn native_composer_model_picker_dismisses_on_outside_click(cx: &mut TestAppContext) {
    dismiss_picker("composer-model", "model", cx);
}

#[gpui::test]
fn native_composer_effort_picker_dismisses_on_outside_click(cx: &mut TestAppContext) {
    dismiss_picker("composer-effort", "effort", cx);
}
