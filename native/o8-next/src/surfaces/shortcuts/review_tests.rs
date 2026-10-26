use super::*;
#[path = "correction_2_tests.rs"]
mod correction_2;
#[gpui::test]
fn shortcuts_reopen_retains_list_scroll(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (shell, mut visual) = open(
        f.client.clone(),
        f.root.join("scroll.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let handle = cx.update(|window, _| window.window_handle());
    cx.cx
        .simulate_window_resize(handle, size(px(640.), px(240.)));
    draw(cx);
    cx.simulate_keystrokes("cmd-/");
    shortcuts_draw(cx);
    cx.simulate_keystrokes("end");
    shortcuts_draw(cx);
    let before = shell.read_with(cx, |s, cx| {
        s.surfaces
            .shortcuts
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .scroll
            .offset()
    });
    assert!(before.y < px(0.), "small windows must scroll the reference");
    cx.simulate_keystrokes("escape cmd-/");
    shortcuts_draw(cx);
    let after = shell.read_with(cx, |s, cx| {
        s.surfaces
            .shortcuts
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .scroll
            .offset()
    });
    assert_eq!(
        before, after,
        "reopening must retain the existing shell's scroll state"
    );
}
struct GridHost {
    child: Child,
    root: PathBuf,
}
impl Drop for GridHost {
    fn drop(&mut self) {
        let _ = Process::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn terminal_shell(cx: &mut TestAppContext) -> (GridHost, Entity<Shell>, VisualTestContext) {
    terminal_shell_with_peer(cx, false)
}
fn terminal_shell_with_peer(
    cx: &mut TestAppContext,
    report_input: bool,
) -> (GridHost, Entity<Shell>, VisualTestContext) {
    let root = std::env::temp_dir().join(format!(
        "o8-shortcuts-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let child = Process::new("node")
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .args([
            "--import",
            "./scripts/register-server-only-stub.mjs",
            "--import",
            "tsx",
            "native/o8-next/src/surfaces/shortcuts/fixtures/grid_host.ts",
        ])
        .env("O8_NEXT_API_TOKEN", "fixture-grid-bearer")
        // Keep the host's inventory paths canonical across macOS /var aliases.
        .env("TMPDIR", &root)
        .stdout(Stdio::piped())
        .stderr(Stdio::from(
            fs::File::create(root.join("fixture.log")).unwrap(),
        ))
        .spawn()
        .unwrap();
    let mut host = GridHost { child, root };
    let mut lines = BufReader::new(host.child.stdout.take().unwrap()).lines();
    let receipt = lines
        .by_ref()
        .find_map(|line| {
            let v: Value = serde_json::from_str(&line.ok()?).ok()?;
            v["origin"].as_str()?;
            Some(v)
        })
        .unwrap_or_else(|| {
            panic!(
                "owned grid fixture exited before readiness: {}",
                fs::read_to_string(host.root.join("fixture.log")).unwrap_or_default()
            )
        });
    std::thread::spawn(move || for _ in lines {});
    let client = Client::authenticated(
        receipt["origin"].as_str().unwrap(),
        Some("fixture-grid-bearer".into()),
    )
    .unwrap();
    let workspace = fs::canonicalize(receipt["workspace"].as_str().unwrap())
        .unwrap()
        .to_string_lossy()
        .into_owned();
    if report_input {
        correction_2::install_key_peer(&client, &workspace);
    }
    let file = host.root.join("terminal.json");
    let options = crate::pane_layout::Options {
        size: 6,
        workspace: workspace.clone(),
        file: file.with_extension("grid.json"),
    };
    let mut layout = crate::pane_layout::Layout::new(
        6,
        (0..6).map(|i| {
            if i < 3 {
                format!("pi-owned:grid-terminal-{i}")
            } else {
                format!("llm-chat:thoughts-grid-{i}")
            }
        }),
    );
    layout.views[0] = crate::pane_layout::View::Terminal;
    options.save(&layout).unwrap();
    let (shell, mut visual) = open(
        client,
        file,
        State {
            selected: Some(workspace),
            ..State::default()
        },
        cx,
    );
    visual.run_until_parked();
    draw(&mut visual);
    visual.simulate_keystrokes("cmd-shift-p");
    visual.simulate_keystrokes("g r i d enter");
    let deadline = Instant::now() + std::time::Duration::from_secs(15);
    loop {
        shell.update_in(&mut visual, |s, window, cx| s.tick(false, window, cx));
        visual.run_until_parked();
        draw(&mut visual);
        let ready = shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Grid)) {
            Some(Content::Grid(g)) => g.read(cx).panes[0]
                .terminal
                .as_ref()
                .is_some_and(|t| t.read(cx).ready),
            _ => false,
        });
        if ready {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "fixture terminal must connect: {}",
            shell.read_with(&visual, |s, cx| {
                let pane = match s.content.get(&s.key(&Tab::Grid)) {
                    Some(Content::Grid(g)) => g.read(cx).panes[0]
                        .terminal
                        .as_ref()
                        .map(|t| t.read(cx).notice),
                    _ => None,
                };
                format!(
                    "active={:?}, palette={}, query={:?}, terminal={pane:?}, shell={}",
                    s.active(),
                    s.palette,
                    s.query,
                    s.notice
                )
            })
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let focus = shell.read_with(&visual, |s, cx| {
        match s.content.get(&s.key(&Tab::Grid)).unwrap() {
            Content::Grid(g) => g.read(cx).panes[0]
                .terminal
                .as_ref()
                .unwrap()
                .read(cx)
                .focus_handle(),
            _ => unreachable!(),
        }
    });
    visual.update(|window, _| focus.focus(window));
    draw(&mut visual);
    (host, shell, visual)
}
#[gpui::test]
fn shortcuts_focused_grid_terminal_keeps_question_and_close_keys(cx: &mut TestAppContext) {
    let (_host, shell, mut visual) = terminal_shell(cx);
    let cx = &mut visual;
    cx.simulate_keystrokes("?");
    shortcuts_draw(cx);
    assert!(
        shell.read_with(cx, |s, _| s.surfaces.shortcuts.view.is_none()),
        "typing ? in the focused PTY must not open Help"
    );
    cx.simulate_keystrokes("cmd-w");
    shortcuts_draw(cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s.active()),
        Some(Tab::Grid),
        "Cmd+W must preserve the focused terminal's Grid"
    );
    cx.simulate_keystrokes("ctrl-w");
    shortcuts_draw(cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s.active()),
        Some(Tab::Grid),
        "Ctrl+W belongs to the PTY while editing"
    );
}
#[gpui::test]
fn shortcuts_focused_text_field_keeps_help_and_close_keys(cx: &mut TestAppContext) {
    let f = Fixture::brain();
    let (shell, mut visual) = open(
        f.client.clone(),
        f.root.join("editor.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    cx.simulate_keystrokes("cmd-shift-p");
    cx.simulate_keystrokes("b r a i n enter");
    ready(&shell, cx);
    cx.simulate_keystrokes("?");
    shortcuts_draw(cx);
    assert!(
        shell.read_with(cx, |s, _| s.surfaces.shortcuts.view.is_none()),
        "a focused text field owns typing"
    );
    cx.simulate_keystrokes("cmd-w");
    shortcuts_draw(cx);
    assert_eq!(shell.read_with(cx, |s, _| s.active()), Some(Tab::Brain));
}
#[gpui::test]
fn shortcuts_control_alt_arrows_belong_to_grid_panes(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (shell, mut visual) = open(
        f.client.clone(),
        f.root.join("panes.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    cx.simulate_keystrokes("cmd-k");
    cx.simulate_keystrokes("g r i d enter");
    ready(&shell, cx);
    cx.simulate_keystrokes("ctrl-alt-right");
    shortcuts_draw(cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s.active()),
        Some(Tab::Grid),
        "Ctrl+Alt+Right must not switch shell tabs"
    );
    assert_eq!(
        shell.read_with(cx, |s, cx| {
            match s.content.get(&s.key(&Tab::Grid)).unwrap() {
                Content::Grid(g) => g.read(cx).layout.focus,
                _ => unreachable!(),
            }
        }),
        1
    );
    cx.simulate_keystrokes("ctrl-alt-left");
    shortcuts_draw(cx);
    assert_eq!(
        shell.read_with(cx, |s, cx| {
            match s.content.get(&s.key(&Tab::Grid)).unwrap() {
                Content::Grid(g) => g.read(cx).layout.focus,
                _ => unreachable!(),
            }
        }),
        0
    );
}
