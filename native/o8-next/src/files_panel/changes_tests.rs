//! Reachable Changes/Diff regressions against the production Git route handlers.
use super::*;
#[derive(Default)]
pub(in crate::files_panel) struct Inventory(pub Vec<(String, String, u64, u64)>);
impl gpui::Global for Inventory {}
#[derive(Default)]
pub(in crate::files_panel) struct Rendered(pub Vec<(String, Option<usize>, Option<usize>)>);
impl gpui::Global for Rendered {}
fn git(f: &Fixture, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(&f.repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Git fixture: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn committed() -> Fixture {
    let f = Fixture::new();
    git(&f, &["add", "--all"]);
    git(
        &f,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "fixture",
        ],
    );
    f
}
fn rows(cx: &mut VisualTestContext) -> Vec<(String, Option<usize>, Option<usize>)> {
    cx.update(|_, cx| {
        cx.try_global::<Rendered>()
            .map(|g| g.0.clone())
            .unwrap_or_default()
    })
}
fn until(cx: &mut VisualTestContext, ready: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        draw(cx);
        if ready(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "Changes operation timed out");
        cx.cx.executor().advance_clock(Duration::from_millis(10));
        std::thread::sleep(Duration::from_millis(10));
    }
}
pub(super) fn modes(cx: &mut TestAppContext) {
    let f = committed();
    fs::write(
        PathBuf::from(&f.repo).join("src/useful.rs"),
        format!(
            "pub fn useful() {{ let long = \"{}\"; }}\n",
            "readable ".repeat(60)
        ),
    )
    .unwrap();
    fs::write(PathBuf::from(&f.repo).join("fresh.rs"), "fn fresh() {}\n").unwrap();
    let (_, cx) = test_panel(&f, cx);
    cx.simulate_resize(gpui::size(px(900.), px(700.)));
    click(cx, "files-show-changes");
    wait(cx, "files-change-src/useful.rs");
    assert_eq!(
        cx.debug_bounds("files-changes-totals").unwrap().size.height,
        px(32.)
    );
    assert!(
        cx.debug_bounds("files-change-src/useful.rs")
            .unwrap()
            .size
            .height
            >= px(40.)
    );
    let inventory = cx.update(|_, cx| cx.global::<Inventory>().0.clone());
    assert!(
        inventory
            .iter()
            .any(|(p, _, a, d)| p == "src/useful.rs" && *a == 1 && *d == 1)
    );
    assert!(
        inventory
            .iter()
            .any(|(p, s, _, _)| p == "fresh.rs" && s == "untracked")
    );
    click(cx, "files-change-src/useful.rs");
    wait(cx, "files-diff-unified");
    let rendered = rows(cx);
    assert!(
        rendered
            .iter()
            .any(|(t, o, n)| t == "-fn useful() {}" && *o == Some(1) && n.is_none())
    );
    let index = rendered
        .iter()
        .position(|(t, _, n)| t.starts_with("+pub fn useful") && *n == Some(1))
        .unwrap();
    let selector: &'static str = Box::leak(format!("files-diff-row-{index}").into_boxed_str());
    assert!(
        cx.debug_bounds(selector).unwrap().size.height > px(36.),
        "unified long line wraps at panel width"
    );
    click(cx, "files-diff-side-toggle");
    wait(cx, "files-diff-side");
    assert!(cx.debug_bounds("files-diff-side").unwrap().size.width >= px(900.));
    click(cx, "files-diff-unified-toggle");
    draw(cx);
    assert_eq!(
        f.requests()
            .iter()
            .filter(|r| r.contains("/api/panel/file-diff"))
            .count(),
        1,
        "mode switch retains the loaded diff"
    );
    click(cx, "files-show-files");
    wait(cx, "files-row-AGENTS.md");
}
pub(super) fn clean_refresh(cx: &mut TestAppContext) {
    let f = committed();
    let (_, cx) = test_panel(&f, cx);
    click(cx, "files-show-changes");
    wait(cx, "files-changes-clean");
    fs::write(
        PathBuf::from(&f.repo).join("src/useful.rs"),
        "fn changed() {}\n",
    )
    .unwrap();
    // The classic review route caches snapshots for 20 seconds.
    std::thread::sleep(Duration::from_secs(21));
    click(cx, "files-changes-refresh");
    wait(cx, "files-change-src/useful.rs");
    click(cx, "files-change-src/useful.rs");
    wait(cx, "files-diff-unified");
    fs::write(
        PathBuf::from(&f.repo).join("src/useful.rs"),
        "fn useful() {}",
    )
    .unwrap();
    click(cx, "files-changes-refresh");
    wait(cx, "files-diff-empty");
    assert!(f.requests().iter().any(|r| r.contains("changesOnly=1")));
}
pub(super) fn staged_retry(cx: &mut TestAppContext) {
    let f = committed();
    fs::write(
        PathBuf::from(&f.repo).join("AGENTS.md"),
        "# Staged instructions\n",
    )
    .unwrap();
    git(&f, &["add", "AGENTS.md"]);
    fs::write(f.root.join("legacy-staged-diff"), "").unwrap();
    fs::write(f.root.join("changes-error"), "").unwrap();
    let (_, cx) = test_panel(&f, cx);
    click(cx, "files-show-changes");
    wait(cx, "files-changes-retry");
    fs::remove_file(f.root.join("changes-error")).unwrap();
    click(cx, "files-changes-retry");
    wait(cx, "files-change-AGENTS.md");
    fs::write(f.root.join("diff-error"), "").unwrap();
    click(cx, "files-change-AGENTS.md");
    wait(cx, "files-diff-retry");
    fs::remove_file(f.root.join("diff-error")).unwrap();
    click(cx, "files-diff-retry");
    wait(cx, "files-diff-unified");
    assert!(
        rows(cx)
            .iter()
            .any(|(t, _, n)| t == "+# Staged instructions" && *n == Some(1)),
        "legacy stagedDiff payload remains readable"
    );
    assert_eq!(
        fs::read_to_string(PathBuf::from(&f.repo).join("AGENTS.md")).unwrap(),
        "# Staged instructions\n"
    );
}
fn raw_click(cx: &mut VisualTestContext, id: &'static str) {
    let position = cx.debug_bounds(id).unwrap().center();
    // Queue both selection events before drawing/committing either completion.
    cx.simulate_click(position, gpui::Modifiers::default());
}
pub(super) fn stale_and_draft(cx: &mut TestAppContext) {
    let f = committed();
    fs::write(PathBuf::from(&f.repo).join("AGENTS.md"), "# disk AGENTS\n").unwrap();
    fs::write(
        PathBuf::from(&f.repo).join("src/useful.rs"),
        "fn newest() {}\n",
    )
    .unwrap();
    let (_, cx) = test_panel(&f, cx);
    click(cx, "files-row-AGENTS.md");
    wait(cx, "files-markdown-1");
    click(cx, "files-edit-toggle");
    click(cx, "files-editor");
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-a"
    } else {
        "ctrl-a"
    });
    cx.simulate_input("# Unsaved draft\n");
    draw(cx);
    click(cx, "files-show-changes");
    wait(cx, "files-change-AGENTS.md");
    wait(cx, "files-change-src/useful.rs");
    raw_click(cx, "files-change-AGENTS.md");
    raw_click(cx, "files-change-src/useful.rs");
    until(cx, |cx| {
        rows(cx).iter().any(|(t, _, _)| t == "+fn newest() {}")
    });
    assert!(
        !rows(cx).iter().any(|(t, _, _)| t.contains("disk AGENTS")),
        "late previous selection must not replace current diff"
    );
    click(cx, "files-show-files");
    wait(cx, "files-save");
    click(cx, "files-preview-toggle");
    let document = cx.update(|_, cx| {
        cx.global::<markdown_tests::DocumentView>()
            .text
            .iter()
            .map(|(_, layout)| layout.text())
            .collect::<Vec<_>>()
    });
    assert!(format!("{document:?}").contains("Unsaved draft"));
    assert_eq!(
        fs::read_to_string(PathBuf::from(&f.repo).join("AGENTS.md")).unwrap(),
        "# disk AGENTS\n"
    );
}
