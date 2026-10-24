use super::*;
use gpui::{TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader},
    process::{Child, Command as Process, Stdio},
    time::Instant,
};
struct Fixture {
    server: Child,
    client: Client,
    origin: String,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        Self::with_mode("--shell")
    }
    fn with_mode(mode: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "o8-shell-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let mut server = Process::new("node")
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args([
                "--import",
                "./scripts/register-server-only-stub.mjs",
                "--import",
                "tsx",
                "scripts/next/dev-server.ts",
                "--composer",
                mode,
            ])
            .env("O8_NEXT_API_TOKEN", "fixture-shell-bearer")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(server.stdout.take().unwrap()).lines();
        let origin = lines
            .by_ref()
            .find_map(|line| {
                serde_json::from_str::<Value>(&line.ok()?).ok()?["origin"]
                    .as_str()
                    .map(str::to_owned)
            })
            .expect("fixture origin");
        // Registry mutations can log after startup. Keep draining the pipe so
        // production handlers never fail with EPIPE after the origin receipt.
        std::thread::spawn(move || for _ in lines {});
        Self {
            server,
            client: Client::authenticated(&origin, Some("fixture-shell-bearer".into())).unwrap(),
            origin,
            root,
        }
    }
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    draw(cx);
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("missing control: {selector}"));
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
}

#[gpui::test]
fn onboarding_project_tools_privacy_and_workspace(cx: &mut TestAppContext) {
    let fixture = Fixture::with_mode("--onboarding");
    let start = Instant::now();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("first-run.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    let opened = start.elapsed().as_secs_f64() * 1000.;
    assert!(
        cx.debug_bounds("setup-projects").is_some(),
        "first run must paint project setup"
    );
    let before: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap();
    assert_ne!(
        before["sources"]["orchestratorBackend"], "file",
        "discovery must not save defaults"
    );
    click(cx, "setup-project-0");
    assert!(
        cx.debug_bounds("setup-tools").is_some(),
        "an unavailable CLI must lead to tool setup"
    );
    click(cx, "setup-lead-gemini");
    click(cx, "setup-use");
    let unchanged: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap();
    assert_eq!(
        before["values"], unchanged["values"],
        "unavailable runtime cannot save"
    );
    click(cx, "setup-refresh");
    click(cx, "setup-lead-codex");
    click(cx, "setup-worker-claude-code");
    click(cx, "setup-use");
    assert!(cx.debug_bounds("setup-privacy").is_some());
    click(cx, "setup-telemetry");
    click(cx, "setup-consent");
    cx.run_until_parked();
    draw(cx);
    let saved: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap();
    assert_eq!(saved["values"]["orchestratorBackend"], "codex");
    assert_eq!(
        saved["values"]["workerRuntimes"],
        json!(["codex", "claude-code"])
    );
    assert_eq!(saved["values"]["productTelemetryEnabled"], true);
    assert_eq!(saved["values"]["crashReportsEnabled"], false);
    assert_eq!(saved["values"]["telemetryConsentAnswered"], true);
    let config: Value = fixture.client.get("/api/setup/config", &[]).unwrap();
    assert_eq!(config["setupComplete"], true);
    assert!(
        config["completedAt"]
            .as_str()
            .is_some_and(|s| s.ends_with('Z'))
    );
    let repos: Value = fixture.client.get("/api/panel/repos", &[]).unwrap();
    let selected = shell.read_with(cx, |s, _| {
        s.state.selected.clone().expect("opened workspace")
    });
    assert_eq!(
        fs::canonicalize(selected).unwrap(),
        fs::canonicalize(repos["repos"][0]["localPath"].as_str().unwrap()).unwrap()
    );
    assert!(shell.read_with(cx, |s, _| s.setup.is_none()));
    assert!(
        matches!(
            shell.read_with(cx, |s, _| s.active()),
            Some(Tab::Session(_))
        ),
        "onboarding must open a conversation"
    );
    assert!(
        cx.debug_bounds("composer-input").is_some(),
        "a new workspace must have a message input"
    );
    let start = Instant::now();
    click(cx, "setup-open");
    let interaction = start.elapsed().as_secs_f64() * 1000.;
    assert!(cx.debug_bounds("setup-projects").is_some());
    click(cx, "setup-close");
    assert!(shell.read_with(cx, |s, _| s.setup.is_none()));
    println!(
        "O8_NEXT_ONBOARDING_EVIDENCE {}",
        json!({"endpoint":"headless GPUI CPU scene; no GPU/compositor", "openToFirstFrameMs":opened,"interactionToFrameMs":interaction})
    );
}

#[gpui::test]
fn onboarding_folder_registration_error_and_cancel(cx: &mut TestAppContext) {
    let fixture = Fixture::with_mode("--onboarding");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("folder.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    click(cx, "setup-folder");
    click(cx, "setup-folder-input");
    cx.simulate_input(fixture.root.join("missing").to_str().unwrap());
    click(cx, "setup-add");
    assert!(cx.debug_bounds("setup-error").is_some());
    click(cx, "setup-cancel-folder");
    assert_eq!(
        shell.read_with(cx, |s, cx| s
            .setup
            .as_ref()
            .unwrap()
            .read(cx)
            .painted_page()),
        Some("projects")
    );
    let repo = fixture.root.join("added-repo");
    fs::create_dir(&repo).unwrap();
    assert!(
        Process::new("git")
            .args(["init", "-q"])
            .arg(&repo)
            .status()
            .unwrap()
            .success()
    );
    click(cx, "setup-folder");
    click(cx, "setup-folder-input");
    cx.simulate_input(repo.to_str().unwrap());
    click(cx, "setup-add");
    let registered: Value = fixture.client.get("/api/panel/repos", &[]).unwrap();
    assert!(registered["repos"].as_array().unwrap().iter().any(|r| {
        fs::canonicalize(r["localPath"].as_str().unwrap()).unwrap()
            == fs::canonicalize(&repo).unwrap()
    }));
    assert!(cx.debug_bounds("setup-tools").is_some());
    click(cx, "setup-back");
    assert!(cx.debug_bounds("setup-projects").is_some());
}

#[gpui::test]
fn onboarding_operator_auth_error_retry(cx: &mut TestAppContext) {
    let fixture = Fixture::with_mode("--onboarding");
    // The same origin with no bearer must never reveal or change setup.
    let client = Client::authenticated(&fixture.origin, None).unwrap();
    let (_shell, mut visual) = open(
        client,
        fixture.root.join("refused.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    click(cx, "setup-open");
    assert!(cx.debug_bounds("setup-error").is_some());
    click(cx, "setup-refresh");
    assert!(cx.debug_bounds("setup-error").is_some());
    assert!(cx.debug_bounds("setup-project-0").is_none());
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = Process::new("kill")
            .args(["-TERM", &self.server.id().to_string()])
            .status();
        let _ = self.server.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn open(
    client: Client,
    file: PathBuf,
    state: State,
    cx: &mut TestAppContext,
) -> (Entity<Shell>, VisualTestContext) {
    let handle = cx.update(|cx| view::open_window(client, file, state, true, cx));
    let shell = handle.root(cx).unwrap();
    let visual = VisualTestContext::from_window(handle.into(), cx);
    (shell, visual)
}
fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
        window.refresh();
        window.draw(cx).clear();
    });
}
fn ready(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    for _ in 0..20 {
        cx.run_until_parked();
        draw(cx);
        if shell.read_with(cx, |s, cx| {
            s.active()
                .and_then(|t| s.content.get(&s.key(&t)))
                .is_some_and(|c| match c {
                    Content::Session(s) => s.read(cx).shell_ready(),
                    Content::Grid(g) => g
                        .read(cx)
                        .panes
                        .iter()
                        .any(|p| p.transcript.is_some() && !p.painted_rows.borrow().is_empty()),
                })
        }) {
            return;
        }
    }
    panic!("selected fixture history must reach CPU scene paint through the existing surface");
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
    // Palette captures commands even while the existing editor has focus.
    cx.simulate_keystrokes("ctrl-k");
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
        let bounds = cx
            .debug_bounds(if index == 0 {
                "workspace-0"
            } else {
                "workspace-1"
            })
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
    for query in ["d i f f", "t e r m i n a l"] {
        restart_cx.simulate_keystrokes("ctrl-k");
        restart_cx.simulate_keystrokes(query);
        restart_cx.simulate_keystrokes("enter");
        assert!(restarted.read_with(restart_cx, |s, _| {
            s.notice.contains("not available in this build")
        }));
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

#[gpui::test]
fn shell_retains_sidebar_selection_and_view_identity(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join("selected.json");
    let (shell, cx) = cx.add_window_view(|window, cx| {
        Shell::new(
            fixture.client.clone(),
            file.clone(),
            State::default(),
            window,
            cx,
        )
    });
    ready(&shell, cx);
    let before = shell.read_with(cx, |s, _| {
        match s.content.get(&s.key(&s.active().unwrap())).unwrap() {
            Content::Session(session) => session.entity_id(),
            _ => panic!("session"),
        }
    });
    cx.simulate_keystrokes("down");
    cx.run_until_parked();
    shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
    ready(&shell, cx);
    let after = shell.read_with(cx, |s, _| {
        match s.content.get(&s.key(&s.active().unwrap())).unwrap() {
            Content::Session(session) => session.entity_id(),
            _ => panic!("session"),
        }
    });
    assert_eq!(
        before, after,
        "changing the session in the sidebar must retain the existing Surface and its drafts"
    );
}
