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
        json!({"type": "ui-command", "kind": "reboot", "payload": {}}),
        &mut visual,
    );
    assert_eq!(
        notice(&mut visual),
        "I don't know the o8 surface \"canvas\".",
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

#[gpui::test]
fn voice_pins_live_to_the_chat_and_posts_each_delegation_once(cx: &mut TestAppContext) {
    use crate::ui::VoiceState;
    let fixture = Fixture::start_mode(false, "--voice-host");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("voice.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    // A chat whose queue the composer fixture owns.
    shell.update_in(&mut visual, |s, window, cx| {
        s.execute(
            Command::Session("thoughts-composer-first".into()),
            window,
            cx,
        )
    });
    ready(&shell, &mut visual);
    let send = |kind: &str, payload: Value, visual: &mut VisualTestContext| {
        let frame = json!({"type": "ui-command", "kind": kind, "payload": payload});
        shell.update_in(visual, |s, window, cx| s.ui_command(&frame, window, cx));
        visual.run_until_parked();
        draw(visual);
    };
    // What the window posted to the voice host, once `count` controls arrived.
    let controls = |count: usize, visual: &mut VisualTestContext| {
        for _ in 0..200 {
            visual.run_until_parked();
            let sent = fixture
                .client
                .get::<Value>("/api/next/voice-host", &[])
                .unwrap()["controls"]
                .as_array()
                .cloned()
                .unwrap();
            if sent.len() >= count {
                return sent;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let notice = shell.read_with(visual, |s, _| s.notice.clone());
        panic!("the voice host never received {count} controls; notice: {notice}");
    };
    let mic = |visual: &mut VisualTestContext| {
        shell.read_with(visual, |s, cx| {
            match s.content.get(&s.key(&s.active().unwrap())) {
                Some(Content::Session(view)) => view.read(cx).voice(),
                _ => panic!("session"),
            }
        })
    };

    // Caps Lock's relay starts Live for the selected chat.
    send("voice-toggle", json!({}), &mut visual);
    let start = controls(1, &mut visual)[0].clone();
    assert_eq!(start["action"], "start");
    assert_eq!(start["source"], "byok");
    let (binding, nonce) = (start["binding"].clone(), start["nonce"].clone());
    let selected = shell.read_with(&visual, |s, _| s.active().unwrap());
    let Tab::Session(thread) = selected else {
        panic!("a chat is selected")
    };
    assert!(
        binding.as_str().unwrap().contains(&thread),
        "the binding pins the chat: {binding}"
    );
    assert_eq!(mic(&mut visual), VoiceState::Connecting);
    send(
        "voice-host-state",
        json!({"binding": binding, "nonce": nonce, "state": "live"}),
        &mut visual,
    );
    assert_eq!(mic(&mut visual), VoiceState::Live);

    // A delegation posts through the chat's queue once, however often the host
    // relays it; another session's nonce posts nothing.
    let delegation = json!({"binding": binding, "nonce": nonce, "delegationId": "d1",
        "text": "List the open pull requests"});
    send("voice-delegate", delegation.clone(), &mut visual);
    send("voice-delegate", delegation, &mut visual);
    send(
        "voice-delegate",
        json!({"binding": binding, "nonce": "v-stale", "delegationId": "d2", "text": "Ignored"}),
        &mut visual,
    );
    let sent = controls(2, &mut visual);
    let accepted = sent
        .iter()
        .filter(|control| control["action"] == "accepted")
        .collect::<Vec<_>>();
    assert_eq!(accepted.len(), 1, "one acceptance: {sent:?}");
    assert_eq!(accepted[0]["delegationId"], "d1");
    assert_eq!(accepted[0]["nonce"], nonce);
    assert!(
        accepted[0]["queueItemId"]
            .as_str()
            .is_some_and(|id| id.starts_with("next-")),
        "the acceptance names the queue item: {sent:?}"
    );

    // A second toggle closes voice with the same identity.
    send("voice-toggle", json!({}), &mut visual);
    let stop = controls(3, &mut visual)[2].clone();
    assert_eq!(stop["action"], "stop");
    assert_eq!(
        (stop["binding"].clone(), stop["nonce"].clone()),
        (binding, nonce)
    );
    assert_eq!(mic(&mut visual), VoiceState::Off);
}

#[gpui::test]
fn sidebar_edge_follows_the_pointer_from_the_press(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("sidebar-resize.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    draw(&mut visual);
    let start = shell.read_with(&visual, |s, _| super::sidebar::width(s));
    let edge = visual
        .debug_bounds("sidebar-resize")
        .expect("sidebar resize edge");
    let at = edge.center();
    let left = gpui::MouseButton::Left;
    let modifiers = gpui::Modifiers::default();
    visual.simulate_mouse_down(at, left, modifiers);
    // A first step past the drag threshold, then the rest of a 60 px drag.
    for dx in [5., 20., 45., 60.] {
        visual.simulate_mouse_move(gpui::point(at.x + px(dx), at.y), left, modifiers);
        draw(&mut visual);
    }
    visual.simulate_mouse_up(gpui::point(at.x + px(60.), at.y), left, modifiers);
    visual.run_until_parked();
    draw(&mut visual);
    let saved = shell
        .read_with(&visual, |s, _| s.state.sidebar_width)
        .expect("the dragged width is saved");
    assert!(
        (saved - (start + 60.)).abs() < 0.5,
        "a 60 px drag must widen the sidebar by 60 px: {start} -> {saved}"
    );
}
