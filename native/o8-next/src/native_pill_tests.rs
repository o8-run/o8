use super::*;

fn future() -> u64 {
    (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        + Duration::from_secs(60))
    .as_millis() as u64
}
#[test]
fn finish_is_listening_only_once_and_retired_on_a_new_session() {
    let mut pill = Pill::default();
    pill.finish();
    assert!(!pill.finish_pending);
    pill.apply(Snapshot {
        state: "recording".into(),
        session: 1,
        ..Default::default()
    });
    pill.finish();
    assert!(std::mem::take(&mut pill.finish_pending));
    pill.finish();
    assert!(!pill.finish_pending);
    pill.apply(Snapshot {
        state: "transcribing".into(),
        session: 1,
        ..Default::default()
    });
    pill.finish();
    assert!(!pill.finish_pending);
    pill.apply(Snapshot {
        state: "recording".into(),
        session: 2,
        ..Default::default()
    });
    pill.finish();
    assert!(pill.finish_pending);
    pill.apply(Snapshot {
        state: "idle".into(),
        session: 2,
        ..Default::default()
    });
    assert!(!pill.finish_pending);
}
#[test]
fn pill_feed_lease_and_idle_retire_drawing() {
    let mut pill = Pill::default();
    pill.apply(Snapshot {
        state: "recording".into(),
        ..Default::default()
    });
    pill.expire();
    assert!(pill.target);
    pill.heard = Instant::now() - Duration::from_secs(1);
    pill.expire();
    assert!(!pill.target);
    pill.apply(Snapshot {
        state: "polishing".into(),
        ..Default::default()
    });
    assert!(pill.target);
    pill.apply(Snapshot {
        state: "idle".into(),
        ..Default::default()
    });
    assert!(!pill.target);
}
#[gpui::test]
fn state_event_during_pill_update_is_deferred_until_the_root_is_returned(cx: &mut TestAppContext) {
    use std::{cell::Cell, rc::Rc};
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    let ack = Rc::new(Cell::new(false));
    let received = ack.clone();
    let target = pill.clone();
    pill.update_in(visual, |pill, window, cx| {
        pill.apply(Snapshot {
            state: "recording".into(),
            ..Default::default()
        });
        dispatch(
            &target,
            json!({"expiresAt":future(), "args":{"action":"frame","snapshot":{"state":"polishing"}}}),
            window,
            cx,
            move |reply| received.set(reply["ok"] == true),
        );
        assert_eq!(
            pill.snapshot.state, "recording",
            "delivery must not nest a Pill update"
        );
        assert!(!ack.get(), "the receipt follows deferred application");
        cx.notify();
    });
    visual.run_until_parked();
    assert!(ack.get());
    assert_eq!(
        pill.read_with(visual, |pill, _| pill.snapshot.state.clone()),
        "polishing"
    );
    visual.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    assert!(visual.debug_bounds("native-dictation-pill").is_some());
}
#[gpui::test]
fn expired_state_event_never_reaches_the_model(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    let rejected = std::rc::Rc::new(std::cell::Cell::new(false));
    let received = rejected.clone();
    visual.update(|window, cx| {
        dispatch(
            &pill,
            json!({"expiresAt":0,"args":{"action":"frame","snapshot":{"state":"recording"}}}),
            window,
            cx,
            move |reply| received.set(reply["ok"] == false),
        )
    });
    visual.run_until_parked();
    assert!(rejected.get());
    assert!(!pill.read_with(visual, |pill, _| pill.target));
}

#[gpui::test]
fn pill_states_draw_offscreen_without_input(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    for state in [
        "requesting-mic",
        "recording",
        "transcribing",
        "polishing",
        "success",
        "error",
    ] {
        pill.update_in(visual, |pill, _, cx| {
            pill.apply(Snapshot {
                state: state.into(),
                audio_level: 0.6,
                ..Default::default()
            });
            pill.motion = crate::motion::Transition::settled(160, true);
            cx.notify();
        });
        visual.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        assert!(
            visual.debug_bounds("native-dictation-pill").is_some(),
            "{state}"
        );
    }
}
#[test]
fn pill_states_and_idle_visibility() {
    for (state, label) in [
        ("requesting-mic", "Connecting…"),
        ("recording", "Listening"),
        ("transcribing", "Transcribing"),
        ("polishing", "Polishing"),
        ("success", "Pasted"),
        ("error", "Mic error"),
    ] {
        let snapshot = Snapshot {
            state: state.into(),
            ..Default::default()
        };
        assert!(snapshot.visible(), "{state}");
        assert_eq!(snapshot.label(), label);
    }
    assert!(!Snapshot::default().visible());
    assert!(
        !Snapshot {
            state: "idle".into(),
            ..Default::default()
        }
        .visible()
    );
    assert!(
        !Snapshot {
            state: "foreign".into(),
            ..Default::default()
        }
        .visible()
    );
    let delivered = Snapshot {
        state: "success".into(),
        pasted_text: Some("Delivered words".into()),
        ..Default::default()
    };
    assert_eq!(delivered.label(), "Delivered words");
    let failed = Snapshot {
        state: "error".into(),
        error: Some("Microphone denied".into()),
        ..Default::default()
    };
    assert_eq!(failed.label(), "Microphone denied");
}
#[test]
fn pill_placement_follows_primary_changes_and_notch_without_scaling() {
    assert_eq!(
        placement([0., 0., 1440., 900.], 0.),
        Some([460., 780., 520., 120.])
    );
    assert_eq!(
        placement([-1920., -200., 1920., 1080.], 32.),
        Some([-1220., 724., 520., 120.])
    );
    assert_eq!(
        placement([0., 0., 300., 100.], 0.),
        Some([0., 0., 300., 100.])
    );
    assert!(placement([0., 0., f64::NAN, 900.], 0.).is_none());
    assert!(placement([0., 0., 1440., 900.], f64::NAN).is_none());
    assert!(placement([0., 0., 0., 900.], 0.).is_none());
}
#[cfg(target_os = "macos")]
#[gpui::test]
fn pill_pipe_fixture(cx: &mut TestAppContext) {
    if std::env::var("O8_PILL_PIPE_FIXTURE").as_deref() != Ok("1") {
        return;
    }
    crate::app_parent::watch();
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    let frame = loop {
        if let Some(frame) = FRAMES.lock().unwrap().pop_front() {
            break frame;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let ack = std::rc::Rc::new(std::cell::Cell::new(false));
    let received = ack.clone();
    visual.update(|window, cx| {
        dispatch(&pill, frame, window, cx, move |reply| {
            received.set(reply["ok"] == true)
        })
    });
    visual.run_until_parked();
    assert!(ack.get());
    pill.read_with(visual, |pill, _| {
        println!(
            "pill-model:{}:{}",
            pill.snapshot.state, pill.snapshot.audio_level
        )
    });
}
#[cfg(target_os = "macos")]
#[test]
fn dictation_event_reaches_pill_model_through_real_parent_pipe() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["pill_pipe_fixture", "--nocapture"])
        .env("O8_PILL_PIPE_FIXTURE", "1")
        .env("O8_NEXT_PARENT_PIPE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(child.stdin.as_mut().unwrap(), "{}", json!({"type":"dictation-pill","id":"fixture","expiresAt":future(),"args":{"action":"frame","snapshot":{"state":"recording","audioLevel":0.625}}})).unwrap();
    let out = BufReader::new(child.stdout.take().unwrap());
    let (send, receive) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in out.lines().map_while(Result::ok) {
            if line.contains("pill-model:recording:0.625") {
                let _ = send.send(());
            }
        }
    });
    if receive.recv_timeout(Duration::from_secs(30)).is_err() {
        let _ = child.kill();
        let _ = child.wait();
        let _ = reader.join();
        panic!("the production pipe did not deliver a recording to the pill within 30 seconds");
    }
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
}

#[gpui::test]
fn hidden_pill_waits_for_a_frame_without_periodic_wakes(cx: &mut TestAppContext) {
    let (sender, receiver) = async_channel::bounded(1);
    let wakes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = wakes.clone();
    let executor = cx.executor();
    let background = cx.background_executor.clone();
    executor
        .spawn(async move {
            wait_for_work(false, &receiver, &background).await;
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
        .detach();
    cx.run_until_parked();
    cx.executor().advance_clock(Duration::from_secs(60));
    cx.run_until_parked();
    assert_eq!(wakes.load(std::sync::atomic::Ordering::SeqCst), 0);
    sender.try_send(()).unwrap();
    cx.run_until_parked();
    assert_eq!(wakes.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[gpui::test]
fn retained_pill_does_not_keep_the_shell_alive(cx: &mut TestAppContext) {
    cx.add_window_view(|_, _| Pill::default());
    cx.update(|cx| assert!(!has_real_windows(cx)));
}

#[cfg(not(target_os = "macos"))]
#[test]
fn unsupported_platform_rejects_without_queueing() {
    enqueue(json!({"id":"unsupported-platform"}));
    assert!(FRAMES.lock().unwrap().is_empty());
}

#[test]
fn identical_ticks_configure_and_present_only_once() {
    let mut pill = Pill::default();
    let mut counts = [0; 3];
    for _ in 0..100 {
        let (configure, frame, front) = pill.presentation.tick(true, Some([0., 0., 520., 120.]));
        counts[0] += usize::from(configure);
        counts[1] += usize::from(frame);
        counts[2] += usize::from(front);
    }
    assert_eq!(counts, [1, 1, 1]);
    assert_eq!(
        pill.presentation.tick(true, Some([1., 0., 520., 120.])),
        (false, true, false)
    );
    pill.presentation.tick(false, None);
    assert_eq!(
        pill.presentation.tick(true, Some([1., 0., 520., 120.])),
        (false, false, true)
    );
}
#[test]
fn active_frame_expires_without_waiting_for_exit_animation() {
    let mut pill = Pill::default();
    pill.apply(Snapshot {
        state: "recording".into(),
        ..Default::default()
    });
    pill.motion = crate::motion::Transition::settled(160, true);
    pill.shown = true;
    pill.heard = Instant::now() - Duration::from_millis(751);
    pill.expire();
    assert!(!pill.target);
    assert!(!pill.motion.value().1);
    let timing: Value =
        serde_json::from_str(include_str!("../../../src/lib/next/pill-timing.json")).unwrap();
    assert!(timing["requestMs"].as_u64().unwrap() + 100 < 750);
    assert_eq!(timing["expiryMs"], 750);
}

#[gpui::test]
fn invalid_window_delivery_returns_an_error_immediately(cx: &mut TestAppContext) {
    let handle = cx.add_window(|_, _| Pill::default());
    handle
        .update(cx, |_, window, _| window.remove_window())
        .unwrap();
    let result = deliver(
        handle,
        json!({"id":"invalid", "expiresAt":future(), "args":{"action":"frame"}}),
        &mut cx.to_async(),
    );
    assert!(result.is_err());
}

fn capsule(state: &str, session: u64) -> Snapshot {
    Snapshot {
        state: state.into(),
        session,
        speed: 1.,
        ..Default::default()
    }
}
fn show(pill: &Entity<Pill>, snapshot: Snapshot, visual: &mut gpui::VisualTestContext) {
    pill.update_in(visual, |pill, _, cx| {
        pill.apply(snapshot);
        pill.motion = crate::motion::Transition::settled(160, true);
        cx.notify();
    });
    visual.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}
/// The receipt the web dock reads after its next frame for the same session.
fn frame_reply(
    pill: &Entity<Pill>,
    snapshot: Value,
    visual: &mut gpui::VisualTestContext,
) -> Value {
    let reply = std::rc::Rc::new(std::cell::RefCell::new(Value::Null));
    let received = reply.clone();
    visual.update(|window, cx| {
        dispatch(
            pill,
            json!({"expiresAt":future(), "args":{"action":"frame","snapshot":snapshot}}),
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
fn capsule_states_draw_and_retire(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    for (state, label) in [
        ("speaking", "Speaking"),
        ("working", "Working…"),
        ("voice", "Voice live"),
    ] {
        show(&pill, capsule(state, 3), visual);
        assert!(
            visual.debug_bounds("native-dock-capsule").is_some(),
            "{state}"
        );
        assert!(
            visual.debug_bounds("native-dictation-pill").is_none(),
            "{state}"
        );
        assert_eq!(
            pill.read_with(visual, |p, _| p.snapshot.label().to_string()),
            label
        );
        let reply = frame_reply(&pill, json!({"state":"idle","session":3}), visual);
        assert_eq!(reply["ok"], true);
        assert!(
            !pill.read_with(visual, |p, _| p.target),
            "{state} retires on idle"
        );
    }
    let paused = Snapshot {
        paused: true,
        ..capsule("speaking", 4)
    };
    assert_eq!(paused.label(), "Paused");
    let synth = Snapshot {
        tool: Some("o8_ask".into()),
        ..capsule("working", 4)
    };
    assert_eq!(synth.label(), "Synthesizing…");
    let connecting = Snapshot {
        connecting: true,
        ..capsule("voice", 4)
    };
    assert_eq!(connecting.label(), "Connecting…");
    assert!(!capsules::interactive(&connecting));
    assert_eq!(capsules::size(&capsule("speaking", 1)), (280., 40.));
    assert_eq!(capsules::size(&capsule("voice", 1)), (268., 40.));
    assert_eq!(capsules::size(&capsule("working", 1)), (248., 40.));
    assert_eq!(capsules::size(&capsule("recording", 1)), (248., 44.));
}

#[gpui::test]
fn each_capsule_control_reports_exactly_one_action(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    let speaking = json!({"state":"speaking","session":7,"speed":1.0});
    for (selector, action, value) in [
        ("native-speech-pause", "pause", Value::Null),
        ("native-speech-stop", "stop", Value::Null),
        ("native-speech-speed-3", "speed", json!(0.85)),
    ] {
        show(&pill, capsule("speaking", 7), visual);
        click(selector, visual);
        let reply = frame_reply(&pill, speaking.clone(), visual);
        assert_eq!(
            reply["actions"],
            json!([{"session":7,"state":"speaking","action":action,"value":value}]),
            "{selector}"
        );
        let again = frame_reply(&pill, speaking.clone(), visual);
        assert_eq!(again["actions"], json!([]), "{selector} is reported once");
    }
    show(&pill, capsule("working", 8), visual);
    click("native-dock-capsule", visual);
    let reply = frame_reply(&pill, json!({"state":"working","session":8}), visual);
    assert_eq!(reply["actions"][0]["action"], "interrupt");
    assert_eq!(reply["actions"].as_array().unwrap().len(), 1);
    show(&pill, capsule("voice", 9), visual);
    click("native-dock-capsule", visual);
    let reply = frame_reply(&pill, json!({"state":"voice","session":9}), visual);
    assert_eq!(
        reply["actions"],
        json!([{"session":9,"state":"voice","action":"voice-stop","value":null}])
    );
    show(
        &pill,
        Snapshot {
            connecting: true,
            ..capsule("voice", 10)
        },
        visual,
    );
    click("native-dock-capsule", visual);
    let reply = frame_reply(
        &pill,
        json!({"state":"voice","session":10,"connecting":true}),
        visual,
    );
    assert_eq!(
        reply["actions"],
        json!([]),
        "connecting is not a stop control"
    );
}

#[gpui::test]
fn capsule_clicks_after_expiry_or_a_new_session_do_nothing(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    show(&pill, capsule("working", 11), visual);
    pill.update(visual, |pill, _| {
        pill.heard = Instant::now() - Duration::from_millis(751);
        pill.expire();
    });
    click("native-dock-capsule", visual);
    assert!(pill.read_with(visual, |p, _| p.actions.is_empty()));
    show(&pill, capsule("speaking", 12), visual);
    click("native-speech-stop", visual);
    // The web moved to another session before its next frame: the click is dropped.
    let reply = frame_reply(
        &pill,
        json!({"state":"speaking","session":13,"speed":1.0}),
        visual,
    );
    assert_eq!(reply["actions"], json!([]));
}

#[test]
fn working_timer_derives_from_the_start_timestamp() {
    assert_eq!(capsules::elapsed_label(1_000, 1_000), "0s");
    assert_eq!(capsules::elapsed_label(1_000, 60_999), "59s");
    assert_eq!(capsules::elapsed_label(1_000, 66_000), "1:05");
    assert_eq!(capsules::elapsed_label(5_000, 1_000), "0s");
    let mut pill = Pill::default();
    let start = 1_000_000;
    pill.apply(Snapshot {
        started_at: start,
        ..capsule("working", 1)
    });
    // No frame arrives between these ticks; only the second boundary redraws.
    assert!(pill.timer_tick(start + 5_000));
    assert!(!pill.timer_tick(start + 5_900));
    assert!(pill.timer_tick(start + 6_000));
    pill.apply(capsule("speaking", 2));
    assert!(!pill.timer_tick(start + 9_000));
}

#[gpui::test]
fn release_names_its_session_and_a_web_takeover_hides_at_once(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    let release = |args: Value, visual: &mut gpui::VisualTestContext| {
        visual.update(|window, cx| {
            dispatch(
                &pill,
                json!({"expiresAt":future(), "args":args}),
                window,
                cx,
                |_| {},
            )
        });
        visual.run_until_parked();
    };
    show(&pill, capsule("speaking", 21), visual);
    release(json!({"action":"release","session":20}), visual);
    assert!(
        pill.read_with(visual, |p, _| p.target),
        "a late release keeps the newer session"
    );
    release(json!({"action":"release","session":21}), visual);
    assert!(!pill.read_with(visual, |p, _| p.target));
    assert!(
        pill.read_with(visual, |p, _| p.motion.value().1),
        "a normal retirement fades"
    );
    show(&pill, capsule("working", 22), visual);
    release(
        json!({"action":"release","session":22,"immediate":true}),
        visual,
    );
    assert!(!pill.read_with(visual, |p, _| p.target || p.motion.value().1));
    show(&pill, capsule("voice", 23), visual);
    release(json!({"action":"release"}), visual);
    assert!(
        !pill.read_with(visual, |p, _| p.target),
        "an untagged release still hides"
    );
}

#[gpui::test]
fn a_late_release_for_another_kind_with_the_same_session_number_keeps_the_capsule(
    cx: &mut TestAppContext,
) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    let release = |args: Value, visual: &mut gpui::VisualTestContext| {
        visual.update(|window, cx| {
            dispatch(
                &pill,
                json!({"expiresAt":future(), "args":args}),
                window,
                cx,
                |_| {},
            )
        });
        visual.run_until_parked();
    };
    // Speaking and live voice number their sessions independently from 1.
    show(&pill, capsule("voice", 1), visual);
    release(
        json!({"action":"release","session":1,"kind":"speaking"}),
        visual,
    );
    assert!(
        pill.read_with(visual, |p, _| p.target),
        "a speaking release must not hide voice session 1"
    );
    release(
        json!({"action":"release","session":1,"kind":"voice"}),
        visual,
    );
    assert!(!pill.read_with(visual, |p, _| p.target));
    show(&pill, capsule("recording", 1), visual);
    release(
        json!({"action":"release","session":1,"kind":"working"}),
        visual,
    );
    assert!(pill.read_with(visual, |p, _| p.target));
    release(
        json!({"action":"release","session":1,"kind":"dictation"}),
        visual,
    );
    assert!(!pill.read_with(visual, |p, _| p.target));
}
