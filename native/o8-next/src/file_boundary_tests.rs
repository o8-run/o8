use super::corrections::{edit, open_file, workspace};
use super::*;
#[gpui::test]
fn file_boundary_projects_refresh_retains_unregistered_draft(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--files");
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
    let mut state = State::default();
    state.selected = Some(name.clone());
    state.workspaces.insert(
        name,
        crate::shell_state::Workspace {
            tabs: vec![Tab::Files],
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
    let projects = visual.debug_bounds("shell-projects").unwrap();
    visual.simulate_click(projects.center(), gpui::Modifiers::default());
    for _ in 0..6 {
        visual.run_until_parked();
        draw(&mut visual);
    }
    visual.simulate_keystrokes("ctrl-tab");
    draw(&mut visual);
    let input = visual.debug_bounds("file-path").unwrap();
    visual.simulate_click(input.center(), gpui::Modifiers::default());
    visual.simulate_input("draft.txt");
    visual.simulate_keystrokes("enter");
    wait_file(&shell, &mut visual, "draft.txt", false);
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
                |c| matches!(c, Content::Files(v) if v.read(cx).has_draft(cx))
            )),
        "Projects refresh must not discard a draft after desktop unregisters its repository"
    );
}
#[gpui::test]
fn file_boundary_overwrite_refuses_a_second_desktop_revision(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = workspace(&fixture).join("overwrite.txt");
    fs::write(&file, "loaded bytes").unwrap();
    let (shell, mut visual) = open_file("overwrite.txt", &fixture, cx);
    edit(&mut visual, "retained draft");
    fs::write(&file, "first desktop revision").unwrap();
    visual.simulate_keystrokes("ctrl-s");
    for _ in 0..30 {
        visual.run_until_parked();
        draw(&mut visual);
        if visual.debug_bounds("file-overwrite").is_some() {
            break;
        }
    }
    let overwrite = visual
        .debug_bounds("file-overwrite")
        .expect("conflict action");
    fs::write(&file, "second desktop revision").unwrap();
    visual.simulate_click(overwrite.center(), gpui::Modifiers::default());
    wait_file(&shell, &mut visual, "overwrite.txt", false);
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "second desktop revision",
        "Overwrite must compare the revision shown by the conflict"
    );
    let overwrite = visual
        .debug_bounds("file-overwrite")
        .expect("refreshed conflict action");
    visual.simulate_click(overwrite.center(), gpui::Modifiers::default());
    wait_file(&shell, &mut visual, "overwrite.txt", false);
    assert_eq!(fs::read_to_string(file).unwrap(), "retained draft");
}

#[gpui::test]
fn file_boundary_secret_canary_never_reaches_editor_clipboard_or_logs(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let canary = ["fixture-private", "file-canary"].join("-");
    fs::write(
        workspace(&fixture).join("sensitive.txt"),
        format!("token = {canary}\nhttps://user:{canary}@example.invalid/path\n"),
    )
    .unwrap();
    let (_, mut visual) = open_file("sensitive.txt", &fixture, cx);
    assert!(
        visual.debug_bounds("file-editor").is_none(),
        "stored credentials must never enter a source editor"
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
        !fs::read_to_string(fixture.root.join("fixture.log"))
            .unwrap_or_default()
            .contains(&canary)
    );
}
#[gpui::test]
fn file_boundary_window_close_settings_and_focused_path_preserve_draft(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = workspace(&fixture).join("draft.txt");
    fs::write(&file, "original").unwrap();
    let (shell, mut visual) = open_file("draft.txt", &fixture, cx);
    edit(&mut visual, "retained draft");
    assert!(
        !visual.simulate_close(),
        "window close must retain an unsaved file draft"
    );
    visual.simulate_keystrokes("ctrl-,");
    draw(&mut visual);
    assert!(shell.read_with(&visual, |s, _| s.settings.is_some()));
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
    let input = visual.debug_bounds("file-path").unwrap();
    visual.simulate_click(input.center(), gpui::Modifiers::default());
    visual.simulate_keystrokes("ctrl-a");
    visual.simulate_input("other.txt");
    visual.simulate_keystrokes("enter");
    visual.run_until_parked();
    draw(&mut visual);
    assert!(shell.read_with(&visual, |s,cx| matches!(s.content.get(&s.key(&Tab::Files)), Some(Content::Files(v)) if v.read(cx).test_ready("draft.txt", false))), "dirty Open keeps the loaded file ID");
    visual.simulate_keystrokes("ctrl-s");
    visual.run_until_parked();
    draw(&mut visual);
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "original",
        "Save shortcut must respect the focused path field"
    );
    let save = visual.debug_bounds("file-save").unwrap();
    visual.simulate_click(save.center(), gpui::Modifiers::default());
    wait_file(&shell, &mut visual, "draft.txt", false);
    assert_eq!(fs::read_to_string(file).unwrap(), "retained draft");
}

#[gpui::test]
fn file_boundary_userinfo_url_and_credential_command_are_hidden(cx: &mut TestAppContext) {
    let canary = ["fixture-private", "credential-form"].join("-");
    for source in [
        format!("https://{canary}@example.invalid/path"),
        format!("curl --user user:{canary} https://example.invalid/path"),
    ] {
        let fixture = Fixture::new();
        fs::write(workspace(&fixture).join("credentials.txt"), source).unwrap();
        let (_, mut visual) = open_file("credentials.txt", &fixture, cx);
        assert!(
            visual.debug_bounds("file-editor").is_none(),
            "credential-bearing URLs and commands must stay outside the editor"
        );
    }
}

#[gpui::test]
fn file_boundary_missing_revision_refuses_editing_and_save(cx: &mut TestAppContext) {
    let fixture = Fixture::arguments(false, false, &["--files-missing-revision"]);
    let file = workspace(&fixture).join("unversioned.txt");
    fs::write(&file, "read bytes").unwrap();
    let (_, mut visual) = open_file("unversioned.txt", &fixture, cx);
    assert!(
        visual.debug_bounds("file-editor").is_none(),
        "missing read revision must fail closed before editing"
    );
    fs::write(&file, "desktop bytes").unwrap();
    visual.simulate_keystrokes("ctrl-s");
    visual.run_until_parked();
    assert_eq!(fs::read_to_string(file).unwrap(), "desktop bytes");
}

#[gpui::test]
fn file_boundary_code_references_remain_editable(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let source = "const token = getToken();\nconst apiKey = process.env.PROVIDER_KEY;\n";
    fs::write(workspace(&fixture).join("references.ts"), source).unwrap();
    let (_, mut visual) = open_file("references.ts", &fixture, cx);
    assert!(
        visual.debug_bounds("file-editor").is_some(),
        "credential variable references are ordinary source, not stored secrets"
    );
}
#[gpui::test]
fn file_boundary_database_credential_url_is_hidden(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let canary = ["fixture-private", "database-canary"].join("-");
    fs::write(
        workspace(&fixture).join("database.txt"),
        format!("postgres://user:{canary}@example.invalid/db"),
    )
    .unwrap();
    let (_, mut visual) = open_file("database.txt", &fixture, cx);
    assert!(
        visual.debug_bounds("file-editor").is_none(),
        "credential-bearing URLs are private across schemes"
    );
}

#[gpui::test]
fn file_boundary_namespaced_credentials_are_hidden(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let canary = ["fixture-private", "namespaced-canary"].join("-");
    fs::write(
        workspace(&fixture).join("environment.txt"),
        format!("CLOUD_ACCESS_TOKEN={canary}\n"),
    )
    .unwrap();
    let (_, mut visual) = open_file("environment.txt", &fixture, cx);
    assert!(
        visual.debug_bounds("file-editor").is_none(),
        "namespaced credential keys must stay private"
    );
}
