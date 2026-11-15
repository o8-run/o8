//! Batch 3: the fleet capsule, the edit chip and glints in the real Pill model.
use super::*;

fn future() -> u64 {
    capsules::now_ms() + 60_000
}
fn snapshot(state: &str, session: u64) -> Snapshot {
    Snapshot {
        state: state.into(),
        session,
        speed: 1.,
        ..Default::default()
    }
}
fn workers(working: u64, waiting: u64) -> Option<capsules::Workers> {
    Some(capsules::Workers {
        count: working + waiting,
        working,
        waiting,
        label: "ready".into(),
        repos: vec!["o8".into()],
    })
}
fn edit(id: u64, status: &str, until: u64) -> Option<extras::EditChip> {
    Some(extras::EditChip {
        id,
        app: "Notes".into(),
        status: status.into(),
        until,
    })
}
fn glint(fade_at: u64, until: u64) -> Option<extras::Glint> {
    Some(extras::Glint {
        text: "Remembered".into(),
        tone: "progress".into(),
        fade_at,
        until,
    })
}
fn draw(pill: &Entity<Pill>, snapshot: Snapshot, visual: &mut gpui::VisualTestContext) {
    pill.update_in(visual, |pill, _, cx| {
        pill.apply(snapshot);
        pill.motion = crate::motion::Transition::settled(160, true);
        cx.notify();
    });
    redraw(visual);
}
fn redraw(visual: &mut gpui::VisualTestContext) {
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
fn fleet_capsule_draws_resting_and_expanded_and_retires(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    let resting = Snapshot {
        workers: workers(2, 1),
        ..snapshot("workers", 4)
    };
    draw(&pill, resting.clone(), visual);
    assert!(visual.debug_bounds("native-dock-capsule").is_some());
    assert_eq!(capsules::size(&resting), (128., 16.));
    assert_eq!(
        resting.workers.as_ref().unwrap().sliver(),
        ("3".into(), "fleet".into())
    );
    let expanded = Snapshot {
        expanded: true,
        ..resting.clone()
    };
    draw(&pill, expanded.clone(), visual);
    assert_eq!(capsules::size(&expanded), (320., 44.));
    assert_eq!(
        expanded.workers.as_ref().unwrap().detail(),
        "2 in flight · 1 review ready"
    );
    assert_eq!(
        workers(1, 0).unwrap().detail(),
        "1 packet in flight",
        "DockNotchSurface wording"
    );
    let parked = capsules::Workers {
        label: "waiting".into(),
        ..workers(0, 2).unwrap()
    };
    assert_eq!(parked.detail(), "2 waiting on you");
    assert_eq!(parked.sliver(), ("2".into(), "waiting".into()));
    assert_eq!(
        capsules::Workers {
            count: 120,
            ..parked
        }
        .sliver()
        .0,
        "99+"
    );
    // A release for the fleet session retires it; a dictation release does not.
    send(
        &pill,
        json!({"action":"release","session":4,"kind":"dictation"}),
        visual,
    );
    assert!(pill.read_with(visual, |p, _| p.target));
    send(
        &pill,
        json!({"action":"release","session":4,"kind":"workers"}),
        visual,
    );
    assert!(!pill.read_with(visual, |p, _| p.target));
}

#[gpui::test]
fn fleet_tap_reports_one_expand_and_nothing_after_a_new_session(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    let resting = json!({"state":"workers","session":5,"workers":{"count":1,"working":1}});
    draw(
        &pill,
        serde_json::from_value(resting.clone()).unwrap(),
        visual,
    );
    click("native-dock-capsule", visual);
    let reply = send(&pill, json!({"action":"frame","snapshot":resting}), visual);
    assert_eq!(
        reply["actions"],
        json!([{"session":5,"state":"workers","action":"workers-expand","value":null}])
    );
    let again = send(&pill, json!({"action":"frame","snapshot":resting}), visual);
    assert_eq!(again["actions"], json!([]), "reported once");
    click("native-dock-capsule", visual);
    let other = json!({"state":"workers","session":6,"workers":{"count":1,"working":1}});
    let reply = send(&pill, json!({"action":"frame","snapshot":other}), visual);
    assert_eq!(reply["actions"], json!([]), "dropped on a new session");
}

#[gpui::test]
fn chip_and_glint_compose_below_every_capsule_state(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    let until = future();
    for state in [
        "recording",
        "success",
        "speaking",
        "working",
        "voice",
        "workers",
    ] {
        let base = Snapshot {
            edit: edit(1, "ready", until),
            glint: glint(until, until + 600),
            workers: workers(1, 0),
            ..snapshot(state, 2)
        };
        draw(&pill, base.clone(), visual);
        let surface = visual
            .debug_bounds("native-dock-capsule")
            .or_else(|| visual.debug_bounds("native-dictation-pill"))
            .expect(state);
        let chip = visual.debug_bounds("native-edit-chip").expect(state);
        let shown = visual.debug_bounds("native-dock-glint").expect(state);
        assert!(chip.top() >= surface.bottom(), "{state}: chip below");
        assert!(shown.top() >= chip.bottom(), "{state}: glint below chip");
        // The chip is part of the clickable footprint; the glint never is.
        let rects = pill.read_with(visual, |p, _| p.hit_rects(capsules::now_ms()));
        let top = 8. + capsules::size(&base).1 + 6.;
        assert!(rects.contains(&[248., top, 24.]), "{state}: {rects:?}");
        assert!(rects.len() <= 2, "{state}");
    }
    // Chip and glint alone draw without a capsule, the chip at the capsule's place.
    draw(
        &pill,
        Snapshot {
            edit: edit(1, "ready", until),
            ..snapshot("extras", 3)
        },
        visual,
    );
    assert!(visual.debug_bounds("native-dock-capsule").is_none());
    assert!(visual.debug_bounds("native-dictation-pill").is_none());
    assert!(visual.debug_bounds("native-edit-chip").is_some());
    assert_eq!(
        pill.read_with(visual, |p, _| p.hit_rects(capsules::now_ms())),
        vec![[248., 8., 24.]]
    );
    send(
        &pill,
        json!({"action":"release","session":3,"kind":"extras"}),
        visual,
    );
    assert!(!pill.read_with(visual, |p, _| p.target));
}

#[test]
fn timed_dismissal_and_fade_run_from_the_timestamp_without_frames() {
    let now = capsules::now_ms();
    let mut pill = Pill::default();
    pill.apply(Snapshot {
        glint: glint(now + 4_200, now + 4_800),
        hold_ms: 4_800,
        ..snapshot("extras", 1)
    });
    assert!(pill.target);
    let shown = pill.snapshot.glint.clone().unwrap();
    assert_eq!(shown.opacity(now), 1.);
    assert_eq!(shown.opacity(now + 4_450), 0.5);
    assert_eq!(shown.opacity(now + 4_700), 0.);
    // Only the phase edges redraw; no frame arrives between these ticks.
    assert!(pill.extras_tick(now + 10));
    assert!(!pill.extras_tick(now + 4_000));
    assert!(pill.extras_tick(now + 4_200), "fade starts");
    assert!(!pill.extras_tick(now + 4_500));
    assert!(pill.target);
    assert!(pill.extras_tick(now + 4_800), "gone at its timestamp");
    assert!(!pill.target, "a glint-only panel hides itself");
    // Under a capsule the chip ends at its timestamp and the capsule stays.
    pill.apply(Snapshot {
        edit: edit(2, "reverted", now + 1_800),
        ..snapshot("speaking", 2)
    });
    assert!(pill.extras_tick(now + 10));
    assert!(pill.hit_rects(now + 10).len() == 2);
    assert!(pill.extras_tick(now + 1_800));
    assert!(pill.target);
    assert_eq!(pill.hit_rects(now + 1_800), vec![[280., 8., 40.]]);
    // A late frame for an ended chip/glint-only state never shows the panel.
    pill.apply(Snapshot {
        edit: edit(3, "ready", now.saturating_sub(1)),
        ..snapshot("extras", 4)
    });
    assert!(!pill.target);
}

#[test]
fn static_frames_hold_the_lease_up_to_the_cap_and_others_never_do() {
    let timing: Value =
        serde_json::from_str(include_str!("../../../src/lib/next/pill-timing.json")).unwrap();
    assert_eq!(timing["staticMs"], extras::STATIC_LEASE_MS);
    let mut pill = Pill::default();
    pill.apply(Snapshot {
        hold_ms: 60_000,
        workers: workers(1, 0),
        ..snapshot("workers", 1)
    });
    pill.heard = Instant::now() - Duration::from_millis(4_900);
    pill.expire();
    assert!(pill.target, "a fleet frame holds without keep-alives");
    pill.heard = Instant::now() - Duration::from_millis(5_001);
    pill.expire();
    assert!(!pill.target, "capped at the static lease");
    pill.apply(Snapshot {
        hold_ms: 5_000,
        ..snapshot("speaking", 2)
    });
    pill.heard = Instant::now() - Duration::from_millis(751);
    pill.expire();
    assert!(!pill.target, "active capsules keep the 750 ms lease");
    pill.apply(Snapshot {
        edit: edit(1, "ready", future()),
        ..snapshot("extras", 3)
    });
    pill.heard = Instant::now() - Duration::from_millis(751);
    pill.expire();
    assert!(
        !pill.target,
        "a frame without a hold keeps the 750 ms lease"
    );
}

#[gpui::test]
fn revert_click_is_reported_once_and_ignored_when_not_offered(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    let until = future();
    let frame = |status: &str, id: u64| {
        json!({"state":"working","session":9,"startedAt":1,
            "edit":{"id":id,"app":"Notes","status":status,"until":until}})
    };
    draw(
        &pill,
        serde_json::from_value(frame("ready", 1)).unwrap(),
        visual,
    );
    click("native-edit-chip", visual);
    click("native-edit-chip", visual);
    let reply = send(
        &pill,
        json!({"action":"frame","snapshot":frame("ready", 1)}),
        visual,
    );
    assert_eq!(
        reply["actions"],
        json!([{"session":9,"state":"working","action":"revert","value":null,"edit":1}]),
        "two clicks, one revert"
    );
    click("native-edit-chip", visual);
    let reply = send(
        &pill,
        json!({"action":"frame","snapshot":frame("ready", 1)}),
        visual,
    );
    assert_eq!(
        reply["actions"],
        json!([]),
        "sent until the web shows a new status"
    );
    // The web ran it (pending); a failed revert offers it again.
    send(
        &pill,
        json!({"action":"frame","snapshot":frame("pending", 1)}),
        visual,
    );
    redraw(visual);
    click("native-edit-chip", visual);
    let reply = send(
        &pill,
        json!({"action":"frame","snapshot":frame("ready", 1)}),
        visual,
    );
    assert_eq!(
        reply["actions"],
        json!([]),
        "a pending chip is not a control"
    );
    redraw(visual);
    click("native-edit-chip", visual);
    let reply = send(
        &pill,
        json!({"action":"frame","snapshot":frame("ready", 1)}),
        visual,
    );
    assert_eq!(reply["actions"][0]["action"], "revert");
    // After the capsule's lease expires, or its chip ends, a click does nothing.
    pill.update(visual, |pill, _| {
        pill.heard = Instant::now() - Duration::from_millis(751);
        pill.expire();
    });
    assert!(!pill.update(visual, |p, _| p.revert_click(capsules::now_ms())));
    pill.update(visual, |pill, _| {
        pill.apply(Snapshot {
            edit: edit(2, "ready", 10),
            ..snapshot("speaking", 3)
        })
    });
    assert!(!pill.update(visual, |p, _| p.revert_click(capsules::now_ms())));
    // A queued revert is dropped, not replayed, when the capsule under it changes.
    pill.update(visual, |pill, _| {
        pill.apply(Snapshot {
            edit: edit(3, "ready", until),
            ..snapshot("speaking", 4)
        });
        assert!(pill.revert_click(capsules::now_ms()));
    });
    let reply = send(
        &pill,
        json!({"action":"frame","snapshot":{"state":"extras","session":1,
            "edit":{"id":3,"status":"ready","until":until}}}),
        visual,
    );
    assert_eq!(reply["actions"], json!([]));
}

#[gpui::test]
fn live_voice_carries_the_in_flight_worker_count(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    let live = Snapshot {
        workers: workers(3, 0),
        ..snapshot("voice", 1)
    };
    draw(&pill, live.clone(), visual);
    assert_eq!(capsules::size(&live), (348., 40.));
    let connecting = Snapshot {
        connecting: true,
        ..live.clone()
    };
    assert_eq!(capsules::size(&connecting), (268., 40.));
    assert_eq!(capsules::size(&snapshot("voice", 1)), (268., 40.));
    assert_eq!(
        pill.read_with(visual, |p, _| p.hit_rects(capsules::now_ms())),
        vec![[348., 8., 40.]]
    );
}
