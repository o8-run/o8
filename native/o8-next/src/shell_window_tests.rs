use super::test_support::*;
use super::*;

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
    assert!(!visual.simulate_close(), "close must await the held writer");
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
    assert!(!visual.simulate_close());
    let deadline = Instant::now() + Duration::from_secs(5);
    while shell.read_with(&visual, |s, _| s.closing) && Instant::now() < deadline {
        visual.run_until_parked();
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(!shell.read_with(&visual, |s, _| s.closing));
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
fn corrupt_shell_state_is_preserved_before_autosave(cx: &mut TestAppContext) {
    preserves_recovered_state(cx, b"{broken state");
}

#[gpui::test]
fn empty_shell_state_is_preserved_before_autosave(cx: &mut TestAppContext) {
    preserves_recovered_state(cx, b"");
}

#[gpui::test]
fn future_shell_state_is_preserved_before_autosave(cx: &mut TestAppContext) {
    let mut future = serde_json::to_value(State::default()).unwrap();
    future["version"] = json!(999);
    preserves_recovered_state(cx, &serde_json::to_vec(&future).unwrap());
}

fn preserves_recovered_state(cx: &mut TestAppContext, original: &[u8]) {
    let fixture = Fixture::new();
    let file = fixture.root.join("state.json");
    fs::write(&file, original).unwrap();
    let state = State::load(&file).unwrap();
    assert_eq!(
        fs::read(&file).unwrap(),
        original,
        "loading does not move the input"
    );
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), state, cx);
    ready(&shell, &mut visual); // The production successful-load path autosaves.
    let backups = || {
        fs::read_dir(&fixture.root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("state.json.bad-")
            })
            .collect::<Vec<_>>()
    };
    wait_saved(&shell, &mut visual);
    let retained = backups();
    assert_eq!(
        retained.len(),
        1,
        "autosave must preserve the original state before replacing it"
    );
    assert_eq!(fs::read(&retained[0]).unwrap(), original);
    let saved = State::load(&file).unwrap();
    assert_eq!(saved.version, 1);
    assert!(
        !saved.workspaces.is_empty(),
        "replacement contains the live shell state"
    );
    close(&mut visual);
    assert_eq!(
        backups(),
        retained,
        "later saves must not make more recovery copies"
    );
    assert_eq!(fs::read(&retained[0]).unwrap(), original);
}

#[gpui::test]
fn shell_restart_reads_geometry_surfaces_and_focus_from_the_same_file(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join("restart.json");
    let mut initial = State::default();
    initial.bounds = [-320., -40., 1000., 720.];
    initial.save(&file).unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        file.clone(),
        State::load(&file).unwrap(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    cx.simulate_keystrokes("ctrl-k g r i d enter");
    ready(&shell, cx);
    cx.simulate_keystrokes("ctrl-k n e w enter");
    ready(&shell, cx);
    let selected = shell.read_with(cx, |s, _| s.state.selected.clone());
    let active = shell.read_with(cx, |s, _| s.active());
    cx.simulate_keystrokes("ctrl-k");
    let handle = cx.update(|window, _| window.window_handle());
    // Close before the next draw/observer flush, as with a native resize/quit race.
    cx.cx
        .simulate_window_resize(handle, size(px(900.), px(700.)));
    close(cx);
    let saved = State::load(&file).unwrap();
    assert_eq!(saved.bounds, [0., 0., 900., 700.]);
    assert_eq!(saved.selected, selected);
    assert_eq!(
        saved
            .workspaces
            .values()
            .map(|w| w.tabs.len())
            .sum::<usize>(),
        2
    );
    assert!(saved.workspaces[saved.selected.as_deref().unwrap()].composer);
    let (restarted, mut visual) = open(
        fixture.client.clone(),
        file.clone(),
        State::load(&file).unwrap(),
        &mut cx.cx,
    );
    let cx = &mut visual;
    ready(&restarted, cx);
    assert_eq!(restarted.read_with(cx, |s, _| s.active()), active);
    assert_eq!(
        restarted.read_with(cx, |s, _| s.state.selected.clone()),
        selected
    );
    let view = restarted.read_with(cx, |s, _| match &s.content[&s.key(&s.active().unwrap())] {
        Content::Session(v) => v.clone(),
        _ => panic!("session"),
    });
    cx.update(|window, cx| {
        assert_eq!(
            window.window_bounds().get_bounds(),
            Bounds::new(point(px(0.), px(0.)), size(px(900.), px(700.)))
        );
        assert!(view.read(cx).shell_selection(window, cx).1);
    });
}

#[gpui::test]
fn shell_corrupt_or_missing_file_opens_defaults_without_crashing(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join(".").join("fallback.json");
    let mut invalid = serde_json::to_value(State::default()).unwrap();
    invalid["bounds"] = json!([100., 100., 1., 1.]);
    let mut future = serde_json::to_value(State::default()).unwrap();
    future["version"] = json!(999);
    for bytes in [
        None,
        Some(b"{".to_vec()),
        Some(vec![0xff, 0xfe]),
        Some(serde_json::to_vec(&invalid).unwrap()),
        Some(serde_json::to_vec(&future).unwrap()),
        Some(vec![b' '; 1024 * 1024 + 1]),
    ] {
        if let Some(bytes) = bytes {
            fs::write(&file, bytes).unwrap();
        } else {
            let _ = fs::remove_file(&file);
        }
        let state = State::load(&file).expect("invalid view state must fall back to defaults");
        assert_eq!(state.bounds, State::default().bounds);
        assert!(state.workspaces.is_empty());
        let (shell, mut visual) = open(fixture.client.clone(), file.clone(), state, cx);
        ready(&shell, &mut visual);
        assert!(shell.read_with(&visual, |s, _| s.connected
            && matches!(s.active(), Some(Tab::Session(_)))));
        close(&mut visual);
        assert_eq!(State::load(&file).unwrap().bounds, State::default().bounds);
    }
}

#[gpui::test]
fn shell_restart_keeps_surface_focus_when_palette_is_open_at_quit(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    for composer in [false, true] {
        let file = fixture.root.join(format!("focus-{composer}.json"));
        let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
        let visual_cx = &mut visual;
        ready(&shell, visual_cx);
        shell.update_in(visual_cx, |s, window, cx| {
            let Some(Tab::Session(id)) = s.active() else {
                panic!("session")
            };
            s.execute(
                if composer {
                    Command::Message(id)
                } else {
                    Command::Session(id)
                },
                window,
                cx,
            );
        });
        visual_cx.simulate_keystrokes("ctrl-k");
        close(visual_cx);
        let saved = State::load(&file).unwrap();
        assert_eq!(
            saved.workspaces[saved.selected.as_deref().unwrap()].composer,
            composer
        );
        let (restarted, mut visual) = open(fixture.client.clone(), file.clone(), saved, cx);
        ready(&restarted, &mut visual);
        let view = restarted.read_with(&visual, |s, _| {
            match &s.content[&s.key(&s.active().unwrap())] {
                Content::Session(v) => v.clone(),
                _ => panic!("session"),
            }
        });
        visual.update(|window, cx| {
            assert_eq!(view.read(cx).shell_selection(window, cx).1, composer);
            assert!(!restarted.read(cx).focus.is_focused(window));
        });
        close(&mut visual);
    }
}

#[gpui::test]
#[cfg(unix)]
fn correction_unreadable_state_opens_defaults_and_preserves_the_input(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let directory = fixture.root.join("unreadable-state");
    fs::create_dir(&directory).unwrap();
    let sentinel = directory.join("retained");
    fs::write(&sentinel, b"original state source").unwrap();
    for (name, target) in [
        ("directory", directory.clone()),
        ("dangling", directory.join("missing")),
    ] {
        let file = fixture.root.join(format!("state-{name}.json"));
        std::os::unix::fs::symlink(&target, &file).unwrap();
        let state = State::load(&file).expect("unreadable state must fall back to defaults");
        assert_eq!(state.bounds, State::default().bounds);
        let (shell, mut visual) = open(fixture.client.clone(), file.clone(), state, cx);
        ready(&shell, &mut visual);
        close(&mut visual);
        assert!(
            fs::symlink_metadata(&file)
                .unwrap()
                .file_type()
                .is_symlink(),
            "startup and close must not replace an unreadable input: {name}"
        );
        assert_eq!(fs::read_link(&file).unwrap(), target);
        assert_eq!(fs::read(&sentinel).unwrap(), b"original state source");
    }
}

#[gpui::test]
fn correction_offscreen_geometry_is_clamped_before_the_window_opens(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join("removed-display.json");
    let mut state = State::default();
    state.bounds = [3560., 100., 900., 700.];
    state.save(&file).unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        file.clone(),
        State::load(&file).unwrap(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.update(|window, cx| {
        let bounds = window.window_bounds().get_bounds();
        assert!(
            cx.displays()
                .iter()
                .any(|display| display.bounds().contains(&bounds.origin)
                    && display.bounds().contains(&bounds.bottom_right())),
            "a removed display must not leave the restored window off screen"
        );
    });
    close(&mut visual);
    let saved = State::load(&file).unwrap();
    assert!(saved.bounds[0] < 1920.);
}
