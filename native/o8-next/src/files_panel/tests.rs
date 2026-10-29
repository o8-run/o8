use super::*;
use gpui::{TestAppContext, VisualTestContext};
use serde_json::json;
use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
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

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    child: Child,
    client: Client,
    root: PathBuf,
    repo: String,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "o8-files-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
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
        match fs::read_to_string(self.root.join("requests.json")) {
            Ok(log) => serde_json::from_str(&log).unwrap(),
            // Native results may arrive before the first HTTP request.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(error) => panic!("fixture request log: {error}"),
        }
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
        cx.cx.executor().advance_clock(Duration::from_millis(10));
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("missing native Files control {selector}");
}
fn wait_requests(cx: &mut VisualTestContext, fixture: &Fixture, ready: impl Fn(&[String]) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        draw(cx);
        if ready(&fixture.requests()) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "missing expected Files HTTP request"
        );
        cx.cx.executor().advance_clock(Duration::from_millis(10));
        std::thread::sleep(Duration::from_millis(10));
    }
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
    wait_requests(cx, &fixture, |requests| {
        requests.iter().any(|r| r.contains("search=useful"))
    });
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
fn quick_docs_pin_unpin_and_global_preview_without_server_pin_route(cx: &mut TestAppContext) {
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
    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let observed = events.clone();
    let _subscription = cx.update(|_, cx| {
        cx.subscribe(&panel, move |_, event: &PinsChanged, _| {
            observed.borrow_mut().push(event.paths.clone());
        })
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
    click(cx, "unpin-src/useful.rs");
    assert_eq!(
        *events.borrow(),
        vec![vec!["src/useful.rs".to_string()], vec![]]
    );
    assert!(panel.read_with(cx, |p, cx| {
        p.quick_docs.as_ref().unwrap().read(cx).picker.is_none()
    }));
    assert!(
        fixture
            .requests()
            .iter()
            .all(|r| !r.contains("quick-doc-pins"))
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
    wait_requests(cx, &fixture, |requests| {
        requests.iter().any(|r| r.contains("search=useful"))
    });
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
    wait_requests(cx, &fixture, |requests| {
        requests.iter().any(|r| r.contains("search=slow"))
    });
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

#[test]
fn ignored_flat_listing_matches_all_terms_and_ranks_exact_basename_first() {
    let flat = parse_entries(&json!({"entries":[
        {"name":"PARITY-BOARD.local.md","path":"PARITY-BOARD.local.md","kind":"file","ignored":true},
        {"name":"parity.md","path":"src/parity.md","kind":"file"}
    ]}));
    let server = parse_entries(
        &json!({"entries":[{"name":"parity.md","path":"src/parity.md","kind":"file"}]}),
    );
    let (matches, _) = search::merge_matches("parity board", &server, &flat, &[]);
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].path, "PARITY-BOARD.local.md");
    let (matches, _) = search::merge_matches("PARITY.MD", &server, &flat, &[]);
    assert_eq!(
        matches.len(),
        1,
        "same path from both sources is deduplicated"
    );
    let mut more = server.clone();
    more.push(Entry {
        name: "notes.md".into(),
        path: "parity.md/notes.md".into(),
        dir: false,
        ignored: false,
    });
    let (matches, _) = search::merge_matches("parity.md", &more, &flat, &[]);
    assert_eq!(matches[0].path, "src/parity.md");
    let many: Vec<_> = (0..600)
        .map(|i| Entry {
            name: "file".into(),
            path: format!("file-{i}"),
            dir: false,
            ignored: false,
        })
        .collect();
    let (matches, truncated) = search::merge_matches("file", &[], &many, &[]);
    assert_eq!(matches.len(), 500);
    assert!(truncated);
}

#[test]
fn native_pins_persist_in_shell_state_with_repo_isolation_and_limit() {
    let root = std::env::temp_dir().join(format!("o8-native-pins-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let file = root.join("shell.json");
    let mut state = crate::shell_state::State::default();
    let mut paths = vec![
        "../bad".into(),
        "/bad".into(),
        "C:/bad".into(),
        "PARITY-BOARD.local.md".into(),
        "PARITY-BOARD.local.md".into(),
    ];
    paths.extend((0..60).map(|i| format!("src/{i}.rs")));
    state.set_pins("/repo".into(), paths);
    state.save(&file).unwrap();
    let mut restored = crate::shell_state::State::load(&file).unwrap();
    assert_eq!(restored.pins("/repo").len(), 50);
    assert_eq!(restored.pins("/repo")[0], "PARITY-BOARD.local.md");
    assert!(restored.pins("/other").is_empty());
    restored.set_pins("/repo".into(), vec![]);
    restored.save(&file).unwrap();
    assert!(
        crate::shell_state::State::load(&file)
            .unwrap()
            .pins("/repo")
            .is_empty()
    );
    fs::remove_dir_all(root).unwrap();
}

#[gpui::test]
fn ignored_file_search_uses_one_flat_listing_per_search_session(cx: &mut TestAppContext) {
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
    search(cx, "files-search", "parity board");
    wait(cx, "file-search-PARITY-BOARD.local.md");
    click(cx, "files-search");
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-a"
    } else {
        "ctrl-a"
    });
    cx.simulate_input("parity");
    cx.run_until_parked();
    cx.cx.executor().advance_clock(Duration::from_millis(150));
    wait(cx, "file-search-PARITY-BOARD.local.md");
    assert_eq!(
        fixture
            .requests()
            .iter()
            .filter(|r| r.contains("recursive=files"))
            .count(),
        1
    );
    click(cx, "files-search");
    cx.simulate_keystrokes("escape");
    draw(cx);
    search(cx, "files-search", "parity board");
    wait(cx, "file-search-PARITY-BOARD.local.md");
    wait_requests(cx, &fixture, |requests| {
        requests
            .iter()
            .filter(|r| r.contains("recursive=files"))
            .count()
            >= 2
    });
}

// Reproduce an older server's incomplete BFS fallback, including paths absent
// from both HTTP responses. Git's full session index must supply those paths.
#[gpui::test]
fn native_git_fills_incomplete_server_search_and_flat_listing(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    for path in [
        ".github/workflows/next-parity.yml",
        "docs/internals/o8-next-parity.md",
        "native/o8-next/PARITY.md",
    ] {
        let file = PathBuf::from(&fixture.repo).join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, "parity fixture").unwrap();
    }
    // Include a tracked file in a dot directory, an untracked document, and an
    // ignored file only in the flat listing. This is the real git subprocess.
    assert!(
        Command::new("git")
            .args(["-C", &fixture.repo, "add", ".github"])
            .status()
            .unwrap()
            .success()
    );
    fs::create_dir_all(PathBuf::from(&fixture.repo).join("z-parity")).unwrap();
    for i in 0..600 {
        fs::write(
            PathBuf::from(&fixture.repo).join(format!("z-parity/file-{i}.txt")),
            "fixture",
        )
        .unwrap();
    }
    let native = json!({"name":"PARITY.md", "path":"native/o8-next/PARITY.md", "kind":"file"});
    fs::write(fixture.root.join("fallback-files.json"), serde_json::to_vec(&json!({
        "search": {"entries": [native.clone()], "truncated": false},
        "flat": {"entries": [native, {"name":"PARITY-BOARD.local.md", "path":"PARITY-BOARD.local.md", "kind":"file"}], "truncated": true}
    })).unwrap()).unwrap();
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
    search(cx, "files-search", "parity");
    wait(cx, "file-search-.github/workflows/next-parity.yml");
    wait(cx, "file-search-docs/internals/o8-next-parity.md");
    wait(cx, "file-search-PARITY-BOARD.local.md");
    let paths = panel.read_with(cx, |p, cx| {
        p.search
            .read(cx)
            .visible_entries()
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>()
    });
    assert_eq!(
        &paths[..3],
        [
            ".github/workflows/next-parity.yml",
            "docs/internals/o8-next-parity.md",
            "native/o8-next/PARITY.md"
        ]
    );
    assert_eq!(
        paths
            .iter()
            .filter(|p| *p == "native/o8-next/PARITY.md")
            .count(),
        1
    );
    assert_eq!(
        paths.len(),
        500,
        "cap results after ranking the full Git index"
    );
    let scroll = panel.read_with(cx, |p, cx| p.search.read(cx).scroll.clone());
    scroll.scroll_to_item(40, gpui::ScrollStrategy::Top);
    draw(cx);
    assert!(scroll.0.borrow().base_handle.offset().y < gpui::px(0.));
    click(cx, "files-search");
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-a"
    } else {
        "ctrl-a"
    });
    cx.simulate_input("PARITY");
    cx.run_until_parked();
    cx.cx.executor().advance_clock(Duration::from_millis(150));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        draw(cx);
        if panel.read_with(cx, |p, cx| p.search.read(cx).visible_entries().len()) == 500 {
            break;
        }
        assert!(Instant::now() < deadline);
    }
    assert_eq!(
        panel.read_with(cx, |p, cx| p
            .search
            .read(cx)
            .scroll
            .0
            .borrow()
            .base_handle
            .offset()
            .y),
        gpui::px(0.)
    );
    click(cx, "files-search");
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-a"
    } else {
        "ctrl-a"
    });
    cx.simulate_input("parity file-599");
    cx.run_until_parked();
    cx.cx.executor().advance_clock(Duration::from_millis(150));
    wait(cx, "file-search-z-parity/file-599.txt");
    assert_eq!(
        panel.read_with(cx, |p, cx| p
            .search
            .read(cx)
            .scroll
            .logical_scroll_top_index()),
        0
    );
    let paths = panel.read_with(cx, |p, cx| {
        p.search
            .read(cx)
            .visible_entries()
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>()
    });
    assert_eq!(
        paths,
        ["z-parity/file-599.txt"],
        "refining searches the full cached Git list, beyond the result cap"
    );
}
