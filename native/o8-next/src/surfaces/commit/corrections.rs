//! Review probes drive the real palette, editor, operator routes, and Git fixture.
use super::*;
#[gpui::test]
fn commit_projects_refresh_retains_unregistered_draft(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--commits");
    let path = fs::canonicalize(&fixture.folders[0]).unwrap();
    let name = path.to_string_lossy().into_owned();
    fixture
        .client
        .project_request(
            "POST",
            "/api/panel/repos",
            &json!({"action":"add","localPath":name}),
        )
        .unwrap();
    let repos = fixture
        .client
        .get::<Value>("/api/panel/repos", &[])
        .unwrap();
    let id = repos["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["localPath"] == name)
        .unwrap()["id"]
        .clone();
    fs::write(path.join("draft.txt"), "loaded bytes").unwrap();
    git(&path, &["config", "user.name", "Fixture"]);
    git(&path, &["config", "user.email", "fixture@example.test"]);
    git(&path, &["add", "-A"]);
    git(&path, &["commit", "-qm", "fixture selected"]);
    fs::write(path.join("draft.txt"), "selected bytes").unwrap();
    git(&path, &["add", "-A"]);
    git(&path, &["commit", "-qm", "fixture comparison"]);
    let hash = git(&path, &["rev-parse", "HEAD"]);
    let mut state = State {
        selected: Some(name.clone()),
        ..State::default()
    };
    state.workspaces.insert(
        name,
        crate::shell_state::Workspace {
            tabs: vec![Tab::Commit],
            ..Default::default()
        },
    );
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("unregistered.json"),
        state,
        cx,
    );
    for _ in 0..6 {
        visual.run_until_parked();
        draw(&mut visual);
    }
    // This intentionally empty-session fixture can open main's Setup overlay.
    // Close it through its real control before exercising Projects retention.
    if let Some(close) = visual.debug_bounds("setup-close") {
        visual.simulate_click(close.center(), gpui::Modifiers::default());
        visual.run_until_parked();
        draw(&mut visual);
    }
    let projects = visual.debug_bounds("shell-projects").unwrap();
    visual.simulate_click(projects.center(), gpui::Modifiers::default());
    for _ in 0..6 {
        visual.run_until_parked();
        draw(&mut visual);
    }
    visual.simulate_keystrokes("ctrl-tab");
    draw(&mut visual);
    let input = visual.debug_bounds("commit-hash").unwrap();
    visual.simulate_click(input.center(), gpui::Modifiers::default());
    visual.simulate_input(&hash);
    visual.simulate_keystrokes("enter");
    wait_commit(&shell, &mut visual);
    edit(&mut visual, "retained draft");
    fixture
        .client
        .project_request("DELETE", "/api/panel/repos", &json!({"id":id}))
        .unwrap();
    let projects = visual.debug_bounds("shell-projects").unwrap();
    visual.simulate_click(projects.center(), gpui::Modifiers::default());
    for _ in 0..6 {
        visual.run_until_parked();
        draw(&mut visual);
    }
    assert!(
        shell
            .read_with(&visual, |s, cx| s.content.values().any(
                |c| matches!(c, Content::Commit(v) if v.read(cx).has_draft(cx))
            )),
        "Projects refresh must not discard a draft after desktop unregisters its repository"
    );
}
pub(super) fn workspace(fixture: &Fixture) -> PathBuf {
    fs::canonicalize(
        fixture.client.sessions().unwrap()[0]
            .repo_path
            .as_ref()
            .unwrap(),
    )
    .unwrap()
}
pub(super) fn git(root: &std::path::Path, args: &[&str]) -> String {
    let output = Process::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().into()
}
pub(super) fn open_commit(
    fixture: &Fixture,
    cx: &mut TestAppContext,
) -> (Entity<Shell>, VisualTestContext) {
    let hash = git(&workspace(fixture), &["rev-parse", "HEAD"]);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("correction.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("o p e n space c o m m i t enter");
    draw(&mut visual);
    click(&mut visual, "commit-hash");
    visual.simulate_input(&hash);
    visual.simulate_keystrokes("enter");
    wait_commit(&shell, &mut visual);
    (shell, visual)
}
pub(super) fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let bounds = cx.debug_bounds(selector).unwrap();
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
}
pub(super) fn edit(cx: &mut VisualTestContext, text: &str) {
    click(cx, "commit-editor");
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input(text);
    draw(cx);
}
#[gpui::test]
fn native_save_and_commit_refuse_a_switched_branch(cx: &mut TestAppContext) {
    for action in ["commit-save", "commit-create"] {
        let fixture = Fixture::new();
        let root = workspace(&fixture);
        let (shell, mut visual) = open_commit(&fixture, cx);
        edit(&mut visual, "native draft\n");
        click(&mut visual, "commit-message");
        visual.simulate_input("native guarded commit");
        draw(&mut visual);
        git(&root, &["checkout", "-b", "desktop-switched"]);
        fs::write(root.join("changed.ts"), "desktop newer\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-qm", "desktop change"]);
        let before = git(&root, &["rev-parse", "HEAD"]);
        click(&mut visual, action);
        wait_commit(&shell, &mut visual);
        assert_eq!(
            fs::read_to_string(root.join("changed.ts")).unwrap(),
            "desktop newer\n",
            "stale native action must preserve desktop bytes"
        );
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), before);
    }
}
#[gpui::test]
fn commit_draft_survives_close_settings_and_file_switch(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = workspace(&fixture);
    let (shell, mut visual) = open_commit(&fixture, cx);
    edit(&mut visual, "retained draft\n");
    visual.simulate_keystrokes("ctrl-w");
    draw(&mut visual);
    assert!(
        shell.read_with(&visual, |s, _| matches!(s.active(), Some(Tab::Commit))),
        "dirty commit editor must survive Ctrl+W"
    );
    assert!(
        !visual.simulate_close(),
        "window close must preserve unsaved drafts"
    );
    visual.simulate_keystrokes("ctrl-,");
    draw(&mut visual);
    assert!(shell.read_with(&visual, |s, _| s.surfaces.settings.view.is_some()));
    visual.simulate_keystrokes("ctrl-,");
    draw(&mut visual);
    let initial = shell.read_with(&visual, |s, _| s.state.selected.clone().unwrap());
    let index = shell.read_with(&visual, |s, _| {
        s.workspaces.iter().position(|w| *w == initial).unwrap()
    });
    for selector in if index == 0 {
        ["workspace-1", "workspace-0"]
    } else {
        ["workspace-0", "workspace-1"]
    } {
        let bounds = visual.debug_bounds(selector).unwrap();
        visual.simulate_click(bounds.center(), gpui::Modifiers::default());
        visual.run_until_parked();
        draw(&mut visual);
    }
    assert_eq!(
        shell.read_with(&visual, |s, _| s.state.selected.clone()),
        Some(initial)
    );
    click(&mut visual, "commit-file-1");
    draw(&mut visual);
    click(&mut visual, "commit-editor");
    visual.simulate_keystrokes("ctrl-a ctrl-c");
    assert_eq!(
        visual
            .read_from_clipboard()
            .and_then(|i| i.text())
            .as_deref(),
        Some("retained draft\n")
    );
    click(&mut visual, "commit-save");
    wait_commit(&shell, &mut visual);
    assert_eq!(
        fs::read_to_string(root.join("changed.ts")).unwrap(),
        "retained draft\n"
    );
}
#[gpui::test]
fn commit_never_displays_or_copies_secret_canaries(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = workspace(&fixture);
    let canary = ["fixture-private", "commit-canary"].join("-");
    fs::write(
        root.join("changed.ts"),
        format!("token = {canary}\nhttps://user:{canary}@example.invalid/path\n"),
    )
    .unwrap();
    let (shell, mut visual) = open_commit(&fixture, cx);
    assert!(
        visual.debug_bounds("commit-editor").is_none(),
        "sensitive workspace content must never reach the editor"
    );
    visual.simulate_keystrokes("ctrl-a ctrl-c");
    assert!(
        !visual
            .read_from_clipboard()
            .and_then(|i| i.text())
            .unwrap_or_default()
            .contains(&canary)
    );
    assert!(
        !shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Commit)) {
            Some(Content::Commit(v)) => v.read(cx).test_notice().contains(&canary),
            _ => false,
        })
    );
    assert!(
        !fs::read_to_string(fixture.root.join("fixture.log"))
            .unwrap_or_default()
            .contains(&canary)
    );
}
#[gpui::test]
fn commit_binary_and_large_files_stay_read_only(cx: &mut TestAppContext) {
    for bytes in [vec![0xff, 0, 0xfe], vec![b'x'; 2 * 1024 * 1024]] {
        let fixture = Fixture::new();
        let root = workspace(&fixture);
        fs::write(root.join("changed.ts"), &bytes).unwrap();
        let started = Instant::now();
        let (shell, mut visual) = open_commit(&fixture, cx);
        let opened_ms = started.elapsed().as_secs_f64() * 1000.;
        let paint_started = Instant::now();
        draw(&mut visual);
        let paint_ms = paint_started.elapsed().as_secs_f64() * 1000.;
        assert!(
            visual.debug_bounds("commit-editor").is_none(),
            "binary and large files must stay outside the text editor"
        );
        assert!(visual.debug_bounds("commit-readonly").is_some());
        visual.simulate_keystrokes("ctrl-s");
        wait_commit(&shell, &mut visual);
        assert_eq!(fs::read(root.join("changed.ts")).unwrap(), bytes);
        println!(
            "O8_NEXT_COMMIT_READONLY_EVIDENCE {}",
            json!({"bytes":bytes.len(),"openToFrameMs":opened_ms,"loadedPaintMs":paint_ms})
        );
    }
}
#[gpui::test]
fn commit_save_shortcut_respects_focused_message(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = workspace(&fixture);
    let (shell, mut visual) = open_commit(&fixture, cx);
    let before = fs::read(root.join("changed.ts")).unwrap();
    edit(&mut visual, "unsaved file\n");
    click(&mut visual, "commit-message");
    visual.simulate_input("r u s");
    visual.simulate_keystrokes("ctrl-s");
    wait_commit(&shell, &mut visual);
    assert_eq!(
        fs::read(root.join("changed.ts")).unwrap(),
        before,
        "source Save shortcut must not steal focused message input"
    );
}

#[gpui::test]
fn commit_remote_error_hides_credential_url_canary(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = workspace(&fixture);
    let (shell, mut visual) = open_commit(&fixture, cx);
    let canary = ["fixture-private", "remote-canary"].join("-");
    git(
        &root,
        &[
            "remote",
            "add",
            "origin",
            &format!("http://fixture:{canary}@127.0.0.1:1/owned.git"),
        ],
    );
    click(&mut visual, "commit-push");
    wait_commit(&shell, &mut visual);
    assert!(
        !shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Commit)) {
            Some(Content::Commit(v)) => v.read(cx).test_notice().contains(&canary),
            _ => false,
        })
    );
    assert!(
        !fs::read_to_string(fixture.root.join("fixture.log"))
            .unwrap_or_default()
            .contains(&canary)
    );
}

#[gpui::test]
fn commit_hook_canary_never_reaches_ui_or_server_logs(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let root = workspace(&fixture);
    let (shell, mut visual) = open_commit(&fixture, cx);
    let canary = ["fixture-private", "hook-canary"].join("-");
    let hook = root.join(".git/hooks/pre-commit");
    fs::write(
        &hook,
        format!("#!/bin/sh\nprintf '%s\\n' 'password = {canary}' >&2\nexit 1\n"),
    )
    .unwrap();
    assert!(
        Process::new("node")
            .args(["-e", "require('node:fs').chmodSync(process.argv[1],0o755)"])
            .arg(&hook)
            .status()
            .unwrap()
            .success()
    );
    edit(&mut visual, "guarded hook draft\n");
    click(&mut visual, "commit-message");
    visual.simulate_input("hook should refuse");
    draw(&mut visual);
    let before = git(&root, &["rev-parse", "HEAD"]);
    click(&mut visual, "commit-create");
    wait_commit(&shell, &mut visual);
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), before);
    assert!(
        !shell.read_with(&visual, |s, cx| match s.content.get(&s.key(&Tab::Commit)) {
            Some(Content::Commit(v)) => v.read(cx).test_notice().contains(&canary),
            _ => false,
        })
    );
    assert!(
        !fs::read_to_string(fixture.root.join("fixture.log"))
            .unwrap_or_default()
            .contains(&canary),
        "hook diagnostics must never reach fixture logs"
    );
}

#[gpui::test]
fn commit_hook_retry_uses_the_successful_save_revision(cx: &mut TestAppContext) {
    for path in ["changed.ts", "removed.txt"] {
        let fixture = Fixture::new();
        let root = workspace(&fixture);
        let (shell, mut visual) = open_commit(&fixture, cx);
        if path == "removed.txt" {
            click(&mut visual, "commit-file-1");
            wait_commit(&shell, &mut visual);
        }
        let hook = root.join(".git/hooks/pre-commit");
        fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        assert!(
            Process::new("node")
                .args(["-e", "require('node:fs').chmodSync(process.argv[1],0o755)"])
                .arg(&hook)
                .status()
                .unwrap()
                .success()
        );
        edit(&mut visual, "saved before hook refusal\n");
        click(&mut visual, "commit-message");
        visual.simulate_input("retry guarded commit");
        draw(&mut visual);
        let before = git(&root, &["rev-parse", "HEAD"]);
        click(&mut visual, "commit-create");
        wait_commit(&shell, &mut visual);
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), before);
        assert_eq!(
            fs::read_to_string(root.join(path)).unwrap(),
            "saved before hook refusal\n"
        );
        fs::remove_file(hook).unwrap();
        click(&mut visual, "commit-create");
        wait_commit(&shell, &mut visual);
        assert_ne!(
            git(&root, &["rev-parse", "HEAD"]),
            before,
            "retry must carry the revision returned by its successful Save"
        );
    }
}
