//! Review regressions through the real shell, operator routes, and owned files.
use super::*;

fn open_file(
    path: &str,
    fixture: &Fixture,
    cx: &mut TestAppContext,
) -> (Entity<Shell>, VisualTestContext) {
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("corrections.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("o p e n space f i l e enter");
    draw(&mut visual);
    let input = visual.debug_bounds("file-path").unwrap();
    visual.simulate_click(input.center(), gpui::Modifiers::default());
    visual.simulate_input(path);
    visual.simulate_keystrokes("enter");
    wait_file(&shell, &mut visual, path, false);
    (shell, visual)
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
fn edit(cx: &mut VisualTestContext, text: &str) {
    let editor = cx.debug_bounds("file-editor").unwrap();
    cx.simulate_click(editor.center(), gpui::Modifiers::default());
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input(text);
    draw(cx);
}
#[gpui::test]
fn binary_files_are_read_only_through_shell(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = workspace(&fixture).join("binary.dat");
    let bytes = [0xff, 0, 0xfe];
    fs::write(&file, bytes).unwrap();
    let (_, mut visual) = open_file("binary.dat", &fixture, cx);
    assert!(
        visual.debug_bounds("file-editor").is_none(),
        "binary bytes must never enter the text editor"
    );
    assert!(
        visual.debug_bounds("file-binary").is_some(),
        "binary files need a clear read-only state"
    );
    visual.simulate_input("corrupt");
    visual.simulate_keystrokes("ctrl-s");
    visual.run_until_parked();
    assert_eq!(fs::read(file).unwrap(), bytes);
}
#[gpui::test]
fn dirty_file_close_keeps_draft_and_can_be_cancelled_or_confirmed(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = workspace(&fixture).join("close.txt");
    fs::write(&file, "original").unwrap();
    let (shell, mut visual) = open_file("close.txt", &fixture, cx);
    edit(&mut visual, "unsaved draft");
    visual.simulate_keystrokes("ctrl-w");
    draw(&mut visual);
    assert!(
        shell.read_with(&visual, |s, _| matches!(s.active(), Some(Tab::Files))),
        "Ctrl+W must preserve an unsaved Files entity"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "original");
    // Cancelling the confirmation leaves the same editor and save path alive.
    visual.simulate_keystrokes("escape");
    visual.simulate_keystrokes("ctrl-s");
    for _ in 0..30 {
        visual.run_until_parked();
        draw(&mut visual);
        if fs::read_to_string(&file).unwrap() == "unsaved draft" {
            break;
        }
    }
    assert_eq!(fs::read_to_string(&file).unwrap(), "unsaved draft");
    edit(&mut visual, "discarded draft");
    visual.simulate_keystrokes("ctrl-w");
    draw(&mut visual);
    visual.simulate_keystrokes("ctrl-w");
    draw(&mut visual);
    assert!(!shell.read_with(&visual, |s, _| matches!(s.active(), Some(Tab::Files))));
    assert_eq!(fs::read_to_string(&file).unwrap(), "unsaved draft");
    // Reopening and closing an unchanged file needs no discard confirmation.
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("o p e n space f i l e enter");
    draw(&mut visual);
    let input = visual.debug_bounds("file-path").unwrap();
    visual.simulate_click(input.center(), gpui::Modifiers::default());
    visual.simulate_input("close.txt");
    visual.simulate_keystrokes("enter");
    wait_file(&shell, &mut visual, "close.txt", false);
    visual.simulate_keystrokes("ctrl-w");
    draw(&mut visual);
    assert!(!shell.read_with(&visual, |s, _| matches!(s.active(), Some(Tab::Files))));
}
#[gpui::test]
fn conflict_reload_limits_an_externally_enlarged_file(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = workspace(&fixture).join("reload.txt");
    fs::write(&file, "original").unwrap();
    let (shell, mut visual) = open_file("reload.txt", &fixture, cx);
    edit(&mut visual, "draft");
    let large = "x".repeat(2 * 1024 * 1024);
    fs::write(&file, &large).unwrap();
    visual.simulate_keystrokes("ctrl-s");
    for _ in 0..30 {
        visual.run_until_parked();
        draw(&mut visual);
        if visual.debug_bounds("file-reload").is_some() {
            break;
        }
    }
    let reload = visual
        .debug_bounds("file-reload")
        .expect("changed-on-disk reload");
    let started = Instant::now();
    visual.simulate_click(reload.center(), gpui::Modifiers::default());
    draw(&mut visual);
    for _ in 0..30 {
        visual.run_until_parked();
        draw(&mut visual);
        if shell.read_with(&visual, |s,cx| matches!(s.content.get(&s.key(&Tab::Files)), Some(Content::Files(files)) if files.read(cx).test_ready("reload.txt", true))) { break; }
    }
    assert!(shell.read_with(&visual, |s, cx| matches!(s.content.get(&s.key(&Tab::Files)), Some(Content::Files(files)) if files.read(cx).test_ready("reload.txt", true))), "conflict reload must apply the same preview limit as initial open");
    assert!(visual.debug_bounds("file-preview").is_some());
    let frame_ms = started.elapsed().as_secs_f64() * 1000.;
    visual.simulate_keystrokes("ctrl-s");
    visual.run_until_parked();
    assert_eq!(fs::read_to_string(&file).unwrap(), large);
    println!(
        "O8_NEXT_RELOAD_EVIDENCE {}",
        json!({"interactionToFrameMs": frame_ms, "fileBytes":large.len(), "previewCharacters":100000})
    );
}
