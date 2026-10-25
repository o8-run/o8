use super::test_support::*;
use super::*;
use gpui::TestAppContext;
use serde_json::json;
use std::time::Instant;

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
        assert_eq!(shell.read_with(cx, |s, _| s.commands().len()), 15);
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
    cx.simulate_keystrokes("cmd-k");
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
    cx.simulate_keystrokes("cmd-k");
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
        cx.simulate_keystrokes("ctrl-k");
        draw(cx);
        palette.push(start.elapsed().as_secs_f64() * 1000.);
        assert!(cx.debug_bounds("command-palette").is_some());
        shell.read_with(cx, |s, _| assert_eq!(s.painted.get(), s.revision));
        cx.simulate_keystrokes("escape");
    }
    // Filter and choose a real grid with keyboard events, then return to message input.
    cx.simulate_keystrokes("ctrl-k");
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
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("n e w enter");
    ready(&shell, cx);
    assert!(shell.read_with(cx, |s, _| s.current().unwrap().composer));
    // The explicit global palette chord works while the editor has focus.
    cx.simulate_keystrokes("ctrl-shift-p");
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
    restart_cx.simulate_keystrokes("ctrl-tab");
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
