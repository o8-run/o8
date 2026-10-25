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
        Self::start_mode(false, "")
    }
    fn start_mode(projects: bool, option: &str) -> Self {
        Self(crate::shell::test_support::Fixture::start_mode(
            projects,
            &format!("{option} --files"),
        ))
    }
    fn arguments(brain: bool, settings: bool, extra: &[&str]) -> Self {
        let mut args = extra.to_vec();
        if brain {
            args.push("--brain");
        }
        if settings {
            args.push("--settings");
        }
        Self::start_mode(false, &args.join(" "))
    }
}
fn wait_file(shell: &Entity<Shell>, cx: &mut VisualTestContext, path: &str, truncated: bool) {
    for _ in 0..30 {
        cx.run_until_parked();
        draw(cx);
        if shell.read_with(cx, |s, cx| {
            matches!(s.content.get(&s.key(&Tab::Files)),
            Some(Content::Files(files)) if files.read(cx).test_ready(path, truncated))
        }) {
            return;
        }
    }
    panic!("requested file must finish loading and reach its frame");
}

#[gpui::test]
fn shell_opens_file_viewer_from_commands(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
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
    assert_eq!(
        shell.read_with(&visual, |s, _| s.active().map(|tab| tab.label())),
        Some("Files"),
        "the native shell must open the file viewer through its command palette",
    );
    assert!(visual.debug_bounds("file-path").is_some());
}

#[gpui::test]
fn shell_file_actions_reach_persisted_bytes_and_frames(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let workspace = fs::canonicalize(
        fixture.client.sessions().unwrap()[0]
            .repo_path
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    let file = workspace.join("viewer.md");
    fs::write(&file, "# Fixture\n").unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("actions.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    let cx = &mut visual;
    let started = Instant::now();
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("o p e n space f i l e enter");
    draw(cx);
    let path = cx
        .debug_bounds("file-path")
        .expect("native file path input");
    cx.simulate_click(path.center(), gpui::Modifiers::default());
    cx.simulate_input("viewer.md");
    cx.simulate_keystrokes("enter");
    wait_file(&shell, cx, "viewer.md", false);
    let editor = cx
        .debug_bounds("file-editor")
        .expect("loaded source editor");
    let first_frame = started.elapsed().as_secs_f64() * 1000.;
    cx.simulate_click(editor.center(), gpui::Modifiers::default());
    cx.simulate_keystrokes("ctrl-a");
    let started = Instant::now();
    cx.simulate_input("# Saved");
    cx.simulate_keystrokes("enter");
    cx.simulate_input("🙂");
    cx.simulate_keystrokes("enter");
    draw(cx);
    let edit_frame = started.elapsed().as_secs_f64() * 1000.;
    cx.simulate_keystrokes("ctrl-s");
    for _ in 0..30 {
        cx.run_until_parked();
        draw(cx);
        if fs::read_to_string(&file).unwrap() == "# Saved\n🙂\n" {
            break;
        }
    }
    assert_eq!(fs::read_to_string(&file).unwrap(), "# Saved\n🙂\n");
    cx.run_until_parked();
    draw(cx);
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("# Draft\n");
    fs::write(&file, "# External\n").unwrap();
    cx.simulate_keystrokes("ctrl-s");
    for _ in 0..30 {
        cx.run_until_parked();
        draw(cx);
        if cx.debug_bounds("file-reload").is_some() {
            break;
        }
    }
    assert_eq!(fs::read_to_string(&file).unwrap(), "# External\n");
    let reload = cx
        .debug_bounds("file-reload")
        .expect("conflict reload control");
    cx.simulate_click(reload.center(), gpui::Modifiers::default());
    wait_file(&shell, cx, "viewer.md", false);
    draw(cx);
    let editor = cx.debug_bounds("file-editor").unwrap();
    cx.simulate_click(editor.center(), gpui::Modifiers::default());
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("# Overwritten\n");
    fs::write(&file, "# External again\n").unwrap();
    cx.simulate_keystrokes("ctrl-s");
    for _ in 0..30 {
        cx.run_until_parked();
        draw(cx);
        if cx.debug_bounds("file-overwrite").is_some() {
            break;
        }
    }
    let overwrite = cx
        .debug_bounds("file-overwrite")
        .expect("explicit overwrite control");
    cx.simulate_click(overwrite.center(), gpui::Modifiers::default());
    for _ in 0..30 {
        cx.run_until_parked();
        draw(cx);
        if fs::read_to_string(&file).unwrap() == "# Overwritten\n" {
            break;
        }
    }
    assert_eq!(fs::read_to_string(&file).unwrap(), "# Overwritten\n");
    wait_file(&shell, cx, "viewer.md", false);
    let open_path = |cx: &mut VisualTestContext, path: &str| {
        draw(cx);
        let input = cx.debug_bounds("file-path").unwrap();
        cx.simulate_click(input.center(), gpui::Modifiers::default());
        cx.simulate_keystrokes("ctrl-a");
        cx.simulate_input(path);
        cx.simulate_keystrokes("enter");
        cx.run_until_parked();
        draw(cx);
    };
    open_path(cx, "missing.txt");
    for _ in 0..30 {
        cx.run_until_parked();
        draw(cx);
        if cx.debug_bounds("file-retry").is_some() {
            break;
        }
    }
    let retry = cx
        .debug_bounds("file-retry")
        .expect("file read error exposes Retry");
    fs::write(workspace.join("missing.txt"), "").unwrap();
    cx.simulate_click(retry.center(), gpui::Modifiers::default());
    wait_file(&shell, cx, "missing.txt", false);
    assert!(
        cx.debug_bounds("file-editor").is_some(),
        "an empty file is editable after retry"
    );
    fs::write(workspace.join("large.txt"), "x".repeat(100_001)).unwrap();
    open_path(cx, "large.txt");
    wait_file(&shell, cx, "large.txt", true);
    assert!(cx.debug_bounds("file-preview").is_some());
    cx.simulate_keystrokes("ctrl-s");
    cx.run_until_parked();
    assert_eq!(
        fs::read_to_string(workspace.join("large.txt"))
            .unwrap()
            .len(),
        100_001
    );
    println!(
        "O8_NEXT_FILES_EVIDENCE {}",
        json!({"endpoint":"GPUI TestAppContext CPU scene; no GPU/compositor", "openToFirstFrameMs":first_frame,"interactionToFrameMs":edit_frame,"persistedSaves":2,"conflictReloads":1,"conflictOverwrites":1})
    );
}

#[path = "corrections.rs"]
mod corrections;

#[path = "boundaries.rs"]
mod boundaries;

#[path = "round2.rs"]
mod round2;

#[path = "privacy_matrix.rs"]
mod privacy_matrix;
