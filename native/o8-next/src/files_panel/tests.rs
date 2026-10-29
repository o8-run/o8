use super::*;
use gpui::{TestAppContext, VisualTestContext};
use serde_json::json;
use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

#[test]
fn classic_repo_relative_pin_validation() {
    for file in [
        "/outside", "C:/file", "../file", "a/../b", "a//b", "./file", "a/", "",
    ] {
        assert_eq!(search::repo_relative("/repo", file), None, "{file}");
    }
    assert_eq!(
        search::repo_relative("/repo/", "/repo/src/useful.rs"),
        Some("src/useful.rs")
    );
    assert_eq!(
        search::repo_relative("/repo", "src/useful.rs"),
        Some("src/useful.rs")
    );
    assert_eq!(search::repo_relative("/repo", "/repository/file"), None);
}

#[test]
fn directory_decoder_retains_ignored_files_and_directories() {
    let entries = parse_entries(&json!({"entries":[
        {"name":"PARITY-BOARD.local.md", "path":"PARITY-BOARD.local.md", "kind":"file", "ignored":true},
        {"name":"target", "path":"target", "kind":"directory", "ignored":true}
    ]}));
    assert_eq!(entries.len(), 2);
    assert!(entries[0].ignored && !entries[0].dir);
    assert!(entries[1].ignored && entries[1].dir);
    assert_ne!(file_icon("notes.md"), file_icon("code.rs"));
    assert_ne!(file_icon("data.json"), FILE);
}

struct Fixture {
    child: Child,
    client: Client,
    root: PathBuf,
    repo: String,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "o8-files-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let mut child = Command::new("node")
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args([
                "--import",
                "./scripts/register-server-only-stub.mjs",
                "--import",
                "tsx",
                "native/o8-next/src/files_panel/fixture.ts",
            ])
            .env("O8_FILES_FIXTURE_ROOT", &root)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
        let info: Value = output
            .by_ref()
            .find_map(|line| serde_json::from_str(&line.ok()?).ok())
            .expect("owned fixture origin");
        // Route dependencies can log after startup. Retain and drain the pipe
        // until the owned server exits, rather than closing its stdout early.
        std::thread::spawn(move || for _ in output {});
        Self {
            child,
            client: Client::authenticated(info["origin"].as_str().unwrap(), None).unwrap(),
            repo: info["repo"].as_str().unwrap().into(),
            root,
        }
    }
    fn requests(&self) -> Vec<String> {
        serde_json::from_str(&fs::read_to_string(self.root.join("requests.json")).unwrap()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}
fn wait(cx: &mut VisualTestContext, selector: &'static str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        draw(cx);
        if cx.debug_bounds(selector).is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("missing native Files control {selector}");
}
fn click(cx: &mut VisualTestContext, selector: &'static str) {
    wait(cx, selector);
    let target = cx.debug_bounds(selector).unwrap().center();
    cx.simulate_click(target, gpui::Modifiers::default());
    draw(cx);
}
fn search(cx: &mut VisualTestContext, selector: &'static str, text: &str) {
    click(cx, selector);
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-a backspace"
    } else {
        "ctrl-a backspace"
    });
    cx.simulate_input(text);
    cx.run_until_parked();
    cx.cx.executor().advance_clock(Duration::from_millis(150));
    draw(cx);
}

#[gpui::test]
fn classic_search_preview_escape_preserves_expanded_ignored_tree(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (panel, cx) = cx.add_window_view(|window, cx| {
        let panel = FilesPanel::new(
            fixture.client.clone(),
            fixture.repo.clone(),
            Mode::Files,
            cx,
        );
        panel.focus(window);
        panel
    });
    wait(cx, "files-row-PARITY-BOARD.local.md");
    click(cx, "files-row-src");
    wait(cx, "files-row-src/useful.rs");
    search(cx, "files-search", "useful");
    wait(cx, "file-search-src/useful.rs");
    click(cx, "file-search-src/useful.rs");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        if panel.read_with(cx, |p, _| matches!(p.file, File::Loaded { .. })) {
            break;
        }
        assert!(Instant::now() < deadline);
    }
    assert_eq!(
        panel.read_with(cx, |p, _| p.selected.clone()).as_deref(),
        Some("src/useful.rs")
    );
    click(cx, "files-search");
    cx.simulate_keystrokes("escape");
    wait(cx, "files-row-PARITY-BOARD.local.md");
    wait(cx, "files-row-src/useful.rs");
    click(cx, "files-tree-toggle");
    assert!(!panel.read_with(cx, |p, _| p.tree_visible));
    click(cx, "files-tree-toggle");
    wait(cx, "files-row-src/useful.rs");
    let requests = fixture.requests();
    assert!(requests.iter().any(|r| r.contains("search=useful")));
    assert!(
        requests
            .iter()
            .any(|r| r.contains("/api/v2/files?path=src%2Fuseful.rs"))
    );
}

#[gpui::test]
fn classic_quick_docs_pin_persist_remount_unpin_and_global_preview(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (panel, cx) = cx.add_window_view(|window, cx| {
        let panel = FilesPanel::new(
            fixture.client.clone(),
            fixture.repo.clone(),
            Mode::Files,
            cx,
        );
        panel.focus(window);
        panel
    });
    click(cx, "quick-docs-toggle");
    wait(cx, "quick-doc-AGENTS.md");
    let global = format!(
        "quick-doc-{}",
        fixture.root.join("home/.codex/AGENTS.md").display()
    );
    click(cx, Box::leak(global.into_boxed_str()));
    click(cx, "quick-docs-add");
    search(cx, "pin-search", "useful");
    click(cx, "pin-src/useful.rs");
    wait(cx, "pinned-file-src/useful.rs");
    click(cx, "pinned-file-src/useful.rs");
    assert_eq!(
        panel.read_with(cx, |p, _| p.selected.clone()).as_deref(),
        Some("src/useful.rs")
    );
    // New panel reads durable pins rather than retaining the first pane's model.
    panel.update_in(cx, |p, _, cx| {
        *p = FilesPanel::new(
            fixture.client.clone(),
            fixture.repo.clone(),
            Mode::Files,
            cx,
        );
    });
    click(cx, "quick-docs-toggle");
    wait(cx, "pinned-file-src/useful.rs");
    click(cx, "unpin-src/useful.rs");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        let body: Value = fixture
            .client
            .get(
                "/api/v2/files/quick-doc-pins",
                &[("workspace", fixture.repo.as_str())],
            )
            .unwrap();
        if body["paths"] == json!([]) {
            break;
        }
        assert!(Instant::now() < deadline);
    }
    assert!(
        fixture
            .requests()
            .iter()
            .any(|r| r.starts_with("POST /api/v2/files/quick-doc-pins"))
    );
}

#[gpui::test]
fn search_debounces_and_rejects_late_results(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (_panel, cx) = cx.add_window_view(|window, cx| {
        let panel = FilesPanel::new(
            fixture.client.clone(),
            fixture.repo.clone(),
            Mode::Files,
            cx,
        );
        panel.focus(window);
        panel
    });
    wait(cx, "files-row-src");
    click(cx, "files-search");
    cx.simulate_input("u");
    cx.simulate_input("seful");
    cx.run_until_parked();
    cx.cx.executor().advance_clock(Duration::from_millis(149));
    draw(cx);
    assert!(
        !fixture
            .requests()
            .iter()
            .any(|request| request.contains("search="))
    );
    cx.cx.executor().advance_clock(Duration::from_millis(1));
    wait(cx, "file-search-src/useful.rs");
    assert_eq!(
        fixture
            .requests()
            .iter()
            .filter(|request| request.contains("search="))
            .count(),
        1
    );
    search(cx, "files-search", "slow");
    // Let the earlier request enter the owned HTTP host, then replace it.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !fixture
        .requests()
        .iter()
        .any(|request| request.contains("search=slow"))
    {
        draw(cx);
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    search(cx, "files-search", "useful");
    wait(cx, "file-search-src/useful.rs");
    std::thread::sleep(Duration::from_millis(300));
    draw(cx);
    assert!(cx.debug_bounds("file-search-src/useful.rs").is_some());
}

#[gpui::test]
fn picker_escape_restores_focus_and_selected_file_without_collapsing_tree(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (panel, cx) = cx.add_window_view(|window, cx| {
        let panel = FilesPanel::new(
            fixture.client.clone(),
            fixture.repo.clone(),
            Mode::Files,
            cx,
        );
        panel.focus(window);
        panel
    });
    search(cx, "files-search", "useful");
    click(cx, "file-search-src/useful.rs");
    click(cx, "files-search");
    cx.simulate_keystrokes("escape");
    wait(cx, "files-row-src/useful.rs");
    click(cx, "quick-docs-add");
    wait(cx, "pin-src/useful.rs"); // The current file leads the empty picker.
    cx.simulate_keystrokes("shift-tab");
    draw(cx);
    cx.simulate_keystrokes("tab");
    draw(cx);
    cx.simulate_keystrokes("escape");
    draw(cx);
    draw(cx);
    assert!(
        panel.read_with(cx, |p, cx| p
            .quick_docs
            .as_ref()
            .unwrap()
            .read(cx)
            .picker
            .is_none()),
        "Escape must close the mounted picker"
    );
    assert!(
        cx.update(|window, cx| panel
            .read(cx)
            .quick_docs
            .as_ref()
            .unwrap()
            .read(cx)
            .add_focus
            .is_focused(window)),
        "closing restores keyboard focus to the add control"
    );
    assert_eq!(
        panel.read_with(cx, |p, _| p.selected.clone()).as_deref(),
        Some("src/useful.rs")
    );
    wait(cx, "files-row-src/useful.rs");
    assert!(panel.read_with(
        cx,
        |p, cx| p.quick_docs.as_ref().unwrap().read(cx).selected.as_deref()
            == Some("src/useful.rs")
    ));
}
