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
