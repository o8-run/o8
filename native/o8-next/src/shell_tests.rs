use super::test_support::*;
use super::*;
use gpui::TestAppContext;
use serde_json::json;
use std::time::Instant;

#[test]
fn glass_and_plain_open_through_the_production_shell() {
    for mode in ["glass", "plain"] {
        let output = Process::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "shell::tests::glass_shell_probe",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("O8_NEXT_APPEARANCE", mode)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{mode} shell probe:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[gpui::test]
#[ignore = "isolated appearance probe, invoked by glass_and_plain_open_through_the_production_shell"]
fn glass_shell_probe(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("glass.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let glass = std::env::var("O8_NEXT_APPEARANCE").unwrap() == "glass";
    let theme = crate::theme::current();
    assert_eq!(
        theme.background.a,
        if glass { 0. } else { 1. },
        "requested glass must leave the native backdrop visible"
    );
    assert_eq!(theme.surface.a, if glass { 0. } else { 0.82 });
    assert_eq!(theme.surface_raised.a, if glass { 0.05 } else { 1. });
    assert!(
        !shell.read_with(cx, |s, _| s.system_glass),
        "headless windows use the plain fallback and never require an AppKit handle"
    );
    assert_eq!(
        material::background(true),
        gpui::WindowBackgroundAppearance::Opaque
    );
    cx.update(|window, _| window.activate_window());
    cx.deactivate_window();
    draw(cx);
    assert_eq!(
        crate::theme::current().background,
        theme.background,
        "focus changes must retain the selected material tokens"
    );
    if glass {
        // Emulate only the native adapter's success result. The production veil
        // and its input hit-testing still paint through the real shell view.
        shell.update(cx, |s, cx| {
            s.system_glass = true;
            cx.notify();
        });
        draw(cx);
        let workspace = cx.debug_bounds("workspace-1").unwrap();
        cx.simulate_click(workspace.center(), gpui::Modifiers::default());
        ready(&shell, cx);
        assert_eq!(
            shell.read_with(cx, |s, _| s.state.selected.clone()),
            shell.read_with(cx, |s, _| Some(s.workspaces[1].clone()))
        );
    }
    cx.simulate_keystrokes("cmd-k");
    draw(cx);
    assert!(shell.read_with(cx, |s, _| s.palette));
    cx.simulate_keystrokes("escape");
    assert!(!shell.read_with(cx, |s, _| s.palette));
    cx.simulate_resize(size(px(900.), px(700.)));
    draw(cx);
    assert!(cx.simulate_close());
    let saved = State::load(&fixture.root.join("glass.json")).unwrap();
    assert_eq!(saved.bounds[2..], [900., 700.]);
    // A closing window can still have session/inventory reads in flight.
    let (_, mut pending) = open(
        fixture.client.clone(),
        fixture.root.join("pending.json"),
        State::default(),
        &mut cx.cx,
    );
    assert!(pending.simulate_close());
    pending.run_until_parked();
    let (reopened, mut reopened_visual) = open(
        fixture.client.clone(),
        fixture.root.join("glass.json"),
        saved,
        &mut cx.cx,
    );
    ready(&reopened, &mut reopened_visual);
    if let Ok(directory) = std::env::var("O8_NEXT_GLASS_EVIDENCE") {
        fs::write(PathBuf::from(directory).join(if glass { "glass.json" } else { "plain.json" }), serde_json::to_vec_pretty(&json!({"endpoint":"headless production GPUI shell; no raster or compositor capture", "requested":if glass { "glass" } else { "plain" }, "nativeMaterialInstalled":false,"opaqueFallback":true,"surfaceAlpha":theme.surface.a,"raisedAlpha":theme.surface_raised.a,"restoredSize":[900,700],"paletteFocusAndCloseRace":true})).unwrap()).unwrap();
    }
}

#[gpui::test]
fn shell_palette_switch_restart_and_server_down(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join("shell.json");
    let start = Instant::now();
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    let cx = &mut visual;
    ready(&shell, cx);
    let launch = start.elapsed().as_secs_f64() * 1000.;
    assert_eq!(shell.read_with(cx, |s, _| s.workspaces.len()), 2);
    let initial = shell.read_with(cx, |s, _| s.state.selected.clone().unwrap());
    let mut palette = vec![];
    for _ in 0..20 {
        let start = Instant::now();
        cx.simulate_keystrokes("ctrl-shift-p");
        draw(cx);
        palette.push(start.elapsed().as_secs_f64() * 1000.);
        assert!(cx.debug_bounds("command-palette").is_some());
        shell.read_with(cx, |s, _| assert_eq!(s.painted.get(), s.revision));
        cx.simulate_keystrokes("escape");
    }
    // Filter and choose a real grid with keyboard events, then return to message input.
    cx.simulate_keystrokes("ctrl-shift-p");
    cx.simulate_keystrokes("g r i d enter");
    ready(&shell, cx);
    assert_eq!(shell.read_with(cx, |s, _| s.active()), Some(Tab::Grid));
    cx.simulate_keystrokes("ctrl-alt-w");
    assert_eq!(
        shell.read_with(cx, |s, _| s.active()),
        Some(Tab::Grid),
        "the grid close-pane shortcut must keep its enclosing shell surface open"
    );
    shell.read_with(cx, |s, cx| {
        match s.content.get(&s.key(&Tab::Grid)).unwrap() {
            Content::Grid(grid) => assert!(grid.read(cx).layout.sessions[0].is_none()),
            _ => panic!("grid"),
        }
    });
    cx.simulate_keystrokes("ctrl-shift-p");
    cx.simulate_keystrokes("n e w enter");
    ready(&shell, cx);
    assert!(shell.read_with(cx, |s, _| s.current().unwrap().composer));
    // The explicit global chord remains available inside the composer.
    cx.simulate_keystrokes("ctrl-shift-p");
    assert!(shell.read_with(cx, |s, _| s.palette));
    cx.simulate_keystrokes("escape");
    // Explicit command control remains reachable while the editor owns its keys.
    draw(cx);
    let commands = cx.debug_bounds("shell-palette").unwrap();
    cx.simulate_click(commands.center(), gpui::Modifiers::default());
    assert!(shell.read_with(cx, |s, _| s.palette));
    cx.simulate_keystrokes("escape");
    let other = shell.read_with(cx, |s, _| {
        s.workspaces
            .iter()
            .find(|w| **w != initial)
            .unwrap()
            .clone()
    });
    let mut switching = vec![];
    for i in 0..10 {
        let target = if i % 2 == 0 {
            other.clone()
        } else {
            initial.clone()
        };
        let index = shell.read_with(cx, |s, _| {
            s.workspaces.iter().position(|w| w == &target).unwrap()
        });
        draw(cx);
        let switcher = cx.debug_bounds("workspace-switcher").unwrap();
        cx.simulate_click(switcher.center(), gpui::Modifiers::default());
        draw(cx);
        let bounds = cx
            .debug_bounds(if index == 0 { "command-0" } else { "command-1" })
            .unwrap();
        let start = Instant::now();
        cx.simulate_click(bounds.center(), gpui::Modifiers::default());
        ready(&shell, cx);
        switching.push(start.elapsed().as_secs_f64() * 1000.);
        assert_eq!(
            shell.read_with(cx, |s, _| s.state.selected.clone()),
            Some(target.clone())
        );
        shell.read_with(cx, |s, _| {
            assert!(
                s.workspace_sessions()
                    .iter()
                    .all(|item| item.repo_path.as_ref() == Some(&target))
            );
        });
    }
    #[cfg(target_os = "linux")]
    let memory = fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find_map(|line| {
            line.strip_prefix("VmRSS:")
                .and_then(|s| s.split_whitespace().next())
                .and_then(|s| s.parse::<f64>().ok())
        })
        .unwrap()
        / 1024.;
    #[cfg(not(target_os = "linux"))]
    let memory = {
        let output = Process::new("ps")
            .args(["-p", &std::process::id().to_string(), "-o", "rss="])
            .output()
            .expect("native process RSS");
        assert!(output.status.success(), "native process RSS command");
        String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .parse::<f64>()
            .unwrap()
            / 1024.
    };
    let handle = cx.update(|window, _| window.window_handle());
    cx.cx
        .simulate_window_resize(handle, size(px(1024.), px(720.)));
    draw(cx);
    assert!(cx.simulate_close());
    let saved = State::load(&file).unwrap();
    assert_eq!(saved.bounds[..2], [100., 100.]);
    assert_eq!(saved.bounds[2..], [1024., 720.]);
    assert_eq!(saved.selected, Some(initial));
    assert_eq!(
        saved
            .workspaces
            .values()
            .map(|w| w.tabs.len())
            .sum::<usize>(),
        3
    );
    assert!(
        saved.workspaces[&saved.selected.clone().unwrap()].composer,
        "composer focus must survive workspace switching before restart"
    );
    let saved_selection = saved.selected.clone();
    let saved_bounds = saved.bounds;
    let (restarted, mut restarted_visual) =
        open(fixture.client.clone(), file.clone(), saved, &mut cx.cx);
    let restart_cx = &mut restarted_visual;
    restart_cx.update(|window, _| {
        let bounds = window.window_bounds().get_bounds();
        let actual: [f32; 4] = [
            bounds.origin.x.into(),
            bounds.origin.y.into(),
            bounds.size.width.into(),
            bounds.size.height.into(),
        ];
        assert_eq!(actual, saved_bounds);
    });
    ready(&restarted, restart_cx);
    assert_eq!(
        restarted.read_with(restart_cx, |s, _| s.state.selected.clone()),
        saved_selection
    );
    assert!(restarted.read_with(restart_cx, |s, _| s.current().unwrap().composer));
    println!(
        "O8_NEXT_SHELL_EVIDENCE {}",
        json!({"endpoint":"GPUI TestAppContext CPU scene paint; test text system; no GPU/compositor", "platform":std::env::consts::OS, "launchToInteractiveMs":launch,"paletteOpenToFrameMs":palette,"workspaceSwitchMs":switching,"idleMemoryMiB":memory,"workspaces":2,"restoredSurfaces":3})
    );
    // Persisted surfaces restore lazily, including the grid's own saved slots.
    restart_cx.simulate_keystrokes("tab ctrl-tab");
    ready(&restarted, restart_cx);
    assert_eq!(
        restarted.read_with(restart_cx, |s, _| s.active()),
        Some(Tab::Grid)
    );
    restarted.read_with(restart_cx, |s, cx| {
        match s.content.get(&s.key(&Tab::Grid)).unwrap() {
            Content::Grid(grid) => assert!(grid.read(cx).layout.sessions[0].is_none()),
            _ => panic!("grid"),
        }
    });
    restart_cx.simulate_keystrokes("ctrl-w");
    ready(&restarted, restart_cx);
    assert!(matches!(
        restarted.read_with(restart_cx, |s, _| s.active()),
        Some(Tab::Session(_))
    ));
    for (query, label) in [("d i f f", "Diff"), ("t e r m i n a l", "Terminal")] {
        restart_cx.simulate_keystrokes("ctrl-shift-p");
        restart_cx.simulate_keystrokes(query);
        restart_cx.simulate_keystrokes("enter");
        ready(&restarted, restart_cx);
        assert_eq!(
            restarted.read_with(restart_cx, |s, _| s.active().unwrap().label()),
            label
        );
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let dead = Client::authenticated(&origin, None).unwrap();
    let (offline, offline_cx) = restart_cx.cx.add_window_view(|window, cx| {
        Shell::new(
            dead,
            fixture.root.join("offline.json"),
            State::default(),
            window,
            cx,
        )
    });
    offline_cx.run_until_parked();
    draw(offline_cx);
    assert!(offline.read_with(offline_cx, |s, _| !s.connected
        && s.notice.contains("Local server unavailable")
        && s.notice.contains("Retry")));
}

#[path = "shell_look_tests.rs"]
mod look;

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
    let commands = cx.debug_bounds("shell-palette").unwrap();
    cx.simulate_click(commands.center(), gpui::Modifiers::default());
    cx.simulate_keystrokes("g r i d enter");
    ready(&shell, cx);
    let first_tab = cx.debug_bounds("surface-tab-0").unwrap();
    cx.simulate_click(first_tab.center(), gpui::Modifiers::default());
    ready(&shell, cx);
    assert!(
        cx.update(|window, _| composer_focus.is_focused(window)),
        "returning to a surface must restore its focused field"
    );
    let retry = cx.debug_bounds("shell-retry").unwrap();
    cx.simulate_click(retry.center(), gpui::Modifiers::default());
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
        if interrupted && notice.starts_with("Live") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "owned replay must disconnect and reconnect"
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
    assert!(cx.debug_bounds("shortcut-reference").is_some());
    cx.simulate_keystrokes("? ctrl-k n e w enter");
    ready(&shell, cx);
    cx.simulate_keystrokes("?");
    draw(cx);
    assert!(
        !shell.read_with(cx, |s, _| s.shortcuts),
        "field question mark must not toggle reference"
    );
}
