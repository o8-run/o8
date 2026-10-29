//! Exercise feature contributions through the production shell and route host.
use super::test_support::*;
use super::*;

#[gpui::test]
fn registered_chrome_slot_state_change_repaints_cached_scene(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("feature-registry.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    let renders = |visual: &VisualTestContext| {
        shell.read_with(visual, |s, cx| {
            s.chrome
                .renders(cx)
                .into_iter()
                .find_map(|(id, count)| (id == "shell-chrome").then_some(count))
                .unwrap_or(0)
        })
    };
    assert!(visual.debug_bounds("feature-slot-initial").is_some());
    let before = renders(&visual);
    visual.simulate_keystrokes("alt-c");
    visual.update(|window, cx| window.draw(cx).clear());
    assert!(visual.debug_bounds("feature-slot-updated").is_some());
    let after = renders(&visual);
    assert!(
        after > before,
        "changing a registered chrome slot must repaint the cached chrome scene: {before} -> {after}"
    );
}

#[gpui::test]
fn registered_shell_feature_reaches_render_keys_commands_tick_and_observer(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("feature-registry.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    assert!(
        visual.debug_bounds("feature-probe").is_some(),
        "registered render slot must paint through the real shell"
    );
    visual.simulate_keystrokes("alt-u");
    assert_eq!(
        shell.read_with(&visual, |s, _| s.notice.clone()),
        "feature key"
    );
    visual.simulate_keystrokes("ctrl-shift-p");
    visual.simulate_keystrokes("f e a t u r e enter");
    assert_eq!(
        shell.read_with(&visual, |s, _| s.notice.clone()),
        "feature command"
    );
    visual.update(|window, cx| shell.update(cx, |s, cx| s.tick(true, window, cx)));
    assert_eq!(
        shell.read_with(&visual, |s, _| s.notice.clone()),
        "feature tick"
    );
    visual.simulate_resize(size(px(910.), px(710.)));
    draw(&mut visual);
    assert_eq!(
        shell.read_with(&visual, |s, _| s.notice.clone()),
        "feature observer"
    );
    assert!(visual.simulate_close());
    let saved = State::load(&fixture.root.join("feature-registry.json")).unwrap();
    assert_eq!(saved.bounds[2..], [910., 710.]);
}

#[gpui::test]
fn ui_command_frames_reach_settings_panel_tools_and_the_draft(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("ui-commands.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    // Frames as the realtime server broadcasts them (#5076): the payload nests.
    let send = |frame: Value, visual: &mut VisualTestContext| {
        shell.update_in(visual, |s, window, cx| s.ui_command(&frame, window, cx));
        visual.run_until_parked();
        draw(visual);
    };
    let symon = |data: Value| json!({"type": "ui-command", "kind": "symon-ui", "payload": {"event": "o8:ui-command", "data": data}});
    let draft = |visual: &mut VisualTestContext| {
        shell.read_with(visual, |s, cx| {
            let Some(Content::Session(view)) = s.content.get(&s.key(&s.active().unwrap())) else {
                panic!("session")
            };
            view.read(cx).shell_issue_state(cx)["draft"]
                .as_str()
                .unwrap()
                .to_string()
        })
    };
    let notice = |visual: &mut VisualTestContext| shell.read_with(visual, |s, _| s.notice.clone());

    send(
        symon(json!({"surface": "orchestrator_draft", "text": "first"})),
        &mut visual,
    );
    assert_eq!(draft(&mut visual), "first");
    send(
        symon(json!({"surface": "orchestrator_draft", "text": "second"})),
        &mut visual,
    );
    assert_eq!(
        draft(&mut visual),
        "second\n\nfirst",
        "Symon drafts ahead of the draft and never sends"
    );

    send(symon(json!({"surface": "review"})), &mut visual);
    assert!(
        visual.debug_bounds("panel-tab").is_some(),
        "review opens the panel"
    );
    send(symon(json!({"surface": "inbox"})), &mut visual);
    assert!(
        visual.debug_bounds("panel-tab-review").is_some()
            && visual.debug_bounds("panel-tab").is_some(),
        "inbox opens beside review as the active tab"
    );

    send(symon(json!({"surface": "canvas"})), &mut visual);
    assert_eq!(
        notice(&mut visual),
        "I don't know the o8 surface \"canvas\"."
    );
    send(
        json!({"type": "ui-command", "kind": "voice-toggle", "payload": {}}),
        &mut visual,
    );
    assert_eq!(notice(&mut visual), "Voice chat is not in o8 next yet.");
    send(
        json!({"type": "ui-command", "kind": "reboot", "payload": {}}),
        &mut visual,
    );
    assert_eq!(
        notice(&mut visual),
        "Voice chat is not in o8 next yet.",
        "unknown kinds are ignored"
    );
    send(
        json!({"type": "ui-command", "kind": "ink-mark", "payload": {"event": "first-stroke", "data": {}}}),
        &mut visual,
    );

    send(
        json!({"type": "ui-command", "kind": "open-settings", "payload": {}}),
        &mut visual,
    );
    for _ in 0..20 {
        if visual.debug_bounds("settings-scroll").is_some() {
            return;
        }
        visual.run_until_parked();
        draw(&mut visual);
    }
    panic!("open-settings must open Settings");
}
