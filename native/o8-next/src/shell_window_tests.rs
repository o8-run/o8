use super::test_support::*;
use super::*;

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
    assert!(cx.simulate_close());
    let saved = State::load(&file).unwrap();
    assert_eq!(saved.bounds, [-320., -40., 900., 700.]);
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
            Bounds::new(point(px(-320.), px(-40.)), size(px(900.), px(700.)))
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
        assert!(visual.simulate_close());
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
        assert!(visual_cx.simulate_close());
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
        assert!(visual.simulate_close());
    }
}
