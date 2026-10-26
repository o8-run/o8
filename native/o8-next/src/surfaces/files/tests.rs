use super::*;
use crate::shell::test_support::*;
struct Fixture(crate::shell::test_support::Fixture);
impl std::ops::Deref for Fixture {
    type Target = crate::shell::test_support::Fixture;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl Fixture {
    fn new() -> Self {
        Self(crate::shell::test_support::Fixture::start_mode(
            false, "--files",
        ))
    }
}
fn workspace(fixture: &Fixture) -> PathBuf {
    fs::canonicalize(
        fixture.client.sessions().unwrap()[0]
            .repo_path
            .as_ref()
            .unwrap(),
    )
    .unwrap()
}
fn pane(fixture: &Fixture, cx: &mut TestAppContext) -> (Entity<Shell>, VisualTestContext) {
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("files.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("o p e n space f i l e enter");
    draw(&mut visual);
    assert!(visual.debug_bounds("file-path").is_some());
    (shell, visual)
}
fn open_file(
    path: &str,
    fixture: &Fixture,
    cx: &mut TestAppContext,
) -> (Entity<Shell>, VisualTestContext) {
    let (shell, mut visual) = pane(fixture, cx);
    choose(&shell, &mut visual, path, false);
    (shell, visual)
}
fn choose(shell: &Entity<Shell>, visual: &mut VisualTestContext, path: &str, truncated: bool) {
    let input = visual.debug_bounds("file-path").unwrap();
    visual.simulate_click(input.center(), gpui::Modifiers::default());
    visual.simulate_keystrokes("ctrl-a");
    visual.simulate_input(path);
    click(visual, "file-open");
    wait_file(shell, visual, path, truncated);
}
fn wait_file(shell: &Entity<Shell>, visual: &mut VisualTestContext, path: &str, truncated: bool) {
    for _ in 0..40 {
        visual.run_until_parked();
        draw(visual);
        if shell.read_with(visual, |s, cx| matches!(s.content.get(&s.key(&Tab::Files)), Some(Content::Files(view)) if view.read(cx).test_ready(path, truncated))) { return; }
    }
    panic!("file must reach a complete read-only frame");
}
fn click(visual: &mut VisualTestContext, selector: &'static str) {
    let target = visual.debug_bounds(selector).expect("native control");
    visual.simulate_click(target.center(), gpui::Modifiers::default());
    draw(visual);
}
#[gpui::test]
fn browse_open_copy_refresh_and_parent_reach_real_routes(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = workspace(&fixture);
    fs::create_dir(root.join("folder")).unwrap();
    fs::write(root.join("folder/note.ts"), "export const value = 42;\n").unwrap();
    let (shell, mut visual) = pane(&fixture, cx);
    for _ in 0..20 {
        visual.run_until_parked();
        draw(&mut visual);
    }
    let entries = fixture
        .client
        .get::<Value>(
            "/api/panel/files",
            &[("workspace", root.to_str().unwrap()), ("directory", "")],
        )
        .unwrap();
    let index = entries["entries"]
        .as_array()
        .unwrap()
        .iter()
        .position(|e| e["path"] == "folder")
        .unwrap();
    // GPUI's test selector API requires a static label.
    let selector = Box::leak(format!("file-entry-{index}").into_boxed_str());
    click(&mut visual, selector);
    for _ in 0..20 {
        visual.run_until_parked();
        draw(&mut visual);
    }
    let opened = Instant::now();
    click(&mut visual, "file-entry-0");
    let first_frame_ms = opened.elapsed().as_secs_f64() * 1000.;
    wait_file(&shell, &mut visual, "folder/note.ts", false);
    let open_ms = opened.elapsed().as_secs_f64() * 1000.;
    assert!(
        shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Files)) {
            Some(Content::Files(view)) => view.read(cx).test_styled(),
            _ => false,
        })
    );
    let interaction = Instant::now();
    click(&mut visual, "file-copy");
    let copy_ms = interaction.elapsed().as_secs_f64() * 1000.;
    assert_eq!(
        visual
            .read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some("export const value = 42;\n")
    );
    fs::write(root.join("folder/note.ts"), "export const value = 43;\n").unwrap();
    click(&mut visual, "file-refresh");
    wait_file(&shell, &mut visual, "folder/note.ts", false);
    click(&mut visual, "file-copy");
    assert_eq!(
        visual
            .read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some("export const value = 43;\n")
    );
    click(&mut visual, "file-up");
    for _ in 0..10 {
        visual.run_until_parked();
        draw(&mut visual);
    }
    fs::write(root.join("fresh.ts"), "export const fresh = true;\n").unwrap();
    click(&mut visual, "file-browse-retry");
    for _ in 0..20 {
        visual.run_until_parked();
        draw(&mut visual);
    }
    let entries = fixture
        .client
        .get::<Value>(
            "/api/panel/files",
            &[("workspace", root.to_str().unwrap()), ("directory", "")],
        )
        .unwrap();
    let index = entries["entries"]
        .as_array()
        .unwrap()
        .iter()
        .position(|e| e["path"] == "fresh.ts")
        .unwrap();
    click(
        &mut visual,
        Box::leak(format!("file-entry-{index}").into_boxed_str()),
    );
    wait_file(&shell, &mut visual, "fresh.ts", false);
    visual.simulate_keystrokes("ctrl-w");
    draw(&mut visual);
    assert!(!shell.read_with(&visual, |s, _| matches!(s.active(), Some(Tab::Files))));
    println!(
        "O8_NEXT_READONLY_FILES {}",
        json!({"endpoint":"GPUI CPU scene; no GPU/compositor", "openToFirstFrameMs":first_frame_ms, "openToLoadedFrameMs":open_ms, "copyToFrameMs":copy_ms})
    );
}
#[gpui::test]
fn large_external_refresh_and_binary_reads_stay_bounded(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = workspace(&fixture);
    let file = root.join("large.txt");
    fs::write(&file, "small").unwrap();
    let (shell, mut visual) = open_file("large.txt", &fixture, cx);
    fs::write(&file, vec![b'x'; 32 * 1024 * 1024]).unwrap();
    let started = Instant::now();
    click(&mut visual, "file-refresh");
    let immediate_ms = started.elapsed().as_secs_f64() * 1000.;
    wait_file(&shell, &mut visual, "large.txt", true);
    assert!(
        shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Files)) {
            Some(Content::Files(view)) => view.read(cx).test_bounded(),
            _ => false,
        })
    );
    assert_eq!(fs::metadata(&file).unwrap().len(), 32 * 1024 * 1024);
    fs::write(root.join("binary.dat"), [0xff, 0, 0xfe]).unwrap();
    choose(&shell, &mut visual, "binary.dat", false);
    assert!(visual.debug_bounds("file-binary").is_some());
    visual.write_to_clipboard(gpui::ClipboardItem::new_string("safe clipboard".into()));
    click(&mut visual, "file-copy");
    assert_eq!(
        visual
            .read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref(),
        Some("safe clipboard")
    );
    println!(
        "O8_NEXT_READONLY_LARGE {}",
        json!({"bytes":33554432, "refreshToLoadingFrameMs":immediate_ms, "previewCharacters":100000,"maxLineCharacters":2049})
    );
}
#[gpui::test]
fn empty_errors_retry_and_path_escapes_are_distinct(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = workspace(&fixture);
    fs::write(root.join("empty.txt"), "").unwrap();
    let (shell, mut visual) = open_file("empty.txt", &fixture, cx);
    assert!(visual.debug_bounds("file-source").is_some());
    let outside = root.parent().unwrap().join("outside.txt");
    fs::write(&outside, "owned outside canary").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("escape.txt")).unwrap();
    for path in [
        "missing.txt",
        "../outside.txt",
        outside.to_str().unwrap(),
        "escape.txt",
    ] {
        let input = visual.debug_bounds("file-path").unwrap();
        visual.simulate_click(input.center(), gpui::Modifiers::default());
        visual.simulate_keystrokes("ctrl-a");
        visual.simulate_input(path);
        visual.simulate_keystrokes("enter");
        for _ in 0..20 {
            visual.run_until_parked();
            draw(&mut visual);
        }
        assert!(visual.debug_bounds("file-retry").is_some());
        if path == "missing.txt" {
            fs::write(root.join(path), "export const retried = true;\n").unwrap();
            click(&mut visual, "file-retry");
            wait_file(&shell, &mut visual, path, false);
        }
    }
    assert_eq!(
        fs::read_to_string(&outside).unwrap(),
        "owned outside canary"
    );
    choose(&shell, &mut visual, "empty.txt", false);
    assert!(visual.debug_bounds("file-source").is_some());
}
#[path = "privacy_matrix.rs"]
mod privacy_matrix;
#[path = "readonly_tests.rs"]
mod readonly_tests;
