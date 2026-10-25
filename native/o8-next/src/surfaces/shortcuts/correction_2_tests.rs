use super::*;

fn settings_frame(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    for _ in 0..30 {
        shortcuts_draw(cx);
        if shell.read_with(cx, |s, cx| {
            s.surfaces.settings.view.as_ref().is_some_and(|view| {
                let view = view.read(cx);
                view.snapshot.is_some() && !view.busy && view.painted.get() == view.revision
            })
        }) {
            return;
        }
    }
    panic!("Settings must finish loading through the production fixture");
}
fn field_shell(
    f: &Fixture,
    case: usize,
    cx: &mut TestAppContext,
) -> (Entity<Shell>, VisualTestContext) {
    let (shell, mut visual) = open(
        f.client.clone(),
        f.root.join(format!("field-{case}.json")),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("cmd-k");
    visual.simulate_keystrokes("g r i d enter");
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("cmd-,");
    settings_frame(&shell, &mut visual);
    shortcuts_click(&mut visual, "settings-nav-keys");
    settings_frame(&shell, &mut visual);
    for _ in 0..20 {
        draw(&mut visual);
        let target = visual
            .debug_bounds("key-edit-openrouter")
            .expect("provider control");
        let viewport = visual
            .debug_bounds("settings-scroll")
            .expect("settings viewport");
        if viewport.contains(&target.center()) {
            break;
        }
        visual.simulate_event(gpui::ScrollWheelEvent {
            position: viewport.center(),
            delta: gpui::ScrollDelta::Pixels(point(
                px(0.),
                px(if target.center().y > viewport.bottom() {
                    -200.
                } else {
                    200.
                }),
            )),
            ..Default::default()
        });
    }
    shortcuts_click(&mut visual, "key-edit-openrouter");
    shortcuts_click(&mut visual, "settings-editor");
    assert!(visual.debug_bounds("settings-secret-empty").is_some());
    (shell, visual)
}
#[gpui::test]
fn shortcuts_every_binding_respects_the_focused_secret_field(cx: &mut TestAppContext) {
    let mut bindings = vec![
        "?".to_owned(),
        "shift-/".into(),
        "cmd-/".into(),
        "ctrl-/".into(),
        "cmd-w".into(),
        "ctrl-w".into(),
        "cmd-k".into(),
        "ctrl-k".into(),
        "cmd-alt-left".into(),
        "cmd-alt-right".into(),
        "ctrl-shift-w".into(),
    ];
    for modifier in ["cmd", "ctrl"] {
        for digit in 1..=9 {
            bindings.push(format!("{modifier}-{digit}"));
        }
    }
    let mut failures = vec![];
    // The fixture host retires after two minutes. Use disposable batches so
    // a loaded machine cannot expire the host midway through the matrix.
    for (batch, bindings) in bindings.chunks(4).enumerate() {
        let fixture = Fixture::start(true);
        for (offset, binding) in bindings.iter().enumerate() {
            let case = batch * 4 + offset;
            let (shell, mut visual) = field_shell(&fixture, case, cx);
            let before = shell.read_with(&visual, |s, _| {
                (s.active(), s.current().unwrap().tabs.clone())
            });
            let focus = visual.update(|window, cx| window.focused(cx));
            visual.simulate_keystrokes(binding);
            shortcuts_draw(&mut visual);
            let unchanged = shell.read_with(&visual, |s, _| {
                s.surfaces.shortcuts.view.is_none()
                    && s.surfaces.settings.view.is_some()
                    && !s.palette
                    && (s.active(), s.current().unwrap().tabs.clone()) == before
            });
            let same_focus = visual.update(|window, cx| window.focused(cx)) == focus;
            let typed = !["?", "shift-/"].contains(&binding.as_str())
                || visual.debug_bounds("settings-secret-masked").is_some();
            if !unchanged || !same_focus || !typed {
                failures.push(binding.clone());
            }
            visual.update(|window, _| window.remove_window());
        }
    }
    assert!(
        failures.is_empty(),
        "focused Settings key field lost key ownership: {failures:?}"
    );
}
#[gpui::test]
fn shortcuts_text_fields_pass_palette_chords(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    for (case, binding) in [
        "cmd-shift-p",
        "ctrl-shift-p",
        "cmd-,",
        "ctrl-,",
        "ctrl-tab",
        "ctrl-shift-tab",
    ]
    .into_iter()
    .enumerate()
    {
        let (shell, mut visual) = field_shell(&fixture, case, cx);
        visual.simulate_keystrokes(binding);
        shortcuts_draw(&mut visual);
        assert!(
            shell.read_with(&visual, |s, _| if binding.ends_with("tab") {
                matches!(s.active(), Some(Tab::Session(_))) && s.surfaces.settings.view.is_some()
            } else if binding.ends_with(',') {
                s.surfaces.settings.view.is_none() && s.active() == Some(Tab::Grid)
            } else {
                s.palette
            }),
            "text fields pass palette, Settings and legacy tab-cycle chords: {binding}"
        );
        visual.update(|window, _| window.remove_window());
    }
}

pub(super) fn install_key_peer(client: &Client, workspace: &str) {
    let (mut url, _) = client.websocket().unwrap();
    let token = url
        .query_pairs()
        .find(|(key, _)| key == "token")
        .unwrap()
        .1
        .into_owned();
    url.set_scheme("http").unwrap();
    url.set_query(None);
    url.set_path("/terminal-signal");
    let auth = format!("Bearer {token}");
    ureq::post(url.as_str())
        .set("Authorization", &auth)
        .send_json(json!({"sessionName":"cortex-next-grid-0", "signal":"SIGTERM"}))
        .unwrap();
    url.set_path("/terminal-alive");
    url.set_query(Some("session=cortex-next-grid-0"));
    let deadline = Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let response: Value = ureq::get(url.as_str())
            .set("Authorization", &auth)
            .call()
            .unwrap()
            .into_json()
            .unwrap();
        if response["alive"] == false {
            break;
        }
        assert!(Instant::now() < deadline, "owned fixture peer must exit");
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    url.set_path("/terminal-spawn");
    url.set_query(None);
    let peer = fs::canonicalize(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/surfaces/shortcuts/fixtures/keys.py"),
    )
    .unwrap();
    let command = format!(
        "python3 '{}'",
        peer.to_string_lossy().replace('\'', "'\\''")
    );
    ureq::post(url.as_str()).set("Authorization", &auth)
        .send_json(json!({"sessionName":"cortex-next-grid-0", "shellCommand":command, "cwd":workspace, "cols":80,"rows":24})).unwrap();
}
fn wait_pty(shell: &Entity<Shell>, cx: &mut VisualTestContext, needle: &str) {
    let deadline = Instant::now() + std::time::Duration::from_secs(5);
    loop {
        shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
        shortcuts_draw(cx);
        let received = shell.read_with(cx, |s, cx| {
            match s.content.get(&s.key(&Tab::Grid)).unwrap() {
                Content::Grid(grid) => grid.read(cx).panes[0]
                    .terminal
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .grid
                    .lock()
                    .unwrap()
                    .text()
                    .contains(needle),
                _ => unreachable!(),
            }
        });
        if received {
            return;
        }
        assert!(Instant::now() < deadline, "real PTY must report {needle}");
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}
#[gpui::test]
fn shortcuts_control_k_reaches_the_focused_grid_pty(cx: &mut TestAppContext) {
    let (_host, shell, mut visual) = terminal_shell_with_peer(cx, true);
    wait_pty(&shell, &mut visual, "READY");
    let focus = visual.update(|window, cx| window.focused(cx));
    visual.simulate_keystrokes("ctrl-k");
    shortcuts_draw(&mut visual);
    assert!(
        !shell.read_with(&visual, |s, _| s.palette),
        "Ctrl+K must reach the PTY"
    );
    assert_eq!(visual.update(|window, cx| window.focused(cx)), focus);
    wait_pty(&shell, &mut visual, "BYTES 0b");
    visual.simulate_keystrokes("ctrl-w");
    wait_pty(&shell, &mut visual, "BYTES 17");
    visual.simulate_keystrokes("ctrl-tab");
    wait_pty(&shell, &mut visual, "BYTES 09");
    visual.simulate_keystrokes("ctrl-shift-tab");
    wait_pty(&shell, &mut visual, "BYTES 1b5b5a");
    visual.simulate_keystrokes("cmd-k");
    shortcuts_draw(&mut visual);
    assert!(
        !shell.read_with(&visual, |s, _| s.palette),
        "Cmd+K must not steal focused PTY input"
    );
    assert_eq!(visual.update(|window, cx| window.focused(cx)), focus);
}

#[gpui::test]
fn shortcuts_settings_chords_do_not_steal_pty_focus(cx: &mut TestAppContext) {
    let (_host, shell, mut visual) = terminal_shell_with_peer(cx, true);
    wait_pty(&shell, &mut visual, "READY");
    let focus = visual.update(|window, cx| window.focused(cx));
    visual.simulate_keystrokes("cmd-,");
    shortcuts_draw(&mut visual);
    assert!(
        shell.read_with(&visual, |s, _| s.surfaces.settings.view.is_none()),
        "a focused PTY owns Settings chords too"
    );
    visual.simulate_keystrokes("ctrl-,");
    shortcuts_draw(&mut visual);
    assert!(shell.read_with(&visual, |s, _| s.surfaces.settings.view.is_none()));
    assert_eq!(visual.update(|window, cx| window.focused(cx)), focus);
}

#[gpui::test]
fn shortcuts_restored_field_is_observed_before_its_first_key(cx: &mut TestAppContext) {
    let fixture = Fixture::brain();
    let workspace = fixture
        .client
        .sessions()
        .unwrap()
        .into_iter()
        .find_map(|session| session.repo_path)
        .expect("fixture workspace from the production session route");
    let mut state = State {
        selected: Some(workspace.clone()),
        ..State::default()
    };
    state
        .workspaces
        .entry(workspace)
        .or_default()
        .tabs
        .push(Tab::Brain);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("restored-field.json"),
        state,
        cx,
    );
    ready(&shell, &mut visual);
    let focus = visual.update(|window, cx| window.focused(cx));
    visual.simulate_keystrokes("?");
    shortcuts_draw(&mut visual);
    assert!(shell.read_with(&visual, |s, _| s.surfaces.shortcuts.view.is_none()));
    visual.simulate_keystrokes("cmd-w");
    shortcuts_draw(&mut visual);
    assert_eq!(
        shell.read_with(&visual, |s, _| s.active()),
        Some(Tab::Brain)
    );
    assert_eq!(visual.update(|window, cx| window.focused(cx)), focus);
}
