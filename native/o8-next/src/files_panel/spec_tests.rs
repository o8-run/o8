//! Native notes through the real repo-spec routes, isolated repository and disk.
use super::*;
#[derive(Default)]
pub(in crate::files_panel) struct Painted(pub Vec<(String, f32, f32)>);
impl gpui::Global for Painted {}
#[derive(Default)]
pub(in crate::files_panel) struct Status {
    pub text: String,
    pub content: String,
    pub pending: bool,
}
impl gpui::Global for Status {}
fn panel<'a>(
    f: &Fixture,
    cx: &'a mut TestAppContext,
) -> (Entity<FilesPanel>, &'a mut VisualTestContext) {
    cx.add_window_view(|window, cx| {
        let p = FilesPanel::new(f.client.clone(), f.repo.clone(), Mode::Spec, cx);
        window.activate_window();
        p.focus(window);
        p
    })
}
fn path(f: &Fixture) -> PathBuf {
    PathBuf::from(&f.repo).join("o8.md")
}
fn advance(cx: &mut VisualTestContext, ms: u64) {
    cx.cx.executor().advance_clock(Duration::from_millis(ms));
    draw(cx);
}
fn until(cx: &mut VisualTestContext, ready: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        draw(cx);
        if ready(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "notes operation timed out");
        std::thread::sleep(Duration::from_millis(10));
        cx.cx.executor().advance_clock(Duration::from_millis(10));
    }
}
fn replace(cx: &mut VisualTestContext, text: &str) {
    click(cx, "spec-editor");
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-a"
    } else {
        "ctrl-a"
    });
    cx.simulate_input(text);
    draw(cx);
}
fn content(cx: &mut VisualTestContext) -> String {
    cx.update(|_, cx| cx.global::<Status>().content.clone())
}
fn puts(f: &Fixture) -> usize {
    f.requests()
        .iter()
        .filter(|r| r.starts_with("PUT /api/repo-spec"))
        .count()
}
pub(super) fn autosave(cx: &mut TestAppContext) {
    let f = Fixture::new();
    fs::write(path(&f), "# Fixture notes\n\nOld text.\n").unwrap();
    let (_, cx) = panel(&f, cx);
    wait(cx, "spec-editor");
    assert_eq!(cx.debug_bounds("spec-header").unwrap().size.height, px(58.));
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-z"
    } else {
        "ctrl-z"
    });
    draw(cx);
    assert_eq!(
        content(cx),
        "# Fixture notes\n\nOld text.\n",
        "initial load has no undo entry"
    );
    replace(cx, "# Fixture notes\n\nFirst draft.\n");
    advance(cx, 650);
    assert_eq!(puts(&f), 0);
    cx.simulate_input("Second edit.");
    advance(cx, 700);
    assert_eq!(puts(&f), 0);
    advance(cx, 110);
    until(cx, |cx| !cx.update(|_, cx| cx.global::<Status>().pending));
    assert_eq!(puts(&f), 1);
    assert!(
        fs::read_to_string(path(&f))
            .unwrap()
            .ends_with("Second edit.")
    );
    assert!(cx.update(|_, cx| cx.global::<Status>().text.starts_with("Saved ")));
    let body: Value =
        serde_json::from_str(&fs::read_to_string(f.root.join("last-body.json")).unwrap()).unwrap();
    assert!(body["expectedHash"].as_str().is_some());
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-z"
    } else {
        "ctrl-z"
    });
    draw(cx);
    assert_ne!(content(cx), fs::read_to_string(path(&f)).unwrap());
}
pub(super) fn conflict(cx: &mut TestAppContext) {
    let f = Fixture::new();
    fs::write(path(&f), "Original\n").unwrap();
    let (_, cx) = panel(&f, cx);
    wait(cx, "spec-editor");
    replace(cx, "Operator draft\n");
    fs::write(path(&f), "External change\n").unwrap();
    advance(cx, 810);
    wait(cx, "spec-conflict");
    assert_eq!(content(cx), "Operator draft\n");
    assert_eq!(fs::read_to_string(path(&f)).unwrap(), "External change\n");
    click(cx, "spec-conflict-reload");
    assert_eq!(content(cx), "External change\n");
    replace(cx, "Explicit overwrite\n");
    fs::write(path(&f), "External again\n").unwrap();
    advance(cx, 810);
    wait(cx, "spec-conflict-overwrite");
    click(cx, "spec-conflict-overwrite");
    until(cx, |cx| !cx.update(|_, cx| cx.global::<Status>().pending));
    assert_eq!(
        fs::read_to_string(path(&f)).unwrap(),
        "Explicit overwrite\n"
    );
    let body: Value =
        serde_json::from_str(&fs::read_to_string(f.root.join("last-body.json")).unwrap()).unwrap();
    assert_eq!(body["force"], true);
}
pub(super) fn poll(cx: &mut TestAppContext) {
    let f = Fixture::new();
    fs::write(path(&f), "Old\n").unwrap();
    let (_, cx) = panel(&f, cx);
    wait(cx, "spec-editor");
    fs::write(path(&f), "External clean update\n").unwrap();
    advance(cx, 4100);
    until(cx, |cx| content(cx) == "External clean update\n");
    assert_eq!(puts(&f), 0);
    replace(cx, "Dirty local\n");
    fs::write(path(&f), "External while dirty\n").unwrap();
    advance(cx, 4100);
    draw(cx);
    assert_eq!(content(cx), "Dirty local\n");
    assert_eq!(
        fs::read_to_string(path(&f)).unwrap(),
        "External while dirty\n"
    );
}
pub(super) fn typography(cx: &mut TestAppContext) {
    let f = Fixture::new();
    fs::write(path(&f),"# Heading one\n## Heading two\n### Heading three\n\nBody **strong**, *emphasis* and `code`.\n").unwrap();
    let (_, cx) = panel(&f, cx);
    wait(cx, "spec-editor");
    draw(cx);
    let rows = cx.update(|_, cx| cx.global::<Painted>().0.clone());
    assert!(rows.iter().any(|(t, s, _)| t == "Heading one" && *s == 18.));
    assert!(rows.iter().any(|(t, s, _)| t == "HEADING TWO" && *s == 10.));
    assert!(
        rows.iter()
            .any(|(t, s, _)| t == "Heading three" && *s == 13.5)
    );
    let frame = cx.debug_bounds("spec-frame").unwrap();
    let root = cx.debug_bounds("spec-root").unwrap();
    assert!(frame.left() >= root.left() + px(14.) && frame.size.width <= px(920.));
}
pub(super) fn missing(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (_, cx) = panel(&f, cx);
    wait(cx, "spec-editor");
    assert!(content(cx).contains("#"));
    assert!(
        !path(&f).exists(),
        "loading a missing document must not write it"
    );
    replace(cx, "# Started notes\n");
    advance(cx, 810);
    until(cx, |cx| !cx.update(|_, cx| cx.global::<Status>().pending));
    assert_eq!(fs::read_to_string(path(&f)).unwrap(), "# Started notes\n");
}

#[path = "spec_preferences_tests.rs"]
mod preferences;
