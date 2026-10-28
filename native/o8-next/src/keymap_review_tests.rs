//! Corrections exercised through the hidden production shell and key dispatcher.
use super::test_support::*;
use super::*;

fn fixture_shell(cx: &mut TestAppContext) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("review.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    (fixture, shell, visual)
}
fn two_tabs(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    cx.simulate_keystrokes("cmd-k g r i d enter");
    ready(shell, cx);
    let first = cx.debug_bounds("surface-tab-0").unwrap();
    cx.simulate_click(first.center(), gpui::Modifiers::default());
    ready(shell, cx);
}
#[gpui::test]
fn final_review_ctrl_tab_keeps_main_composer_contract(cx: &mut TestAppContext) {
    let (_fixture, shell, mut cx) = fixture_shell(cx);
    two_tabs(&shell, &mut cx);
    cx.simulate_keystrokes("ctrl-k n e w enter");
    ready(&shell, &mut cx);
    assert!(shell.read_with(&cx, |s, _| s.current().unwrap().composer));
    cx.simulate_input("retained composer draft");
    cx.simulate_keystrokes("ctrl-tab");
    ready(&shell, &mut cx);
    assert_eq!(
        shell.read_with(&cx, |s, _| s.active()),
        Some(Tab::Grid),
        "main's Ctrl+Tab cycles directly from the focused composer"
    );
}

#[gpui::test]
fn final_review_settings_close_keeps_main_field_contract(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (shell, mut cx) = open(
        fixture.client.clone(),
        fixture.root.join("settings-close.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut cx);
    let tab = shell.read_with(&cx, |s, _| s.active());
    cx.simulate_keystrokes("ctrl-,");
    cx.run_until_parked();
    draw(&mut cx);
    assert!(shell.read_with(&cx, |s, _| s.surfaces.settings.view.is_some()));
    cx.simulate_keystrokes("cmd-w");
    draw(&mut cx);
    assert!(
        shell.read_with(&cx, |s, _| s.surfaces.settings.view.is_some()),
        "main's Settings close chord is Control+W, not Command+W"
    );
    cx.simulate_keystrokes("ctrl-w");
    cx.run_until_parked();
    draw(&mut cx);
    assert!(
        shell.read_with(&cx, |s, _| s.surfaces.settings.view.is_none()),
        "main's Ctrl+W closes non-editing Settings"
    );
    assert_eq!(shell.read_with(&cx, |s, _| s.active()), tab);
    cx.simulate_keystrokes("ctrl-,");
    shell.update_in(&mut cx, |s, window, _| s.focus.focus(window));
    draw(&mut cx);
    let shell_focus = cx.update(|window, cx| window.focused(cx));
    cx.simulate_keystrokes("ctrl-f");
    assert_eq!(cx.update(|window, cx| window.focused(cx)), shell_focus);
    cx.simulate_keystrokes("ctrl-w");
    cx.run_until_parked();
    draw(&mut cx);
    assert!(shell.read_with(&cx, |s, _| s.surfaces.settings.view.is_none()));
    cx.simulate_keystrokes("ctrl-, ctrl-shift-w");
    draw(&mut cx);
    assert!(
        shell.read_with(&cx, |s, _| s.surfaces.settings.view.is_none()),
        "main's Settings close handler also accepts Control+Shift+W"
    );
    cx.simulate_keystrokes("ctrl-, ctrl-f");
    cx.simulate_input("field draft");
    let focus = cx.update(|window, cx| window.focused(cx));
    cx.simulate_keystrokes("ctrl-w");
    draw(&mut cx);
    assert!(shell.read_with(&cx, |s, _| s.surfaces.settings.view.is_some()));
    assert_eq!(cx.update(|window, cx| window.focused(cx)), focus);
    assert_eq!(shell.read_with(&cx, |s, _| s.active()), tab);
}
#[gpui::test]
fn review_reference_command_alias(cx: &mut TestAppContext) {
    let (_fixture, shell, mut cx) = fixture_shell(cx);
    cx.simulate_keystrokes("cmd-/");
    draw(&mut cx);
    assert!(
        shell.read_with(&cx, |s, _| s.surfaces.shortcuts.view.is_some()),
        "Cmd+/ must open the reference from the focused list"
    );
}
#[gpui::test]
fn review_reference_escape_closes(cx: &mut TestAppContext) {
    let (_fixture, shell, mut cx) = fixture_shell(cx);
    cx.simulate_keystrokes("?");
    draw(&mut cx);
    assert!(shell.read_with(&cx, |s, _| s.surfaces.shortcuts.view.is_some()));
    cx.simulate_keystrokes("escape");
    draw(&mut cx);
    assert!(
        shell.read_with(&cx, |s, _| s.surfaces.shortcuts.view.is_none()),
        "Escape must close the visible reference"
    );
}
#[gpui::test]
fn review_numbered_surface_binding(cx: &mut TestAppContext) {
    let (_fixture, shell, mut cx) = fixture_shell(cx);
    two_tabs(&shell, &mut cx);
    cx.simulate_keystrokes("cmd-2");
    ready(&shell, &mut cx);
    assert_eq!(
        shell.read_with(&cx, |s, _| s.active()),
        Some(Tab::Grid),
        "Cmd+2 must select surface two"
    );
    cx.simulate_keystrokes("cmd-9");
    assert_eq!(
        shell.read_with(&cx, |s, _| s.active()),
        Some(Tab::Grid),
        "absent surfaces keep selection"
    );
}
#[gpui::test]
fn review_directional_surface_binding(cx: &mut TestAppContext) {
    let (_fixture, shell, mut cx) = fixture_shell(cx);
    two_tabs(&shell, &mut cx);
    cx.simulate_keystrokes("cmd-alt-right");
    ready(&shell, &mut cx);
    assert_eq!(
        shell.read_with(&cx, |s, _| s.active()),
        Some(Tab::Grid),
        "Cmd+Alt+Right must select the next surface"
    );
    cx.simulate_keystrokes("cmd-alt-left");
    ready(&shell, &mut cx);
    assert!(matches!(
        shell.read_with(&cx, |s, _| s.active()),
        Some(Tab::Session(_))
    ));
}
#[test]
fn review_pattern_documentation_avoids_product_attribution() {
    let attribution =
        regex::Regex::new(r"(?i)\b[a-z]+'s public|https?://[^\s)]+|\bno [a-z]+ application crates")
            .unwrap();
    for (file, source) in [
        ("keymap.rs", include_str!("keymap.rs")),
        ("terminal.rs", include_str!("terminal.rs")),
        (
            "verification.md",
            include_str!("../evidence/keymap/verification.md"),
        ),
    ] {
        assert!(
            !attribution.is_match(source),
            "{file} must describe the context pattern without naming an external product"
        );
    }
}
#[gpui::test]
#[ignore = "release CPU measurement; run explicitly without competing workloads"]
fn review_palette_release_cpu_frame_budget(cx: &mut TestAppContext) {
    assert!(
        !std::hint::black_box(cfg!(debug_assertions)),
        "measure the optimized production path"
    );
    let (_fixture, shell, mut cx) = fixture_shell(cx);
    let mut samples = vec![];
    let mut dispatch_samples = vec![];
    let mut paint_samples = vec![];
    for i in 0..90 {
        let started = std::time::Instant::now();
        cx.update(|window, cx| {
            window.dispatch_keystroke(gpui::Keystroke::parse("cmd-k").unwrap(), cx);
        });
        let dispatch_ms = started.elapsed().as_secs_f64() * 1000.;
        cx.update(|window, cx| {
            window.draw(cx).clear();
        });
        shell.read_with(&cx, |s, _| {
            assert!(s.palette);
            assert_eq!(
                s.painted.get(),
                s.revision,
                "first CPU scene must acknowledge this action"
            );
        });
        let elapsed = started.elapsed().as_secs_f64() * 1000.;
        if i == 10 {
            println!("PALETTE_DISPATCH_FIRST_SAMPLE_MS {dispatch_ms}");
        }
        if i >= 10 {
            samples.push(elapsed);
            dispatch_samples.push(dispatch_ms);
            paint_samples.push(elapsed - dispatch_ms);
        }
        cx.update(|window, cx| {
            window.dispatch_keystroke(gpui::Keystroke::parse("escape").unwrap(), cx);
        });
        cx.update(|window, cx| {
            window.draw(cx).clear();
        });
    }
    samples.sort_by(f64::total_cmp);
    dispatch_samples.sort_by(f64::total_cmp);
    paint_samples.sort_by(f64::total_cmp);
    let median = samples[samples.len() / 2];
    let p95 = samples[(samples.len() * 95 / 100).min(samples.len() - 1)];
    println!(
        "PALETTE_CPU_FRAME {}",
        serde_json::json!({"profile":"release", "endpoint":"hidden production shell key dispatch to first CPU scene", "samples":samples.len(), "medianMs":median, "p95Ms":p95, "medianDispatchMs":dispatch_samples[dispatch_samples.len()/2], "medianPaintMs":paint_samples[paint_samples.len()/2]})
    );
    assert!(
        median < 2.,
        "palette key-to-CPU-frame median must stay under 2 ms; got {median}"
    );
}

#[gpui::test]
fn review_reference_modal_keeps_tabs_and_restores_focus(cx: &mut TestAppContext) {
    let (_fixture, shell, mut cx) = fixture_shell(cx);
    two_tabs(&shell, &mut cx);
    let first = shell.read_with(&cx, |s, _| s.active());
    let focus = cx.update(|window, cx| window.focused(cx));
    cx.simulate_keystrokes("cmd-/");
    draw(&mut cx);
    assert!(shell.read_with(&cx, |s, _| s.surfaces.shortcuts.view.is_some()));
    cx.simulate_keystrokes("cmd-2 cmd-alt-right ctrl-tab");
    draw(&mut cx);
    assert_eq!(
        shell.read_with(&cx, |s, _| s.active()),
        first,
        "the modal reference must keep tab chords off the underlying tabs"
    );
    cx.simulate_keystrokes("cmd-/");
    draw(&mut cx);
    assert!(shell.read_with(&cx, |s, _| s.surfaces.shortcuts.view.is_none()));
    assert_eq!(
        cx.update(|window, cx| window.focused(cx)),
        focus,
        "Cmd+/ dismissal must restore the focused view"
    );
    cx.simulate_keystrokes("cmd-/ cmd-2 cmd-alt-right ctrl-tab");
    draw(&mut cx);
    assert_eq!(
        shell.read_with(&cx, |s, _| s.active()),
        first,
        "the modal reference must keep tab chords off the underlying tabs"
    );
    cx.simulate_keystrokes("escape");
    draw(&mut cx);
    assert!(shell.read_with(&cx, |s, _| s.surfaces.shortcuts.view.is_none()));
    assert_eq!(
        cx.update(|window, cx| window.focused(cx)),
        focus,
        "Escape must restore the focused view"
    );
    cx.simulate_keystrokes("cmd-2");
    ready(&shell, &mut cx);
    assert_eq!(shell.read_with(&cx, |s, _| s.active()), Some(Tab::Grid));
    cx.simulate_keystrokes("cmd-1");
    ready(&shell, &mut cx);
    assert_eq!(
        shell.read_with(&cx, |s, _| s.active()),
        first,
        "dismissed reference must return shortcut ownership to the selected surface"
    );
    assert_eq!(
        cx.update(|window, cx| window.focused(cx)),
        focus,
        "returning from Grid must restore the original surface's focus"
    );
}

#[test]
fn review_surfaces_attach_shortcuts_only_through_the_keymap() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let raw_listener = regex::Regex::new(r"\.(?:on|capture)_key_down\s*\(").unwrap();
    let mut pending = vec![root.clone()];
    let mut offenders = vec![];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|extension| extension == "rs")
                && path != root.join("keymap.rs")
                && raw_listener.is_match(&std::fs::read_to_string(&path).unwrap())
            {
                offenders.push(path.strip_prefix(&root).unwrap().to_path_buf());
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "surface raw shortcut listeners: {offenders:?}"
    );
}

// Hostile review: a capture-phase shell shortcut must never preempt a field.
#[gpui::test]
fn keymap_text_focus_keeps_palette_and_close_out(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("keys.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    cx.simulate_keystrokes("ctrl-k n e w enter");
    ready(&shell, cx);
    let before = shell.read_with(cx, |s, _| s.active());
    cx.simulate_input("draft?");
    cx.simulate_keystrokes("ctrl-k");
    assert!(
        !shell.read_with(cx, |s, _| s.palette),
        "focused text owns Ctrl+K"
    );
    cx.simulate_keystrokes("ctrl-w cmd-w");
    assert_eq!(
        shell.read_with(cx, |s, _| s.active()),
        before,
        "focused text must keep its surface"
    );
}

// Hostile review: extra modifiers must not turn a terminal chord into a shell command.
#[gpui::test]
fn keymap_modified_palette_chord_does_not_open_palette(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("modifiers.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-alt-k");
    assert!(
        !shell.read_with(&visual, |s, _| s.palette),
        "Ctrl+Alt+K is not Ctrl+K"
    );
    visual.simulate_keystrokes("cmd-shift-k");
    assert!(
        !shell.read_with(&visual, |s, _| s.palette),
        "shortcut modifiers must match exactly"
    );
}

#[gpui::test]
fn keymap_composer_focus_survives_surface_switch_and_reconnect(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("focus-return.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    cx.simulate_keystrokes("ctrl-k n e w enter");
    ready(&shell, cx);
    cx.simulate_input("unsent focus fixture");
    let composer_focus = cx.update(|window, cx| window.focused(cx).unwrap());
    draw(cx);
    let commands = cx.debug_bounds("Commands").unwrap();
    cx.simulate_click(commands.center(), gpui::Modifiers::default());
    cx.simulate_keystrokes("g r i d enter");
    ready(&shell, cx);
    assert_eq!(shell.read_with(cx, |s, _| s.active()), Some(Tab::Grid));
    let first_tab = cx.debug_bounds("surface-tab-0").unwrap();
    cx.simulate_click(first_tab.center(), gpui::Modifiers::default());
    ready(&shell, cx);
    assert!(
        cx.update(|window, _| composer_focus.is_focused(window)),
        "returning to a surface must restore its focused field"
    );
    cx.simulate_keystrokes("ctrl-shift-p r e f r e s h enter");
    ready(&shell, cx);
    cx.run_until_parked();
    draw(cx);
    assert!(shell.read_with(cx, |s, _| s.connected && !s.loading));
    assert!(
        cx.update(|window, _| composer_focus.is_focused(window)),
        "connection refresh must preserve composer focus"
    );
}

#[gpui::test]
fn keymap_composer_keeps_focus_through_real_socket_reconnect(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("socket-focus.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    shell.update_in(cx, |s, window, cx| {
        let repo = s
            .sessions
            .iter()
            .find(|session| session.id == "thoughts-long")
            .unwrap()
            .repo_path
            .clone()
            .unwrap();
        s.switch(repo, window, cx);
        s.execute(Command::Message("thoughts-long".into()), window, cx);
    });
    ready(&shell, cx);
    cx.simulate_input("socket reconnect draft");
    let focus = cx.update(|window, cx| window.focused(cx).unwrap());
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut interrupted = false;
    loop {
        shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
        draw(cx);
        let notice = shell.read_with(cx, |s, cx| {
            let Content::Session(session) = s.content.get(&s.key(&s.active().unwrap())).unwrap()
            else {
                panic!("session");
            };
            session.read(cx).shell_issue_state(cx)["notice"]
                .as_str()
                .unwrap()
                .to_owned()
        });
        interrupted |= notice.starts_with("Reconnecting");
        assert!(
            cx.update(|window, _| focus.is_focused(window)),
            "socket progress must never steal composer focus"
        );
        if interrupted && notice.is_empty() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "owned replay must disconnect and reconnect (saw_disconnect={interrupted}, status={notice:?})"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    shell.read_with(cx, |s, cx| {
        let Content::Session(session) = s.content.get(&s.key(&s.active().unwrap())).unwrap() else {
            panic!("session");
        };
        assert_eq!(
            session.read(cx).shell_issue_state(cx)["draft"],
            "socket reconnect draft"
        );
    });
}

#[gpui::test]
fn keymap_reference_is_reachable_and_field_question_mark_is_text(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("reference.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    cx.simulate_keystrokes("?");
    draw(cx);
    assert!(cx.debug_bounds("keyboard-shortcuts").is_some());
    cx.simulate_keystrokes("escape ctrl-k n e w enter");
    ready(&shell, cx);
    cx.simulate_keystrokes("?");
    draw(cx);
    assert!(
        shell.read_with(cx, |s, _| s.surfaces.shortcuts.view.is_none()),
        "field question mark must not toggle reference"
    );
}
