//! Native input -> real production routes, including proof of zero archive requests.
use super::*;

fn selected_chat(cx: &mut TestAppContext) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let fixture = Fixture::start_mode(
        true,
        "--shell --composer --sidebar --sidebar-keyboard-audit",
    );
    let project = fixture
        .client
        .project_request(
            "POST",
            "/api/projects",
            &json!({"name":"Keyboard fixture", "slug":"keyboard-fixture"}),
        )
        .unwrap();
    let project_id = project["project"]["id"].as_str().unwrap();
    let mut paths = fixture.folders.clone();
    for name in ["keyboard-third", "keyboard-fourth"] {
        let path = std::path::Path::new(&paths[0]).parent().unwrap().join(name);
        fs::create_dir(&path).unwrap();
        assert!(
            Process::new("git")
                .args(["init", "--quiet"])
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        paths.push(path.to_string_lossy().into_owned());
    }
    for path in paths {
        let repo = fixture
            .client
            .project_request(
                "POST",
                "/api/panel/repos",
                &json!({"action":"add", "localPath":path}),
            )
            .unwrap();
        fixture
            .client
            .project_request(
                "POST",
                &format!("/api/projects/{project_id}/repos"),
                &json!({"repoId":repo["repo"]["id"]}),
            )
            .unwrap();
    }
    fixture
        .client
        .project_request(
            "POST",
            "/api/panel/projects/active",
            &json!({"projectId":project_id}),
        )
        .unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("menu-keys.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    visual.simulate_keystrokes("ctrl-f");
    visual.simulate_input("thoughts-composer-first");
    settle(&shell, &mut visual);
    let index = shell.read_with(&visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .rows
            .iter()
            .position(|r| r.id.as_deref() == Some("thoughts-composer-first"))
            .unwrap()
    });
    click(
        &mut visual,
        Box::leak(format!("thread-row-{index}").into_boxed_str()),
    );
    wait_for(&shell, &mut visual, |s, cx| {
        s.active()
            .and_then(|t| s.content.get(&s.key(&t)))
            .is_some_and(|c| c.ready(cx))
    });
    assert_eq!(active_id(&shell, &mut visual), "thoughts-composer-first");
    (fixture, shell, visual)
}
fn archives(fixture: &Fixture) -> Vec<Value> {
    let audit: Value = fixture
        .client
        .get("/api/sidebar-fixture/archives", &[])
        .unwrap();
    audit["archives"].as_array().unwrap().clone()
}
fn record(fixture: &Fixture) -> Value {
    fixture
        .client
        .get(
            "/api/v2/chat-history",
            &[("tabId", "thoughts-composer-first")],
        )
        .unwrap()
}
fn idle(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    wait_for(shell, cx, |s, cx| {
        let sidebar = s
            .surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .diagnostic();
        sidebar["saving"] == false && sidebar["loading"] == false
    });
}

#[gpui::test]
fn sidebar_project_chooser_delete_sends_no_archive_request(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual) = selected_chat(cx);
    assert!(archives(&fixture).is_empty());
    click(&mut visual, "sidebar-project-switcher");
    assert!(visual.debug_bounds("sidebar-header-menu").is_some());
    visual.simulate_keystrokes("delete");
    idle(&shell, &mut visual);
    assert_eq!(
        archives(&fixture).len(),
        0,
        "Delete in the project chooser must send no archive request"
    );
    assert!(
        record(&fixture)["archivedAt"].is_null(),
        "the selected saved chat must remain live"
    );
    assert_eq!(active_id(&shell, &mut visual), "thoughts-composer-first");
}

#[gpui::test]
fn sidebar_header_menus_own_row_shortcuts_and_escape_preserves_rows(cx: &mut TestAppContext) {
    for trigger in ["sidebar-project-switcher", "sidebar-repo-overflow"] {
        let (fixture, shell, mut visual) = selected_chat(cx);
        let before = shell.read_with(&visual, |s, cx| {
            s.surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .read(cx)
                .diagnostic()["choice"]
                .clone()
        });
        click(&mut visual, trigger);
        for key in [
            "backspace",
            "f2",
            "enter",
            "up",
            "down",
            "home",
            "end",
            "ctrl-f",
            "f8",
            "delete",
        ] {
            visual.simulate_keystrokes(key);
            idle(&shell, &mut visual);
            assert!(archives(&fixture).is_empty(), "{trigger} must own {key}");
            shell.read_with(&visual, |s, cx| {
                let state = s
                    .surfaces
                    .sidebar
                    .view
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .diagnostic();
                assert!(!state["headerMenu"].is_null(), "menu must still own input");
                assert_eq!(
                    state["choice"], before,
                    "menu keys must not change the row choice"
                );
                assert_eq!(
                    state["editing"], false,
                    "menu keys must not start row editing"
                );
                assert!(state["rename"].is_null());
            });
            assert!(
                visual.debug_bounds("sidebar-header-menu").is_some(),
                "{key} must stay inside {trigger}"
            );
        }
        visual.simulate_keystrokes("escape");
        draw(&mut visual);
        shell.read_with(&visual, |s, cx| {
            assert!(
                s.surfaces
                    .sidebar
                    .view
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .diagnostic()["headerMenu"]
                    .is_null()
            )
        });
        shell.read_with(&visual, |s, cx| {
            assert_eq!(
                s.surfaces
                    .sidebar
                    .view
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .rows
                    .len(),
                3,
                "closing a menu must preserve the search"
            )
        });
        // Positive control: the same real row shortcut works once the menu closes.
        visual.simulate_keystrokes("delete");
        idle(&shell, &mut visual);
        assert_eq!(archives(&fixture).len(), 1);
        assert!(record(&fixture)["archivedAt"].is_string());
    }
}
