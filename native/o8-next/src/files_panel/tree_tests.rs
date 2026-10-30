//! Explorer regressions through the mounted Files pane and production routes.
use super::*;
#[derive(Default)]
pub(in crate::files_panel) struct Icons(pub std::collections::HashMap<String, String>);
impl gpui::Global for Icons {}
#[derive(Default)]
pub(in crate::files_panel) struct Rows(pub Vec<(String, String, usize, bool)>);
impl gpui::Global for Rows {}
fn until(cx: &mut VisualTestContext, check: impl Fn(&mut VisualTestContext) -> bool) {
    let end = Instant::now() + Duration::from_secs(15);
    loop {
        draw(cx);
        if check(cx) {
            return;
        }
        assert!(Instant::now() < end, "explorer operation timed out");
        cx.cx.executor().advance_clock(Duration::from_millis(10));
        std::thread::sleep(Duration::from_millis(10));
    }
}
pub(super) fn resize(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (_, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-AGENTS.md");
    wait(cx, "files-markdown-1");
    for width in [400., 900., 1300.] {
        cx.simulate_resize(gpui::size(px(width), px(700.)));
        draw(cx);
        draw(cx);
        let tree = cx.debug_bounds("files-explorer").expect("explorer track");
        let expected = (width * 0.34_f32).max((width * 0.48).min(210.));
        assert!(
            (f32::from(tree.size.width) - expected).abs() < 1.1,
            "tree track follows actual panel width"
        );
    }
}
pub(super) fn refresh_flatten(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = PathBuf::from(&fixture.repo);
    fs::create_dir_all(root.join("a/b/c")).unwrap();
    fs::write(root.join("a/b/c/file.txt"), "nested").unwrap();
    fs::create_dir_all(root.join("ignored-cache/deep")).unwrap();
    fs::write(
        root.join(".gitignore"),
        "PARITY-BOARD.local.md\nignored-cache/\n",
    )
    .unwrap();
    let (_, cx) = test_panel(&fixture, cx);
    wait(cx, "files-row-a");
    click(cx, "files-expand-all");
    wait(cx, "files-row-a/b/c/file.txt");
    let rows = cx.update(|_, cx| cx.global::<Rows>().0.clone());
    assert!(
        rows.iter()
            .any(|(p, name, depth, _)| p == "a/b/c" && name == "a/b/c" && *depth == 0)
    );
    assert!(
        !fixture
            .requests()
            .iter()
            .any(|r| r.contains("directory=ignored-cache")),
        "expand all must skip ignored directories"
    );
    fs::write(root.join("a/b/c/added.txt"), "fresh").unwrap();
    click(cx, "files-refresh");
    wait(cx, "files-row-a/b/c/added.txt");
    assert!(
        fixture
            .requests()
            .iter()
            .filter(|r| r.contains("directory=a%2Fb%2Fc"))
            .count()
            >= 2
    );
    click(cx, "files-expand-all");
    draw(cx);
    assert!(cx.update(|_, cx| {
        cx.global::<Rows>()
            .0
            .iter()
            .all(|(_, _, depth, _)| *depth == 0)
    }));
}
pub(super) fn keyboard_reveal(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    for i in 0..160 {
        fs::write(
            PathBuf::from(&fixture.repo).join(format!("z-{i:03}.txt")),
            "last",
        )
        .unwrap();
    }
    let (panel, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-AGENTS.md");
    wait(cx, "files-markdown-1");
    cx.simulate_keystrokes("end enter");
    until(cx, |cx| {
        panel.read_with(cx, |p, _| p.selected.as_deref() == Some("z-159.txt"))
    });
    let tree = cx.debug_bounds("files-tree").unwrap();
    let last = cx.debug_bounds("files-row-z-159.txt").unwrap();
    assert!(
        last.bottom() <= tree.bottom() && last.bottom() > tree.bottom() - px(25.),
        "reveal a lower row at the nearest bottom edge"
    );
    panel.update(cx, |p, cx| {
        p.open_file(format!("{}/AGENTS.md", fixture.repo), cx)
    });
    wait(cx, "files-markdown-3");
    until(cx, |cx| {
        cx.update(|_, cx| {
            cx.global::<Rows>()
                .0
                .iter()
                .any(|(p, _, _, selected)| p == "AGENTS.md" && *selected)
        })
    });
    let tree = cx.debug_bounds("files-tree").unwrap();
    let row = cx.debug_bounds("files-row-AGENTS.md").unwrap();
    assert!(row.top() >= tree.top() && row.bottom() <= tree.bottom());
    click(cx, "files-row-AGENTS.md");
    cx.simulate_keystrokes("s right");
    wait(cx, "files-row-src/useful.rs");
    cx.simulate_keystrokes("down enter");
    wait(cx, "files-source-5");
}
pub(super) fn toolbar_search(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (_, cx) = test_panel(&fixture, cx);
    wait(cx, "files-row-AGENTS.md");
    assert_eq!(
        cx.debug_bounds("files-search").unwrap().size.height,
        px(28.)
    );
    assert_eq!(
        cx.debug_bounds("files-refresh").unwrap().size.width,
        px(26.)
    );
    let composer = cx.debug_bounds("composer-input").unwrap();
    assert!(
        composer.size.width > px(100.),
        "search text has visible width"
    );
    search(cx, "files-search", "useful");
    wait(cx, "file-search-src/useful.rs");
    click(cx, "files-search-clear");
    wait(cx, "files-row-AGENTS.md");
    let input = cx.debug_bounds("files-search").unwrap();
    let refresh = cx.debug_bounds("files-refresh").unwrap();
    let expand = cx.debug_bounds("files-expand-all").unwrap();
    assert!(refresh.right() <= input.left() && input.right() <= expand.left());
    search(cx, "files-search", "does-not-exist-qzx");
    wait_requests(cx, &fixture, |r| {
        r.iter().any(|r| r.contains("search=does-not-exist-qzx"))
    });
    draw(cx);
    let notice = cx.debug_bounds("files-search-notice").unwrap();
    assert!(
        notice.top() < input.bottom() + px(50.),
        "empty state stays below search input"
    );
}
pub(super) fn icons(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    for file in [
        "package.json",
        "tsconfig.json",
        "index.d.ts",
        "app.py",
        "style.css",
    ] {
        fs::write(PathBuf::from(&fixture.repo).join(file), "").unwrap();
    }
    let (_, cx) = test_panel(&fixture, cx);
    wait(cx, "files-row-package.json");
    let icons = cx.update(|_, cx| {
        cx.try_global::<Icons>()
            .expect("complete Pierre icons mounted")
            .0
            .clone()
    });
    for (path, token) in [
        ("package.json", "npm"),
        ("tsconfig.json", "typescript"),
        ("AGENTS.md", "agents"),
        ("app.py", "python"),
        ("style.css", "css"),
    ] {
        assert_eq!(icons.get(path).map(String::as_str), Some(token));
    }
    assert_eq!(
        cx.debug_bounds("files-row-package.json")
            .unwrap()
            .size
            .height,
        px(24.)
    );
}
pub(super) fn activation(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (panel, cx) = test_panel(&fixture, cx);
    wait(cx, "files-row-AGENTS.md");
    fs::write(PathBuf::from(&fixture.repo).join("on-return.txt"), "new").unwrap();
    cx.update(|window, cx| panel.read(cx).focus(window));
    wait(cx, "files-row-on-return.txt");
}

pub(in crate::files_panel) struct DocsCount(pub gpui::TextLayout);
impl gpui::Global for DocsCount {}
#[derive(Default)]
pub(in crate::files_panel) struct Tooltips(pub std::collections::HashSet<String>);
impl gpui::Global for Tooltips {}
pub(super) fn docs(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (panel, cx) = test_panel(&fixture, cx);
    panel.update(cx, |p, cx| {
        p.set_pins(&fixture.repo, vec!["src/useful.rs".into()], cx)
    });
    click(cx, "quick-docs-toggle");
    wait(cx, "quick-doc-AGENTS.md");
    draw(cx);
    let group = cx
        .debug_bounds("quick-doc-group-This repo")
        .expect("repo docs group");
    let pinned = cx.debug_bounds("pinned-file-src/useful.rs").unwrap();
    assert!(
        group.top() < pinned.top(),
        "repo/global groups precede pinned files"
    );
    let size = cx.update(|_, cx| {
        cx.global::<DocsCount>()
            .0
            .line_layout_for_index(0)
            .unwrap()
            .font_size()
    });
    assert_eq!(size, px(10.));
    let global: &'static str = Box::leak(
        format!(
            "quick-doc-{}",
            fixture.root.join("home/.codex/AGENTS.md").display()
        )
        .into_boxed_str(),
    );
    let bounds = cx.debug_bounds(global).unwrap();
    cx.simulate_mouse_move(bounds.center(), None, Default::default());
    cx.cx.executor().advance_clock(Duration::from_secs(1));
    until(cx, |cx| {
        cx.update(|_, cx| {
            cx.try_global::<Tooltips>().is_some_and(|t| {
                t.0.contains(
                    &fixture
                        .root
                        .join("home/.codex/AGENTS.md")
                        .to_string_lossy()
                        .into_owned(),
                )
            })
        })
    });
    click(cx, "quick-docs-add");
    wait(cx, "quick-doc-picker");
    let full = cx.debug_bounds("quick-doc-picker").unwrap();
    assert_eq!(full.size.width, px(320.));
    search(cx, "pin-search", "useful");
    wait(cx, "pin-src/useful.rs");
    draw(cx);
    let short = cx.debug_bounds("quick-doc-picker").unwrap();
    assert!(
        short.size.height < full.size.height,
        "picker shrinks to its result content"
    );
}
pub(super) fn copy_scroll(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let text = format!(
        "a\té🙂\n{}",
        (0..180).map(|i| format!("line {i}\n")).collect::<String>()
    );
    fs::write(PathBuf::from(&fixture.repo).join("copy.txt"), &text).unwrap();
    let (_, cx) = test_panel(&fixture, cx);
    click(cx, "files-row-copy.txt");
    wait(cx, "files-source-line-1-0");
    let row = cx.debug_bounds("files-source-code-1-0").unwrap();
    cx.simulate_click(row.center(), Default::default());
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-a cmd-c"
    } else {
        "ctrl-a ctrl-c"
    });
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|c| c.text()))
            .as_deref(),
        Some(text.as_str())
    );
    cx.simulate_keystrokes("end");
    wait(cx, "files-source-line-1-180");
    let last = cx.debug_bounds("files-source-line-1-180").unwrap();
    let source = cx.debug_bounds("files-source-1").unwrap();
    assert!(last.top() < source.bottom() && last.bottom() > source.top());
    cx.simulate_keystrokes("home");
    wait(cx, "files-source-line-1-0");
    assert_eq!(
        fs::read_to_string(PathBuf::from(&fixture.repo).join("copy.txt")).unwrap(),
        text,
        "source remains read-only"
    );
}
pub(super) fn retry_search(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let repo = PathBuf::from(&fixture.repo);
    fs::rename(repo.join(".git"), fixture.root.join("git-backup")).unwrap();
    fs::write(
        fixture.root.join("fallback-files.json"),
        serde_json::to_vec(
            &json!({"search":{"error":"Unavailable"},"flat":{"error":"Unavailable"}}),
        )
        .unwrap(),
    )
    .unwrap();
    let (_, cx) = test_panel(&fixture, cx);
    search(cx, "files-search", "useful");
    wait(cx, "file-search-retry");
    fs::remove_file(fixture.root.join("fallback-files.json")).unwrap();
    fs::rename(fixture.root.join("git-backup"), repo.join(".git")).unwrap();
    click(cx, "file-search-retry");
    wait(cx, "file-search-src/useful.rs");
}

pub(super) fn folder_retry(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = PathBuf::from(&fixture.repo);
    fs::create_dir(root.join("recover")).unwrap();
    fs::write(root.join("recover/file.txt"), "recover").unwrap();
    let (_, cx) = test_panel(&fixture, cx);
    wait(cx, "files-row-recover");
    fs::rename(root.join("recover"), fixture.root.join("recover-backup")).unwrap();
    click(cx, "files-row-recover");
    wait(cx, "files-directory-retry-recover");
    fs::rename(fixture.root.join("recover-backup"), root.join("recover")).unwrap();
    click(cx, "files-directory-retry-recover");
    wait(cx, "files-row-recover/file.txt");
}
