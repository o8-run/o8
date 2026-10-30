//! FileViewer editing goes through actual keyboard input, routes and disk writes.
use super::*;
#[derive(Default)]
pub(in crate::files_panel) struct Controls {
    pub dirty: bool,
    pub saving: bool,
    pub error: Option<String>,
}
impl gpui::Global for Controls {}
fn state(cx: &mut VisualTestContext) -> (bool, bool, Option<String>) {
    cx.update(|_, cx| {
        let s = cx.global::<Controls>();
        (s.dirty, s.saving, s.error.clone())
    })
}
fn until(cx: &mut VisualTestContext, check: impl Fn(&mut VisualTestContext) -> bool) {
    let end = Instant::now() + Duration::from_secs(15);
    loop {
        draw(cx);
        if check(cx) {
            return;
        }
        assert!(Instant::now() < end, "file edit operation timed out");
        cx.cx.executor().advance_clock(Duration::from_millis(10));
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn replace(cx: &mut VisualTestContext, text: &str) {
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-a"
    } else {
        "ctrl-a"
    });
    cx.simulate_input(text);
    draw(cx);
}
fn save(cx: &mut VisualTestContext) {
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-s"
    } else {
        "ctrl-s"
    });
    draw(cx);
}
pub(super) fn keyboard_save(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("save-delay-ms"), "250").unwrap();
    let path = PathBuf::from(&fixture.repo).join("src/useful.rs");
    let (_, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-src");
    click(cx, "files-row-src/useful.rs");
    wait(cx, "files-edit-toggle");
    click(cx, "files-edit-toggle");
    wait(cx, "files-editor");
    assert_eq!(
        cx.debug_bounds("files-editor-gutter").unwrap().size.width,
        px(50.)
    );
    replace(cx, "fn edited() {\n");
    cx.simulate_keystrokes("tab");
    cx.simulate_input("42\n}");
    draw(cx);
    assert!(state(cx).0);
    assert_eq!(fs::read_to_string(&path).unwrap(), "fn useful() {}");
    let shortcut = gpui::Keystroke::parse(if cfg!(target_os = "macos") {
        "cmd-s"
    } else {
        "ctrl-s"
    })
    .unwrap();
    cx.update(|window, cx| window.dispatch_keystroke(shortcut.clone(), cx));
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    assert!(
        state(cx).1,
        "save disables duplicate submissions while pending"
    );
    cx.update(|window, cx| window.dispatch_keystroke(shortcut, cx));
    until(cx, |cx| !state(cx).1);
    assert_eq!(fs::read_to_string(&path).unwrap(), "fn edited() {\n  42\n}");
    assert!(!state(cx).0);
    assert!(state(cx).2.is_none());
    assert_eq!(
        fixture
            .requests()
            .iter()
            .filter(|r| r.starts_with("POST /api/v2/files"))
            .count(),
        1
    );
    click(cx, "files-edit-toggle");
    wait(cx, "files-source-1");
}
pub(super) fn markdown_draft(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let path = PathBuf::from(&fixture.repo).join("AGENTS.md");
    let (_, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-AGENTS.md");
    wait(cx, "files-edit-toggle");
    click(cx, "files-edit-toggle");
    wait(cx, "files-editor");
    replace(cx, "# Unsaved title\n\n- Draft item\n");
    click(cx, "files-preview-toggle");
    wait(cx, "files-markdown-1");
    let text = cx.update(|_, cx| {
        cx.global::<markdown_tests::DocumentView>()
            .text
            .iter()
            .map(|(_, t)| t.text())
            .collect::<Vec<_>>()
    });
    assert!(text.iter().any(|s| s == "Unsaved title"));
    assert!(state(cx).0);
    assert_eq!(fs::read_to_string(path).unwrap(), "repo instructions");
    click(cx, "files-source-toggle");
    click(cx, "files-edit-toggle");
    wait(cx, "files-editor");
    save(cx);
    until(cx, |cx| !state(cx).1);
    assert!(!state(cx).0);
}
pub(super) fn conflict(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let path = PathBuf::from(&fixture.repo).join("src/useful.rs");
    let (_, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-src");
    click(cx, "files-row-src/useful.rs");
    wait(cx, "files-edit-toggle");
    click(cx, "files-edit-toggle");
    wait(cx, "files-editor");
    replace(cx, "my unsaved draft");
    fs::write(&path, "changed externally").unwrap();
    save(cx);
    until(cx, |cx| !state(cx).1);
    assert!(state(cx).0);
    assert!(state(cx).2.unwrap().contains("changed on disk"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "changed externally");
    click(cx, "files-reload");
    wait(cx, "files-confirm-reload");
    click(cx, "files-cancel-reload");
    assert!(state(cx).0);
    // Restoring the loaded revision permits a deliberate retry without losing the draft.
    fs::write(&path, "fn useful() {}").unwrap();
    click(cx, "files-save");
    until(cx, |cx| !state(cx).1);
    assert_eq!(fs::read_to_string(&path).unwrap(), "my unsaved draft");
    assert!(!state(cx).0);
}
pub(super) fn absolute(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let path = fixture.root.join("home/.codex/AGENTS.md");
    let selector: &'static str =
        Box::leak(format!("quick-doc-{}", path.display()).into_boxed_str());
    let (_, cx) = test_panel(&fixture, cx);
    click(cx, "quick-docs-toggle");
    wait(cx, selector);
    click(cx, selector);
    wait(cx, "files-edit-toggle");
    click(cx, "files-edit-toggle");
    wait(cx, "files-editor");
    replace(cx, "updated global instructions");
    save(cx);
    until(cx, |cx| !state(cx).1);
    assert!(!state(cx).0, "absolute saves must succeed through file-io");
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "updated global instructions"
    );
    assert!(
        fixture
            .requests()
            .iter()
            .any(|r| r.starts_with("PUT /api/panel/file-io"))
    );
}
pub(super) fn truncated(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let path = PathBuf::from(&fixture.repo).join("large.txt");
    fs::write(path, "x".repeat(1024 * 1024 + 1)).unwrap();
    let (_, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-large.txt");
    wait(cx, "files-source-1");
    assert!(cx.debug_bounds("files-edit-toggle").is_none());
}

pub(super) fn newer_draft(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let path = PathBuf::from(&fixture.repo).join("src/useful.rs");
    let (_, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-src");
    click(cx, "files-row-src/useful.rs");
    wait(cx, "files-edit-toggle");
    click(cx, "files-edit-toggle");
    wait(cx, "files-editor");
    replace(cx, "first snapshot");
    let key = gpui::Keystroke::parse(if cfg!(target_os = "macos") {
        "cmd-s"
    } else {
        "ctrl-s"
    })
    .unwrap();
    cx.update(|window, cx| window.dispatch_keystroke(key, cx));
    cx.simulate_input(" plus newer edits");
    until(cx, |cx| !state(cx).1);
    assert_eq!(fs::read_to_string(&path).unwrap(), "first snapshot");
    assert!(
        state(cx).0,
        "acknowledging an earlier snapshot must not clear newer edits"
    );
    save(cx);
    until(cx, |cx| !state(cx).1);
    assert!(!state(cx).0);
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "first snapshot plus newer edits"
    );
}
pub(super) fn server_conflict(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("save-delay-ms"), "250").unwrap();
    let path = PathBuf::from(&fixture.repo).join("src/useful.rs");
    let (_, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-src");
    click(cx, "files-row-src/useful.rs");
    wait(cx, "files-edit-toggle");
    click(cx, "files-edit-toggle");
    wait(cx, "files-editor");
    replace(cx, "local draft");
    let log = fixture.root.join("requests.json");
    let disk = path.clone();
    let writer = std::thread::spawn(move || {
        let end = Instant::now() + Duration::from_secs(10);
        while Instant::now() < end {
            if fs::read_to_string(&log)
                .unwrap_or_default()
                .contains("POST /api/v2/files")
            {
                fs::write(disk, "concurrent disk revision").unwrap();
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("save request never reached the server");
    });
    save(cx);
    writer.join().unwrap();
    until(cx, |cx| !state(cx).1);
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "concurrent disk revision"
    );
    assert!(state(cx).0);
    assert!(state(cx).2.unwrap().contains("changed on disk"));
}
pub(super) fn unicode_tabs(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let path = PathBuf::from(&fixture.repo).join("src/useful.rs");
    let original = "a\té🙂\n尾";
    fs::write(&path, original).unwrap();
    let (_, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-src");
    click(cx, "files-row-src/useful.rs");
    wait(cx, "files-edit-toggle");
    click(cx, "files-edit-toggle");
    wait(cx, "files-editor");
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-a cmd-c"
    } else {
        "ctrl-a ctrl-c"
    });
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|c| c.text()))
            .as_deref(),
        Some(original)
    );
    let bounds = cx.debug_bounds("files-editor-code").unwrap();
    let x = cx.update(|window, _| {
        window
            .text_system()
            .shape_line(
                "a  é🙂".into(),
                px(12.),
                &[gpui::TextRun {
                    len: "a  é🙂".len(),
                    font: gpui::font(theme().font_mono),
                    color: theme().text.into(),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                }],
                None,
            )
            .x_for_index(3)
    });
    cx.simulate_click(
        gpui::point(bounds.left() + px(12.) + x, bounds.top() + px(17.)),
        Default::default(),
    );
    cx.simulate_input("X");
    draw(cx);
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-z cmd-shift-z"
    } else {
        "ctrl-z ctrl-shift-z"
    });
    save(cx);
    until(cx, |cx| !state(cx).1);
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "a\tXé🙂\n尾",
        "tab expansion must preserve original UTF-8 offsets and bytes"
    );
}
pub(super) fn svg_draft(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let path = PathBuf::from(&fixture.repo).join("draft.svg");
    let original = r##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><rect width="16" height="12" fill="#ff0000"/></svg>"##;
    fs::write(&path, original).unwrap();
    let (_, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-draft.svg");
    wait(cx, "files-media-1");
    click(cx, "files-edit-toggle");
    wait(cx, "files-editor");
    replace(cx, &original.replace("#ff0000", "#0000ff"));
    click(cx, "files-preview-toggle");
    until(cx, |cx| {
        cx.update(|_, cx| {
            cx.try_global::<RenderedMedia>()
                .is_some_and(|r| r.0.as_bytes(0).unwrap()[0..4] == [255, 0, 0, 255])
        })
    });
    assert!(state(cx).0);
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        original,
        "previewing an SVG draft must not save it"
    );
}

pub(super) fn legacy_save(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("omit-content-hash"), "").unwrap();
    let path = PathBuf::from(&fixture.repo).join("src/useful.rs");
    let (_, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-src");
    click(cx, "files-row-src/useful.rs");
    wait(cx, "files-edit-toggle");
    click(cx, "files-edit-toggle");
    wait(cx, "files-editor");
    replace(cx, "saved through file-io");
    save(cx);
    until(cx, |cx| !state(cx).1);
    assert!(!state(cx).0);
    assert!(state(cx).2.is_none());
    assert_eq!(fs::read_to_string(path).unwrap(), "saved through file-io");
    assert!(
        fixture
            .requests()
            .iter()
            .any(|r| r.starts_with("PUT /api/panel/file-io"))
    );
}

/// Selecting the same file is a tree operation, not permission to discard edits.
pub(super) fn reselect(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (panel, cx) = test_panel(&f, cx);
    click(cx, "files-row-AGENTS.md");
    wait(cx, "files-edit-toggle");
    click(cx, "files-edit-toggle");
    replace(cx, "# Keep this draft\n");
    let count = f
        .requests()
        .iter()
        .filter(|r| r.contains("/api/v2/files?"))
        .count();
    click(cx, "files-row-AGENTS.md");
    assert!(state(cx).0, "reselecting the current row keeps the draft");
    panel.update(cx, |panel, cx| {
        panel.open_file(format!("{}/AGENTS.md", f.repo), cx)
    });
    draw(cx);
    assert!(
        state(cx).0,
        "an absolute alias of the same row keeps the draft"
    );
    assert_eq!(
        f.requests()
            .iter()
            .filter(|r| r.contains("/api/v2/files?"))
            .count(),
        count
    );
    click(cx, "files-preview-toggle");
    let text = cx.update(|_, cx| {
        cx.global::<markdown_tests::DocumentView>()
            .text
            .iter()
            .map(|(_, layout)| layout.text())
            .collect::<Vec<_>>()
    });
    assert!(text.iter().any(|s| s == "Keep this draft"));
    assert_eq!(
        fs::read_to_string(PathBuf::from(&f.repo).join("AGENTS.md")).unwrap(),
        "repo instructions"
    );
    click(cx, "files-save");
    until(cx, |cx| !state(cx).1 && !state(cx).0);
    assert_eq!(
        fs::read_to_string(PathBuf::from(&f.repo).join("AGENTS.md")).unwrap(),
        "# Keep this draft\n"
    );
}
