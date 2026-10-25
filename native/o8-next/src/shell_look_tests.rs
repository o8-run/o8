use super::*;

#[gpui::test]
fn correction_rebase_keeps_header_without_secondary_labels(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("rebased-header.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    assert!(
        visual.debug_bounds("o8 next alpha").is_none(),
        "rebasing the frame extension must not restore the alpha label"
    );
    assert!(
        visual.debug_bounds("Commands (Ctrl+K / Cmd+K)").is_none(),
        "rebasing the frame extension must not restore permanent shortcut text"
    );
    assert!(visual.debug_bounds("workspace-switcher").is_some());
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires an owned isolated X11 display, Vulkan software driver and PNG capture tool"]
fn correction_native_screenshots() {
    let directory = fs::canonicalize(
        std::env::var("O8_NEXT_SCREENSHOT_DIR").expect("explicit screenshot directory"),
    )
    .unwrap();
    let binary =
        fs::canonicalize(std::env::var("O8_NEXT_NATIVE_BINARY").expect("built native X11 binary"))
            .unwrap();
    let width = std::env::var("O8_NEXT_SCREENSHOT_WIDTH")
        .unwrap()
        .parse::<f32>()
        .unwrap();
    let height = if width < 1000. { 700. } else { 816. };
    let fixture = Fixture::start_mode(false, "--shell-many");
    let file = fixture.root.join("screenshots.json");
    let mut state = State::default();
    state.bounds = [0., 0., width, height];
    state.save(&file).unwrap();
    let mut child = Process::new(binary)
        .args([
            "--enable-next",
            "--app-shell",
            "--server",
            &fixture.origin,
            "--shell-state",
        ])
        .arg(file)
        .env("O8_NEXT_API_TOKEN", "fixture-shell-bearer")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let output = directory.join(if width < 1000. {
        "narrow.png"
    } else {
        "default.png"
    });
    let mut captured = false;
    for _ in 0..50 {
        std::thread::sleep(Duration::from_millis(200));
        let capture = Process::new("import")
            .args([
                "-screen",
                "-window",
                "o8 next",
                "-crop",
                &format!("{}x{}+0+0", width as u32, height as u32),
            ])
            .arg(&output)
            .output()
            .unwrap();
        if capture.status.success()
            && fs::metadata(&output).is_ok_and(|metadata| metadata.len() > 5000)
        {
            captured = true;
            break;
        }
        if child.try_wait().unwrap().is_some() {
            break;
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        captured,
        "native CLI must paint text pixels before capture on the owned display"
    );
}

#[gpui::test]
fn correction_refresh_recovers_initial_history_503(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--history-fail-once");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("recovery.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    for _ in 0..4 {
        cx.run_until_parked();
        draw(cx);
    }
    shell.read_with(cx, |s, cx| {
        let Content::Session(session) = s.content.get(&s.key(&s.active().unwrap())).unwrap() else {
            panic!("session")
        };
        assert!(
            session.read(cx).shell_issue_state(cx)["notice"]
                .as_str()
                .unwrap()
                .contains("503")
        );
    });
    cx.simulate_keystrokes("cmd-shift-p");
    cx.simulate_keystrokes("r e f r e s h enter");
    cx.run_until_parked();
    draw(cx);
    shell.read_with(cx, |s, cx| {
        let Content::Session(session) = s.content.get(&s.key(&s.active().unwrap())).unwrap() else {
            panic!("session")
        };
        assert!(
            session.read(cx).shell_ready(),
            "palette Refresh must reload a failed initial history after HTTP recovery"
        );
    });
}

#[gpui::test]
fn correction_fifteenth_workspace_scrolls_into_view(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--shell-many");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("scroll.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    for (width, height) in [(1200., 816.), (900., 700.)] {
        cx.simulate_resize(size(px(width), px(height)));
        draw(cx);
        let switcher = cx.debug_bounds("workspace-switcher").unwrap();
        cx.simulate_click(switcher.center(), gpui::Modifiers::default());
        draw(cx);
        for _ in 0..14 {
            cx.simulate_keystrokes("down");
            draw(cx);
        }
        assert_eq!(shell.read_with(cx, |s, _| s.choice), 14);
        let palette = cx.debug_bounds("command-palette").unwrap();
        let selected = cx.debug_bounds("command-14").unwrap();
        assert!(
            selected.top() >= palette.top() && selected.bottom() <= palette.bottom(),
            "keyboard-selected workspace 15 must stay inside the visible palette: row={selected:?}, palette={palette:?}"
        );
        println!("workspace 15 at {width}x{height}: row={selected:?}, palette={palette:?}");
        cx.simulate_click(selected.center(), gpui::Modifiers::default());
        ready(&shell, cx);
        assert_eq!(
            shell.read_with(cx, |s, _| s.state.selected.clone()),
            shell.read_with(cx, |s, _| Some(s.workspaces[14].clone()))
        );
    }
}

#[gpui::test]
fn correction_palette_brain_resumes_the_session_draft(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("brain-resume.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let active = shell.read_with(cx, |s, _| s.active());
    cx.simulate_keystrokes("cmd-e");
    draw(cx);
    cx.simulate_input("Retained Brain draft");
    cx.simulate_keystrokes("escape");
    draw(cx);
    cx.simulate_keystrokes("cmd-shift-p");
    cx.simulate_keystrokes("b r a i n enter");
    draw(cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s.active()),
        active,
        "palette Brain and Cmd+E must use the same retained session conversation"
    );
    cx.simulate_input(" via palette");
    shell.read_with(cx, |s, cx| {
        let Content::Session(session) = s.content.get(&s.key(&s.active().unwrap())).unwrap() else {
            panic!("session")
        };
        assert_eq!(
            session.read(cx).shell_issue_state(cx)["brainDraft"],
            "Retained Brain draft via palette"
        );
    });
    cx.simulate_keystrokes("cmd-shift-p");
    cx.simulate_keystrokes("n e w enter");
    draw(cx);
    cx.simulate_input("Main draft");
    shell.read_with(cx, |s, cx| {
        let Content::Session(session) = s.content.get(&s.key(&s.active().unwrap())).unwrap() else {
            panic!("session")
        };
        assert_eq!(
            session.read(cx).shell_issue_state(cx)["draft"],
            "Main draft",
            "New message must still focus the main composer beside an open Brain"
        );
    });
}

#[gpui::test]
fn shell_chrome_fifteen_workspaces_keeps_one_switcher(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--shell-many");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("chrome.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    assert_eq!(shell.read_with(cx, |s, _| s.workspaces.len()), 15);
    assert!(
        cx.debug_bounds("workspace-switcher").is_some(),
        "15 workspaces must share one switcher"
    );
    assert!(
        cx.debug_bounds("workspace-0").is_none(),
        "workspace choices stay out of permanent chrome"
    );
    assert!(
        shell.read_with(cx, |s, _| s.notice.is_empty()),
        "connected shell has no permanent hints"
    );
    assert!(
        cx.debug_bounds("session-refresh").is_none(),
        "embedded session has no duplicate header"
    );
    let mut layouts = vec![];
    for (width, height) in [(900., 700.), (1680., 1050.)] {
        cx.simulate_resize(size(px(width), px(height)));
        draw(cx);
        let bounds = cx.debug_bounds("workspace-switcher").unwrap();
        assert!(bounds.right() <= px(width));
        assert!(bounds.size.height <= px(40.));
        layouts.push(json!({"viewport":[width,height], "switcher":[f32::from(bounds.origin.x),f32::from(bounds.origin.y),f32::from(bounds.size.width),f32::from(bounds.size.height)]}));
        cx.simulate_click(bounds.center(), gpui::Modifiers::default());
        draw(cx);
        assert!(cx.debug_bounds("command-14").is_some());
        assert!(
            cx.debug_bounds("command-15").is_none(),
            "the workspace switcher renders only its fifteen workspace rows"
        );
        cx.simulate_keystrokes("escape");
    }
    if let Ok(file) = std::env::var("O8_NEXT_CHROME_EVIDENCE") {
        fs::write(file, serde_json::to_vec_pretty(&json!({"endpoint":"headless GPUI layout; no raster or compositor capture", "workspaces":15,"permanentWorkspaceControls":1,"layouts":layouts})).unwrap()).unwrap();
    }
}

#[gpui::test]
fn chrome_switcher_cancel_restores_composer_with_platform_shortcut(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("focus.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    cx.simulate_keystrokes("cmd-shift-p");
    cx.simulate_keystrokes("n e w enter");
    ready(&shell, cx);
    draw(cx);
    cx.simulate_input("Draft");
    let switcher = cx.debug_bounds("workspace-switcher").unwrap();
    cx.simulate_click(switcher.center(), gpui::Modifiers::default());
    draw(cx);
    cx.simulate_keystrokes("escape");
    draw(cx);
    cx.simulate_input(" retained");
    cx.simulate_keystrokes("cmd-shift-p");
    cx.simulate_keystrokes("r e f r e s h enter");
    ready(&shell, cx);
    draw(cx);
    cx.simulate_input(" refreshed");
    shell.read_with(cx, |s, cx| {
        let Content::Session(session) = s.content.get(&s.key(&s.active().unwrap())).unwrap() else {
            panic!("session")
        };
        assert_eq!(
            session.read(cx).shell_issue_state(cx)["draft"],
            "Draft retained refreshed"
        );
    });
}

#[gpui::test]
fn chrome_refresh_keeps_workspace_selected_during_load(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("refresh.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let target = shell.read_with(cx, |s, _| s.workspaces[1].clone());
    shell.update_in(cx, |s, window, cx| {
        // Start the production palette command and switch before its background
        // inventory response can run on the foreground executor.
        s.execute(Command::Refresh, window, cx);
        assert!(s.loading);
        s.switch(target.clone(), window, cx);
    });
    ready(&shell, cx);
    cx.run_until_parked();
    assert_eq!(
        shell.read_with(cx, |s, _| s.state.selected.clone()),
        Some(target)
    );
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("s h o r t c u t s enter");
    draw(cx);
    assert!(cx.debug_bounds("shortcut-reference").is_some());
    cx.simulate_keystrokes("escape");
    assert!(!shell.read_with(cx, |s, _| s.shortcuts));
}

#[gpui::test]
fn correction_placement_uses_the_single_shell_header(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--composer-empty");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("single-header.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    let cx = &mut visual;
    for (width, height) in [(900., 700.), (1680., 1050.)] {
        cx.simulate_resize(size(px(width), px(height)));
        draw(cx);
        assert!(
            cx.debug_bounds("session-refresh").is_none(),
            "embedded conversation must not restore its duplicate header or Refresh control"
        );
        assert!(
            cx.debug_bounds("brain-open").is_none(),
            "embedded conversation must not restore a Brain control"
        );
        assert!(
            cx.debug_bounds("workspace-switcher").is_some(),
            "workspace navigation must retain the single shell header"
        );
        assert!(cx.debug_bounds("composer-card").is_some());
    }
    cx.simulate_keystrokes("cmd-shift-p");
    cx.simulate_keystrokes("b r a i n enter");
    draw(cx);
    let brain = cx
        .debug_bounds("right-panel-slot")
        .expect("palette Brain retains its right slot");
    let composer = cx.debug_bounds("composer-card").unwrap();
    assert!(brain.left() >= composer.right());
}

#[gpui::test]
fn placement_shell_tabs_use_compact_rows(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("tabs.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    let tab = visual
        .debug_bounds("surface-tab-0")
        .expect("top tab geometry");
    assert_eq!(tab.size.height, px(26.));
    let row = visual
        .debug_bounds("session-thoughts-composer-first")
        .unwrap();
    assert_eq!(row.size.height, px(28.));
}
