use crate::shell::{test_support::*, *};

fn toggle(cx: &mut VisualTestContext) {
    draw(cx);
    let bounds = cx
        .debug_bounds("speed-toggle")
        .expect("Experimental speed control");
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
}

#[gpui::test]
fn speed_overlay_is_opt_in_compact_and_preserves_composer_focus(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("state.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    assert!(cx.debug_bounds("speed-panel").is_none());
    // Exercise actual shell command dispatch and the platform input contract.
    shell.update_in(cx, |s, window, cx| {
        let id = s.workspace_sessions()[0].id.clone();
        s.execute(Command::Message(id), window, cx);
    });
    ready(&shell, cx);
    toggle(cx);
    let bounds = cx.debug_bounds("speed-panel").expect("one compact panel");
    assert!(bounds.size.width <= px(360.) && bounds.size.height <= px(120.));
    for selector in ["speed-key", "speed-frame", "speed-wakeups", "speed-memory"] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    cx.simulate_input("fixture draft");
    draw(cx);
    shell.read_with(cx, |s, cx| {
        let content = s.content.get(&s.key(&s.active().unwrap())).unwrap();
        let Content::Session(view) = content else {
            panic!("session surface")
        };
        assert_eq!(
            view.read(cx).shell_issue_state(cx)["draft"],
            "fixture draft"
        );
    });
    toggle(cx);
    assert!(
        !shell.read_with(cx, |s, _| s.surfaces.speed.sample.borrow().enabled),
        "toggle must disable the probe"
    );
    cx.simulate_input(" retained");
    draw(cx);
    shell.read_with(cx, |s, cx| {
        let Content::Session(view) = s.content.get(&s.key(&s.active().unwrap())).unwrap() else {
            panic!("session")
        };
        assert_eq!(
            view.read(cx).shell_issue_state(cx)["draft"],
            "fixture draft retained"
        );
    });
}

#[gpui::test]
fn speed_overlay_keyboard_toggle_restores_composer(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (shell, mut visual) = open(
        f.client.clone(),
        f.root.join("focus.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    shell.update_in(cx, |s, window, cx| {
        let id = s.workspace_sessions()[0].id.clone();
        s.execute(Command::Message(id), window, cx);
    });
    ready(&shell, cx);
    for (index, shortcut) in ["ctrl-k", "cmd-k"].into_iter().enumerate() {
        cx.simulate_keystrokes(shortcut);
        shell.update_in(cx, |s, window, cx| s.execute(Command::Speed, window, cx));
        draw(cx);
        cx.simulate_input("a");
        shell.read_with(cx, |s, cx| {
            let Content::Session(view) = s.content.get(&s.key(&s.active().unwrap())).unwrap()
            else {
                panic!("session")
            };
            assert_eq!(
                view.read(cx).shell_issue_state(cx)["draft"],
                "a".repeat(index + 1),
                "keyboard opt-in must restore composer focus"
            );
        });
    }
}

#[gpui::test]
fn speed_overlay_discards_focus_changes_and_bounds_samples(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (shell, mut visual) = open(
        f.client.clone(),
        f.root.join("samples.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    shell.update_in(cx, |s, window, cx| {
        let id = s.workspace_sessions()[0].id.clone();
        s.execute(Command::Message(id), window, cx);
    });
    ready(&shell, cx);
    toggle(cx);
    let focus = shell.read_with(cx, |s, _| s.focus.clone());
    cx.update(|window, cx| {
        window.dispatch_keystroke(gpui::Keystroke::parse("a").unwrap(), cx);
        focus.focus(window);
    });
    draw(cx);
    shell.read_with(cx, |s, _| {
        assert!(
            s.surfaces.speed.sample.borrow().key_ms.is_empty(),
            "a focus change must discard pending input"
        )
    });
    shell.update_in(cx, |s, window, cx| s.restore_focus(window, cx));
    for _ in 0..80 {
        cx.simulate_keystrokes("a");
        draw(cx);
    }
    shell.read_with(cx, |s, _| {
        let sample = s.surfaces.speed.sample.borrow();
        assert!(sample.frame_ms.len() <= 64);
        assert_eq!(sample.key_ms.len(), 64);
        println!("O8_NEXT_SPEED {}", json!({"keyToCpuPaintMs":sample.key_ms.back(),"frameToCpuPaintMs":sample.frame_ms.back(),"retainedSamples":sample.key_ms.len()}));
    });
    toggle(cx);
    draw(cx);
    shell.read_with(cx, |s, _| {
        let sample = s.surfaces.speed.sample.borrow();
        assert!(sample.key_ms.is_empty() && sample.frame_ms.is_empty());
    });
}

#[gpui::test]
fn speed_overlay_ignores_memory_completion_from_a_previous_opt_in(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (shell, mut visual) = open(
        f.client.clone(),
        f.root.join("race.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    toggle(cx);
    shell.update_in(cx, |s, window, cx| {
        s.tick(false, window, cx);
        s.execute(Command::Speed, window, cx);
        s.execute(Command::Speed, window, cx);
    });
    cx.run_until_parked();
    draw(cx);
    shell.read_with(cx, |s, _| {
        let sample = s.surfaces.speed.sample.borrow();
        assert!(sample.enabled);
        assert!(
            sample.memory_mib.is_none(),
            "previous generation must not publish memory"
        );
        assert!(!sample.memory_pending);
    });
    shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
    cx.run_until_parked();
    shell.read_with(cx, |s, _| {
        assert!(
            s.surfaces
                .speed
                .sample
                .borrow()
                .memory_mib
                .is_some_and(|v| v > 0. && v.is_finite())
        )
    });
}

#[gpui::test]
fn speed_overlay_reopen_does_not_restore_old_samples_or_save_opt_in(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join("state.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    let cx = &mut visual;
    ready(&shell, cx);
    toggle(cx);
    cx.simulate_keystrokes("ctrl-k a");
    draw(cx);
    toggle(cx);
    toggle(cx);
    let bytes = fs::read_to_string(&file).unwrap();
    assert!(!bytes.contains("speed"), "opt-in must be process local");
    toggle(cx);
    // Reopening the actual window starts off, including on macOS canonical temp paths.
    let state = State::load(&fs::canonicalize(file).unwrap()).unwrap();
    let (_second, mut second_cx) = open(
        fixture.client.clone(),
        fixture.root.join("second.json"),
        state,
        cx,
    );
    second_cx.run_until_parked();
    draw(&mut second_cx);
    assert!(second_cx.debug_bounds("speed-panel").is_none());
}
