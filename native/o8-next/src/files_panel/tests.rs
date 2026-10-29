use super::*;
#[path = "test_support.rs"]
mod support;
use gpui::{TestAppContext, VisualTestContext};
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{Duration, Instant},
};
pub(super) use support::HeadingLayouts;
use support::*;
#[path = "markdown_tests.rs"]
pub(super) mod markdown_tests;

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

#[gpui::test]
fn classic_search_preview_escape_preserves_expanded_ignored_tree(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (panel, cx) = test_panel(&fixture, cx);
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
    let (panel, cx) = test_panel(&fixture, cx);
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
    let (_panel, cx) = test_panel(&fixture, cx);
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
    let (panel, cx) = test_panel(&fixture, cx);
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
    let (_panel, cx) = test_panel(&fixture, cx);
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
    let (panel, cx) = test_panel(&fixture, cx);
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

// Observe the parsed document selected by the production Files preview.
pub(super) struct RenderedMarkdown(pub std::rc::Rc<std::cell::RefCell<crate::retained::RowState>>);
impl gpui::Global for RenderedMarkdown {}

const MARKDOWN_FIXTURE: &str = "# Readable heading\n\n- A list item\n\n```rust\nfn formatted() {}\n```\n\n| Name | Value |\n| --- | --- |\n| *emphasis* | [link](https://example.com) |\n";

#[gpui::test]
fn viewer_markdown_opens_formatted_heading_list_and_code(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fs::write(
        PathBuf::from(&fixture.repo).join("AGENTS.md"),
        MARKDOWN_FIXTURE,
    )
    .unwrap();
    fs::write(
        PathBuf::from(&fixture.repo).join("guide.mdx"),
        MARKDOWN_FIXTURE,
    )
    .unwrap();
    let (panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-AGENTS.md");
    wait(cx, "files-markdown-1");
    assert!(cx.debug_bounds("files-source-1").is_none());
    let (nodes, rendered) = panel.read_with(cx, |_, cx| {
        let state = cx
            .try_global::<RenderedMarkdown>()
            .expect("Files must mount transcript Markdown")
            .0
            .borrow();
        let crate::model::Row::Message { nodes, .. } = &state.row else {
            panic!("formatted document row")
        };
        (
            nodes.clone(),
            cx.global::<markdown_tests::DocumentView>()
                .text
                .iter()
                .map(|(_, text)| text.text())
                .collect::<Vec<_>>(),
        )
    });
    assert!(rendered.iter().any(|line| line == "Readable heading"));
    assert!(rendered.iter().any(|line| line == "A list item"));
    assert!(rendered.iter().any(|line| line == "fn formatted() {}"));
    for kind in ["h1", "ul", "code-block", "table"] {
        assert!(
            nodes.iter().any(|n| n.kind == kind),
            "missing formatted {kind}"
        );
    }
    assert!(cx.debug_bounds("files-markdown-1").unwrap().size.height > px(100.));
    click(cx, "files-row-guide.mdx");
    wait(cx, "files-markdown-2");
    assert!(cx.debug_bounds("files-source-2").is_none());
}

#[gpui::test]
fn viewer_preview_source_toggle_remembers_each_file(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fs::write(
        PathBuf::from(&fixture.repo).join("AGENTS.md"),
        MARKDOWN_FIXTURE,
    )
    .unwrap();
    let (panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-AGENTS.md");
    wait(cx, "files-markdown-1");
    click(cx, "files-source-toggle");
    wait(cx, "files-source-1");
    click(cx, "files-row-PARITY-BOARD.local.md");
    wait(cx, "files-markdown-2");
    click(cx, "files-row-AGENTS.md");
    wait(cx, "files-source-3");
    assert!(cx.debug_bounds("files-markdown-3").is_none());
    click(cx, "files-preview-toggle");
    wait(cx, "files-markdown-3");
    assert_eq!(
        panel.read_with(cx, |p, _| p.selected.clone()).as_deref(),
        Some("AGENTS.md")
    );
}

#[gpui::test]
fn viewer_long_source_line_wraps_and_reflows_at_panel_width(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    // Include indentation, Unicode, and an unbroken token as well as words.
    let line = format!(
        "    let readable = {:?}; // {}",
        "wrapped text λ ".repeat(30),
        "x".repeat(180)
    );
    fs::write(PathBuf::from(&fixture.repo).join("src/useful.rs"), &line).unwrap();
    let (_panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-src");
    click(cx, "files-row-src/useful.rs");
    wait(cx, "files-source-line-1-0");
    click(cx, "files-tree-toggle");
    cx.simulate_resize(gpui::size(px(700.), px(700.)));
    draw(cx);
    let narrow = cx.debug_bounds("files-source-line-1-0").unwrap();
    let panel = cx.debug_bounds("files-source-1").unwrap();
    assert!(narrow.size.height > px(19.), "long source line must wrap");
    assert!(
        narrow.size.width <= panel.size.width,
        "wrapped line must fit panel"
    );
    cx.simulate_resize(gpui::size(px(1200.), px(700.)));
    draw(cx);
    let wide = cx.debug_bounds("files-source-line-1-0").unwrap();
    assert!(wide.size.width > narrow.size.width);
    assert!(
        wide.size.height < narrow.size.height,
        "resize must reflow existing rows"
    );
    click(cx, "files-wrap-toggle");
    let unwrapped = cx.debug_bounds("files-source-line-1-0").unwrap();
    assert_eq!(unwrapped.size.height, px(19.));
    assert!(
        unwrapped.size.width > wide.size.width,
        "unwrapped source can scroll horizontally"
    );
    click(cx, "files-wrap-toggle");
    assert_eq!(
        cx.debug_bounds("files-source-line-1-0")
            .unwrap()
            .size
            .height,
        wide.size.height
    );
}

#[gpui::test]
fn viewer_plain_text_wraps_by_default_and_toggle_works_from_keyboard(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fs::write(
        PathBuf::from(&fixture.repo).join("notes.txt"),
        "A readable long line of plain text. ".repeat(70),
    )
    .unwrap();
    let (_panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-notes.txt");
    wait(cx, "files-source-line-1-0");
    assert!(
        cx.debug_bounds("files-source-line-1-0")
            .unwrap()
            .size
            .height
            > px(19.)
    );
    click(cx, "files-wrap-toggle");
    assert_eq!(
        cx.debug_bounds("files-source-line-1-0")
            .unwrap()
            .size
            .height,
        px(19.)
    );
    cx.simulate_keystrokes("space");
    draw(cx);
    assert!(
        cx.debug_bounds("files-source-line-1-0")
            .unwrap()
            .size
            .height
            > px(19.)
    );
}

#[gpui::test]
fn viewer_header_filename_and_folder_truncate_independently(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let path = format!(
        "src/{}/{}.txt",
        "nested-folder-".repeat(10),
        "long-filename-".repeat(10)
    );
    let file = PathBuf::from(&fixture.repo).join(&path);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, "readable").unwrap();
    let (panel, cx) = test_panel(&fixture, cx);
    panel.update(cx, |panel, cx| panel.open_file(path.clone(), cx));
    wait(cx, "files-source-line-1-0");
    cx.simulate_resize(gpui::size(px(700.), px(700.)));
    draw(cx);
    let name = cx.debug_bounds("files-viewer-name").unwrap();
    let folder = cx.debug_bounds("files-viewer-folder").unwrap();
    assert_eq!(name.size.height, px(17.));
    assert_eq!(folder.size.height, px(12.));
    assert!(folder.top() >= name.bottom());
    assert_eq!(name.size.width, folder.size.width);
    assert!(
        name.size.width < px(500.),
        "both long strings must ellipsize inside the narrow header"
    );
    assert!(name.size.width > px(0.));
    let (name_text, folder_text) = panel.read_with(cx, |_, cx| {
        let heading = cx.global::<HeadingLayouts>();
        (heading.name.text(), heading.folder.text())
    });
    assert!(
        name_text.ends_with('…') && name_text.chars().count() > 5,
        "show filename characters before the ellipsis: {name_text}"
    );
    assert!(folder_text.ends_with('…') && folder_text.chars().count() > 5);
    cx.simulate_resize(gpui::size(px(1200.), px(700.)));
    draw(cx);
    let wider = panel.read_with(cx, |_, cx| cx.global::<HeadingLayouts>().name.text());
    assert!(
        wider.chars().count() > name_text.chars().count(),
        "title must remeasure when available width grows"
    );
}

pub(super) struct RenderedMedia(pub std::sync::Arc<gpui::RenderImage>);
impl gpui::Global for RenderedMedia {}

const PNG_FIXTURE: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=";
const SVG_FIXTURE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64" viewBox="0 0 96 64"><rect x="8" y="8" width="80" height="48" fill="#0088ff"/></svg>"##;

#[gpui::test]
fn viewer_svg_defaults_to_preview_and_switches_to_wrapped_source(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fs::write(PathBuf::from(&fixture.repo).join("vector.svg"), SVG_FIXTURE).unwrap();
    let (panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-vector.svg");
    wait(cx, "files-media-1");
    let card = cx.debug_bounds("files-image-card").unwrap();
    assert_eq!(
        card.size,
        gpui::size(px(134.), px(102.)),
        "natural SVG size plus classic's 18px padding and border"
    );
    let pixel = panel.read_with(cx, |_, cx| {
        let image = &cx.global::<RenderedMedia>().0;
        let width = image.size(0).width.0 as usize;
        let x = width * 10 / 96;
        let y = image.size(0).height.0 as usize * 10 / 64;
        let at = (y * width + x) * 4;
        image.as_bytes(0).unwrap()[at..at + 4].to_vec()
    });
    assert_eq!(
        pixel,
        [255, 136, 0, 255],
        "SVG #0088ff must reach the BGRA atlas without swapping red and blue"
    );
    click(cx, "files-source-toggle");
    wait(cx, "files-source-line-1-0");
    click(cx, "files-tree-toggle");
    cx.simulate_resize(gpui::size(px(400.), px(600.)));
    draw(cx);
    assert!(
        cx.debug_bounds("files-source-line-1-0")
            .unwrap()
            .size
            .height
            > px(19.)
    );
    click(cx, "files-preview-toggle");
    draw(cx);
    assert!(cx.debug_bounds("files-media-1").is_some());
}

#[gpui::test]
fn viewer_raster_image_uses_checked_asset_route_and_contained_card(cx: &mut TestAppContext) {
    use base64::Engine;
    let fixture = Fixture::new();
    fs::write(
        PathBuf::from(&fixture.repo).join("picture.png"),
        base64::engine::general_purpose::STANDARD
            .decode(PNG_FIXTURE)
            .unwrap(),
    )
    .unwrap();
    let (_panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-picture.png");
    wait(cx, "files-media-1");
    assert_eq!(
        cx.debug_bounds("files-image-card").unwrap().size,
        gpui::size(px(40.), px(39.))
    );
    let requests = fixture.requests();
    assert!(
        requests
            .iter()
            .any(|r| r.contains("/api/panel/file-asset?path=picture.png"))
    );
    assert!(
        !requests
            .iter()
            .any(|r| r.contains("/api/v2/files?path=picture.png")),
        "binary images never use the text endpoint"
    );
}

#[gpui::test]
fn viewer_failed_svg_keeps_source_available_and_retry_recovers(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let path = PathBuf::from(&fixture.repo).join("broken.svg");
    fs::write(&path, "<svg invalid").unwrap();
    let (_panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-broken.svg");
    wait(cx, "files-load-error");
    click(cx, "files-source-toggle");
    wait(cx, "files-source-line-1-0");
    click(cx, "files-preview-toggle");
    fs::write(&path, SVG_FIXTURE).unwrap();
    click(cx, "files-retry");
    wait(cx, "files-media-2");
}

#[gpui::test]
fn file_markdown_reflows_soft_paragraph_and_list_lines(cx: &mut TestAppContext) {
    markdown_tests::soft_breaks(cx);
}
#[gpui::test]
fn file_markdown_preserves_explicit_hard_breaks_and_blank_paragraphs(cx: &mut TestAppContext) {
    markdown_tests::hard_breaks(cx);
}
#[gpui::test]
fn file_markdown_headings_use_classic_sizes_and_spacing(cx: &mut TestAppContext) {
    markdown_tests::headings(cx);
}
#[gpui::test]
fn file_markdown_tables_keep_content_width_and_scroll_horizontally(cx: &mut TestAppContext) {
    markdown_tests::tables(cx);
}
#[gpui::test]
fn chat_markdown_single_newline_keeps_transcript_behavior(cx: &mut TestAppContext) {
    markdown_tests::chat_unchanged(cx);
}
