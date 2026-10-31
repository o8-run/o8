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
    let notice = |visual: &mut VisualTestContext| {
        shell.read_with(visual, |s, cx| {
            crate::shell::toasts::texts(cx)
                .last()
                .cloned()
                .unwrap_or_else(|| s.notice.clone())
        })
    };

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
        let notice = shell.read_with(visual, |s, cx| {
            crate::shell::toasts::texts(cx)
                .last()
                .cloned()
                .unwrap_or_else(|| s.notice.clone())
        });
        panic!("the voice host never received {count} controls; notice: {notice}");
    };
    let notice = |visual: &mut VisualTestContext| shell.read_with(visual, |s, _| s.notice.clone());
    let mic = |visual: &mut VisualTestContext| {
        shell.read_with(visual, |s, cx| {
            match s.content.get(&s.key(&s.active().unwrap())) {
                Some(Content::Session(view)) => view.read(cx).voice(),
                _ => panic!("session"),
            }
        })
    };

    // Caps Lock, relayed by the voice host as a voice-host-state frame, starts
    // Live for the selected chat while o8 next is the active window.
    visual.update(|window, _| window.activate_window());
    send(
        "voice-host-state",
        json!({"action": "voice-toggle", "hostId": "host"}),
        &mut visual,
    );
    let start = controls(1, &mut visual)[0].clone();
    assert_eq!(start["action"], "start");
    assert_eq!(start["source"], "byok");
    let selected = shell.read_with(&visual, |s, _| s.active().unwrap());
    let Tab::Session(thread) = selected else {
        panic!("a chat is selected")
    };
    // The broker's binding fields ride on every binding-scoped control.
    assert_eq!(start["threadId"], thread.as_str());
    assert!(
        start["repoPath"]
            .as_str()
            .is_some_and(|repo| !repo.is_empty())
    );
    assert!(start["requestId"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(
        start["binding"].as_str().unwrap().contains(&thread),
        "the binding pins the chat: {start}"
    );
    let scope = json!({"binding": start["binding"], "nonce": start["nonce"],
        "threadId": start["threadId"], "repoPath": start["repoPath"]});
    let with = |extra: Value| {
        let mut frame = scope.clone();
        frame
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        frame
    };
    assert_eq!(mic(&mut visual), VoiceState::Connecting);
    send(
        "voice-host-state",
        with(json!({"action": "state", "state": "live"})),
        &mut visual,
    );
    assert_eq!(mic(&mut visual), VoiceState::Live);
    // State spread onto other frames is not session state.
    send(
        "voice-host-state",
        with(json!({"action": "accepted", "state": "closed", "delegationId": "d0"})),
        &mut visual,
    );
    assert_eq!(mic(&mut visual), VoiceState::Live);

    // A delegation posts through the chat's queue once, however often the host
    // relays it; another session's nonce posts nothing.
    let delegation = with(json!({"action": "delegate", "delegationId": "d1",
        "text": "List the open pull requests"}));
    send("voice-delegate", delegation.clone(), &mut visual);
    send("voice-delegate", delegation, &mut visual);
    let mut stale = with(json!({"action": "delegate", "delegationId": "d2", "text": "Ignored"}));
    stale["nonce"] = json!("v-stale");
    send("voice-delegate", stale, &mut visual);
    let sent = controls(2, &mut visual);
    let accepted = sent
        .iter()
        .filter(|control| control["action"] == "accepted")
        .collect::<Vec<_>>();
    assert_eq!(accepted.len(), 1, "one acceptance: {sent:?}");
    assert_eq!(accepted[0]["delegationId"], "d1");
    assert_eq!(accepted[0]["threadId"], thread.as_str());
    assert!(
        accepted[0]["queueItemId"].as_str().is_some_and(
            |id| id.starts_with(&format!("next-{}-", start["nonce"].as_str().unwrap()))
        ),
        "the acceptance names a queue item of this Live session: {sent:?}"
    );

    // A spoken cancel reaches the chat's stop path and leaves voice on.
    send(
        "voice-host-state",
        with(json!({"action": "interrupt"})),
        &mut visual,
    );
    for _ in 0..100 {
        visual.run_until_parked();
        if notice(&mut visual).starts_with("Voice") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(
        notice(&mut visual),
        "Voice asked this chat to stop. The chat has not confirmed it yet."
    );
    assert_eq!(mic(&mut visual), VoiceState::Live);

    // Symon's confirmation shows until the person answers it.
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000;
    send(
        "voice-host-state",
        json!({"action": "confirmation", "confirmation": {"confirmationId": "gate",
            "tool": "write", "summary": "Confirm write", "expiresAt": expires, "source": "native"}}),
        &mut visual,
    );
    let allow = visual
        .debug_bounds("voice-confirm-allow-gate")
        .expect("the confirmation is visible");
    assert!(visual.debug_bounds("voice-confirm-deny-gate").is_some());
    visual.simulate_click(allow.center(), gpui::Modifiers::default());
    let decision = controls(3, &mut visual)[2].clone();
    assert_eq!(decision["action"], "decision");
    assert_eq!(decision["confirmationId"], "gate");
    assert_eq!(decision["allow"], true);
    // The answered card leaves: a second click on its place posts nothing.
    // (GPUI keeps debug bounds across frames, so the hitbox is the evidence.)
    visual.run_until_parked();
    draw(&mut visual);
    visual.simulate_click(allow.center(), gpui::Modifiers::default());
    visual.run_until_parked();
    assert_eq!(
        controls(3, &mut visual).len(),
        3,
        "the answered card took a second click"
    );

    // A second toggle asks the host to close; the mic stays busy until the
    // host reports closure.
    send("voice-toggle", json!({}), &mut visual);
    let stop = controls(4, &mut visual)[3].clone();
    assert_eq!(stop["action"], "stop");
    assert_ne!(stop["requestId"], start["requestId"]);
    for key in ["binding", "nonce", "threadId", "repoPath"] {
        assert_eq!(stop[key], start[key], "{key}");
    }
    assert_eq!(mic(&mut visual), VoiceState::Closing);
    send(
        "voice-host-state",
        with(json!({"action": "state", "state": "closed"})),
        &mut visual,
    );
    assert_eq!(mic(&mut visual), VoiceState::Off);
    let rejected = fixture
        .client
        .get::<Value>("/api/next/voice-host", &[])
        .unwrap()["rejected"]
        .clone();
    assert_eq!(rejected, json!([]), "the broker contract refused nothing");
}

#[gpui::test]
fn dictation_mic_fills_the_draft_and_sends_the_final_transcript(cx: &mut TestAppContext) {
    use crate::ui::{DictationState, VoiceState};
    let fixture = Fixture::start_mode(false, "--voice-host");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("dictation.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    let (first, second) = ("thoughts-composer-first", "thoughts-composer-second");
    shell.update_in(&mut visual, |s, window, cx| {
        s.execute(Command::Session(first.into()), window, cx)
    });
    ready(&shell, &mut visual);
    let view = shell.read_with(&visual, |s, _| {
        match s.content.get(&s.key(&s.active().unwrap())) {
            Some(Content::Session(view)) => view.clone(),
            _ => panic!("session"),
        }
    });
    view.update(&mut visual, |view, cx| view.dictate("Draft:", cx));
    let send = |kind: &str, payload: Value, visual: &mut VisualTestContext| {
        let frame = json!({"type": "ui-command", "kind": kind, "payload": payload});
        shell.update_in(visual, |s, window, cx| s.ui_command(&frame, window, cx));
        visual.run_until_parked();
        draw(visual);
    };
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
        let notice = shell.read_with(visual, |s, cx| {
            crate::shell::toasts::texts(cx)
                .last()
                .cloned()
                .unwrap_or_else(|| s.notice.clone())
        });
        panic!("the voice host never received {count} controls; notice: {notice}");
    };
    let tap = |visual: &mut VisualTestContext| {
        draw(visual);
        let mic = visual
            .debug_bounds("composer-microphone")
            .expect("the composer mic is visible");
        visual.simulate_click(mic.center(), gpui::Modifiers::default());
        visual.run_until_parked();
        draw(visual);
    };
    let mic = |visual: &mut VisualTestContext| view.read_with(visual, |view, _| view.dictation());
    let draft = |visual: &mut VisualTestContext| view.read_with(visual, |view, cx| view.draft(cx));

    // A tap asks the host for the microphone, for this chat, on a binding of
    // its own beside Live's.
    tap(&mut visual);
    let start = controls(1, &mut visual)[0].clone();
    assert_eq!(start["action"], "dictation-start");
    assert_eq!(start["threadId"], first);
    assert!(
        start["binding"]
            .as_str()
            .is_some_and(|binding| binding.starts_with("[\"composer\"")),
        "dictation has its own binding: {start}"
    );
    assert_eq!(mic(&mut visual), DictationState::Starting);
    let scope = json!({"binding": start["binding"], "nonce": start["nonce"],
        "threadId": start["threadId"], "repoPath": start["repoPath"],
        "requestId": start["requestId"], "hostId": "host"});
    let with = |extra: Value| {
        let mut frame = scope.clone();
        frame
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        frame
    };
    send(
        "dictation-state",
        with(json!({"state": "listening"})),
        &mut visual,
    );
    assert_eq!(mic(&mut visual), DictationState::Listening);

    // Snapshots replace what follows the draft; an earlier recording's frames
    // change nothing.
    send(
        "dictation-text",
        with(json!({"text": "check the", "final": false})),
        &mut visual,
    );
    assert_eq!(draft(&mut visual), "Draft: check the");
    send(
        "dictation-text",
        with(json!({"text": "check the build", "final": false})),
        &mut visual,
    );
    assert_eq!(draft(&mut visual), "Draft: check the build");
    let mut stale = with(json!({"text": "ignored", "final": false}));
    stale["requestId"] = json!("m-earlier");
    send("dictation-text", stale, &mut visual);
    assert_eq!(draft(&mut visual), "Draft: check the build");

    // The next tap stops and sends the polished transcript through the chat's
    // own queue.
    tap(&mut visual);
    let stop = controls(2, &mut visual)[1].clone();
    assert_eq!(stop["action"], "dictation-stop");
    assert_eq!(stop["submit"], true);
    assert_eq!(stop["nonce"], start["nonce"]);
    assert_eq!(mic(&mut visual), DictationState::Finishing);
    send(
        "dictation-text",
        with(json!({"text": "Check the build.", "final": true})),
        &mut visual,
    );
    let repo = start["repoPath"].as_str().unwrap().to_owned();
    let mut texts = vec![];
    for _ in 0..200 {
        visual.run_until_parked();
        let queue: Value = fixture
            .client
            .get(
                "/api/orchestrator/composer-queue",
                &[("repoPath", &repo), ("threadId", first)],
            )
            .unwrap();
        texts = queue["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item["payload"]["text"].as_str().map(String::from))
            .collect::<Vec<_>>();
        if texts.iter().any(|text| text == "Draft: Check the build.") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(
        texts.iter().any(|text| text == "Draft: Check the build."),
        "the final transcript was sent: {texts:?}"
    );
    send(
        "dictation-state",
        with(json!({"state": "idle"})),
        &mut visual,
    );
    assert_eq!(mic(&mut visual), DictationState::Off);

    // The waveform stays GPT Live: dictation started no Live session.
    assert!(
        controls(2, &mut visual)
            .iter()
            .all(|control| control["action"] != "start")
    );
    assert_eq!(
        view.read_with(&visual, |view, _| view.voice()),
        VoiceState::Off
    );

    // A microphone the host still holds refuses another recording and says so.
    tap(&mut visual);
    for _ in 0..100 {
        visual.run_until_parked();
        if mic(&mut visual) == DictationState::Off {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(mic(&mut visual), DictationState::Off);
    assert_eq!(
        shell.read_with(&visual, |s, cx| crate::shell::toasts::texts(cx)
            .last()
            .cloned()
            .unwrap_or_else(|| s.notice.clone())),
        "Another voice input is active."
    );

    // Opening another chat mid-recording cancels it and puts the draft back.
    fixture
        .client
        .request(
            "POST",
            &fixture
                .client
                .url("/api/next/voice-host/dictation-fixture")
                .unwrap(),
        )
        .send_json(json!({"state": "idle"}))
        .unwrap();
    let before = draft(&mut visual);
    tap(&mut visual);
    let sent = controls(3, &mut visual);
    let restart = sent.last().unwrap().clone();
    assert_eq!(restart["action"], "dictation-start");
    let mut partial = with(json!({"text": "stray words", "final": false}));
    for key in ["nonce", "requestId"] {
        partial[key] = restart[key].clone();
    }
    send(
        "dictation-state",
        {
            let mut state = partial.clone();
            state["state"] = json!("listening");
            state
        },
        &mut visual,
    );
    send("dictation-text", partial, &mut visual);
    assert!(draft(&mut visual).ends_with("stray words"));
    shell.update_in(&mut visual, |s, window, cx| {
        s.execute(Command::Session(second.into()), window, cx);
        // The follow hook runs on the shell tick.
        s.tick(false, window, cx);
    });
    let cancel = controls(4, &mut visual).last().unwrap().clone();
    assert_eq!(cancel["action"], "dictation-stop");
    assert_eq!(cancel["submit"], false);
    assert_eq!(draft(&mut visual), before);
    assert_eq!(mic(&mut visual), DictationState::Off);
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
