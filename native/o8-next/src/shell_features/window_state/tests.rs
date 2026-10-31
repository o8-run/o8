use crate::shell::{test_support::*, *};
use gpui::{TestAppContext, VisualTestContext};
use std::time::Instant;
fn wait_saved(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !shell.read_with(cx, |s, _| super::idle(s)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(shell.read_with(cx, |s, _| super::idle(s)));
}
fn close(cx: &mut VisualTestContext) {
    let handle = cx.update(|window, _| window.window_handle());
    assert!(!cx.simulate_close_request());
    let deadline = Instant::now() + Duration::from_secs(5);
    while cx.cx.windows().contains(&handle) && Instant::now() < deadline {
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(!cx.cx.windows().contains(&handle));
}
#[gpui::test]
fn window_state_io_barrier_keeps_bounds_and_input_live(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join("held-writer.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    ready(&shell, &mut visual);
    let mut held = crate::shell_state::barrier::hold(&file);
    let (input_done, watchdog) = held.input_watchdog();
    let handle = visual.update(|window, _| window.window_handle());
    visual
        .cx
        .simulate_window_move(handle, point(px(240.), px(160.)));
    draw(&mut visual);
    let deadline = Instant::now() + Duration::from_secs(2);
    while held.writes().is_empty() && Instant::now() < deadline {
        visual.run_until_parked();
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(
        !held.writes().is_empty(),
        "the real writer must enter the barrier"
    );
    let input_started = Instant::now();
    for offset in 0..3 {
        visual
            .cx
            .simulate_window_move(handle, point(px(240. + offset as f32), px(160.)));
        visual
            .cx
            .simulate_window_resize(handle, size(px(900. + offset as f32), px(700.)));
        draw(&mut visual);
    }
    visual.simulate_keystrokes("ctrl-k w r i t e r");
    println!(
        "held writer input: {:.3}s, forced={}, attempted writes={}",
        input_started.elapsed().as_secs_f64(),
        held.forced(),
        held.writes().len()
    );
    let _ = input_done.send(());
    watchdog.join().unwrap();
    assert!(
        !held.forced(),
        "bounds and input blocked on the held state writer"
    );
    assert_eq!(shell.read_with(&visual, |s, _| s.query.clone()), "writer");
    assert_eq!(
        shell.read_with(&visual, |s, _| s.state.bounds),
        [242., 160., 902., 700.]
    );
    assert_eq!(
        held.writes().len(),
        1,
        "bounds writes must coalesce behind the in-flight write"
    );
    // Close before the final bounds observer runs. The window must survive
    // until the held writer commits these actual bounds.
    visual
        .cx
        .simulate_window_move(handle, point(px(320.), px(220.)));
    visual
        .cx
        .simulate_window_resize(handle, size(px(980.), px(740.)));
    assert!(
        !visual.simulate_close_request(),
        "close must await the held writer"
    );
    assert!(visual.cx.windows().contains(&handle));
    held.release();
    let deadline = Instant::now() + Duration::from_secs(5);
    while visual.cx.windows().contains(&handle) && Instant::now() < deadline {
        visual.run_until_parked();
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(
        !visual.cx.windows().contains(&handle),
        "close must finish after the final write"
    );
    let saved = State::load(&file).unwrap();
    assert_eq!(saved.bounds, [320., 220., 980., 740.]);
    assert!(
        held.writes().len() <= 2,
        "close writes only the final pending snapshot"
    );
}

#[gpui::test]
fn window_state_failed_close_keeps_input_and_retries(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join("retry-writer.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    ready(&shell, &mut visual);
    wait_saved(&shell, &mut visual);
    fs::remove_file(&file).unwrap();
    fs::create_dir(&file).unwrap();
    let handle = visual.update(|window, _| window.window_handle());
    assert!(!visual.simulate_close_request());
    let deadline = Instant::now() + Duration::from_secs(5);
    while shell.read_with(&visual, |s, _| {
        s.features
            .read::<super::Runtime>()
            .is_some_and(|r| r.closing)
    }) && Instant::now() < deadline
    {
        visual.run_until_parked();
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(!shell.read_with(&visual, |s, _| {
        s.features
            .read::<super::Runtime>()
            .is_some_and(|r| r.closing)
    }));
    assert!(visual.cx.windows().contains(&handle));
    assert!(shell.read_with(&visual, |s, _| {
        s.notice.contains("View state remains in memory")
    }));
    visual.simulate_keystrokes("ctrl-k r e t r y");
    assert_eq!(shell.read_with(&visual, |s, _| s.query.clone()), "retry");
    fs::remove_dir(&file).unwrap();
    close(&mut visual);
    assert!(!State::load(&file).unwrap().workspaces.is_empty());
}

#[gpui::test]
fn window_state_pending_close_recaptures_composer_focus(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join("pending-close-focus.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| {
        let Some(Tab::Session(id)) = s.active() else {
            panic!("session")
        };
        s.execute(Command::Session(id), window, cx);
    });
    wait_saved(&shell, &mut visual);
    let mut held = crate::shell_state::barrier::hold(&file);
    let (input_done, watchdog) = held.input_watchdog();
    let handle = visual.update(|window, _| window.window_handle());
    assert!(
        !visual.simulate_close_request(),
        "native close must remain pending while the writer is held"
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while held.writes().is_empty() && Instant::now() < deadline {
        visual.run_until_parked();
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(
        !held.writes().is_empty(),
        "the close write must enter the real barrier"
    );
    let input_started = Instant::now();
    visual.simulate_keystrokes("tab");
    println!(
        "pending close Tab: {:.3}ms",
        input_started.elapsed().as_secs_f64() * 1000.
    );
    shell.update_in(&mut visual, |s, window, cx| {
        let content = &s.content[&s.key(&s.active().unwrap())];
        let Content::Session(view) = content else {
            panic!("session")
        };
        assert!(
            view.read(cx).shell_selection(window, cx).1,
            "Tab must focus the live composer while close is pending"
        );
    });
    let _ = input_done.send(());
    watchdog.join().unwrap();
    assert!(
        !held.forced(),
        "pending close must not block native input on disk I/O"
    );
    assert!(visual.cx.windows().contains(&handle));
    held.release();
    let deadline = Instant::now() + Duration::from_secs(5);
    while visual.cx.windows().contains(&handle) && Instant::now() < deadline {
        visual.run_until_parked();
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(
        !visual.cx.windows().contains(&handle),
        "close must finish after the latest captured state is durable"
    );
    let saved = State::load(&file).unwrap();
    assert!(
        saved.workspaces[saved.selected.as_deref().unwrap()].composer,
        "close must save the composer focus reached after its first snapshot"
    );
}
