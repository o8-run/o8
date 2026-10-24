//! Drive the actual shell, GPUI pointer/text events, middleware and persisted project routes.
use super::*;
use crate::shell::test_support::*;

#[path = "projects_review_tests.rs"]
mod review;

fn settle(cx: &mut VisualTestContext) {
    for _ in 0..6 {
        cx.run_until_parked();
        draw(cx);
    }
}
fn click(cx: &mut VisualTestContext, selector: &'static str) {
    draw(cx);
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("missing native control: {selector}"));
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    settle(cx);
}
fn measured_click(
    shell: &Entity<Shell>,
    cx: &mut VisualTestContext,
    selector: &'static str,
) -> f64 {
    draw(cx);
    let bounds = cx.debug_bounds(selector).expect("measured control");
    let start = Instant::now();
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    for _ in 0..20 {
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
        if shell.read_with(cx, |s, cx| {
            let projects = s.surfaces.projects.view.as_ref().unwrap().read(cx);
            !projects.pending()
                && if s.surfaces.projects.open {
                    projects.frame_ready()
                } else {
                    s.painted.get() == s.revision
                }
        }) {
            return start.elapsed().as_secs_f64() * 1000.;
        }
    }
    panic!("completed interaction must acknowledge its first CPU scene paint");
}
fn fill(cx: &mut VisualTestContext, selector: &'static str, text: &str) {
    click(cx, selector);
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-a backspace"
    } else {
        "ctrl-a backspace"
    });
    cx.simulate_input(text);
    settle(cx);
}
fn projects(fixture: &Fixture) -> Vec<Value> {
    fixture.client.get::<Value>("/api/projects", &[]).unwrap()["projects"]
        .as_array()
        .unwrap()
        .clone()
}
fn repos(fixture: &Fixture) -> Vec<Value> {
    fixture
        .client
        .get::<Value>("/api/panel/repos", &[])
        .unwrap()["repos"]
        .as_array()
        .unwrap()
        .clone()
}

fn project(fixture: &Fixture, id: &str) -> Value {
    projects(fixture)
        .into_iter()
        .find(|p| p["id"] == id)
        .expect("saved project identity")
}

#[gpui::test]
fn projects_first_run_crud_membership_and_focus(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("projects.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    settle(cx);
    assert!(
        shell.read_with(cx, |s, _| s.workspaces.is_empty()
            && s.state.selected.is_none()),
        "first run has neither registered repositories nor saved sessions"
    );
    let open_ms = measured_click(&shell, cx, "shell-projects");
    assert!(cx.debug_bounds("projects-empty").is_some());
    assert!(cx.debug_bounds("repositories-empty").is_some());
    click(cx, "project-new");
    fill(cx, "project-name", "Fixture alpha");
    fill(cx, "project-slug", "fixture-alpha");
    fill(cx, "project-description", "Shared fixture instructions");
    click(cx, "project-save");
    assert!(
        projects(&fixture)
            .iter()
            .any(|p| p["name"] == "Fixture alpha")
    );

    let alpha_id = projects(&fixture)
        .into_iter()
        .find(|p| p["name"] == "Fixture alpha")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    click(cx, "repo-add");
    fill(cx, "repo-path", &format!("{}/missing", fixture.folders[0]));
    click(cx, "repo-validate");
    assert!(cx.debug_bounds("projects-error").is_some());
    assert!(repos(&fixture).is_empty());
    fill(cx, "repo-path", &fixture.folders[0]);
    click(cx, "repo-validate");
    assert!(cx.debug_bounds("repo-validation").is_some());
    click(cx, "repo-register");
    assert_eq!(repos(&fixture).len(), 1);
    let canonical = fs::canonicalize(&fixture.folders[0]).unwrap();
    assert_eq!(
        fs::canonicalize(repos(&fixture)[0]["localPath"].as_str().unwrap()).unwrap(),
        canonical
    );
    click(cx, "project-details-fixture-alpha");
    if !project(&fixture, &alpha_id)["repos"]
        .as_array()
        .unwrap()
        .is_empty()
    {
        click(cx, "project-unlink-0");
    }
    click(cx, "project-link-0");
    assert_eq!(
        project(&fixture, &alpha_id)["repos"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    click(cx, "project-main-0");
    assert_eq!(
        project(&fixture, &alpha_id)["mainRepoId"],
        repos(&fixture)[0]["id"]
    );
    click(cx, "project-role-0");
    assert_eq!(project(&fixture, &alpha_id)["repos"][0]["role"], "frontend");
    click(cx, "project-unlink-0");
    assert!(
        project(&fixture, &alpha_id)["repos"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    click(cx, "project-link-0");
    click(cx, "projects-all");
    click(cx, "project-edit-fixture-alpha");
    fill(cx, "project-name", "Fixture renamed");
    fill(cx, "project-description", "Updated description");
    click(cx, "project-save");
    assert_eq!(project(&fixture, &alpha_id)["name"], "Fixture renamed");
    assert_eq!(
        project(&fixture, &alpha_id)["description"],
        "Updated description"
    );
    fill(cx, "projects-search", "no match");
    assert!(cx.debug_bounds("projects-no-match").is_some());
    fill(cx, "projects-search", "");
    let switch_ms = measured_click(&shell, cx, "project-open-fixture-renamed");
    let ledger: Value = fixture.client.get("/api/panel/projects", &[]).unwrap();
    assert_eq!(
        ledger["projects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == ledger["activeProjectId"])
            .unwrap()["name"],
        "Fixture renamed"
    );
    assert_eq!(
        fs::canonicalize(shell.read_with(cx, |s, _| s.state.selected.clone().unwrap())).unwrap(),
        canonical
    );
    click(cx, "shell-projects");
    click(cx, "repo-remove-0");
    click(cx, "projects-cancel-confirm");
    assert_eq!(repos(&fixture).len(), 1);
    click(cx, "repo-remove-0");
    click(cx, "projects-confirm");
    assert!(repos(&fixture).is_empty());
    assert!(
        std::path::Path::new(&fixture.folders[0]).exists(),
        "removal keeps the folder"
    );
    click(cx, "project-delete-fixture-renamed");
    click(cx, "projects-confirm");
    assert!(
        !projects(&fixture)
            .iter()
            .any(|p| p["name"] == "Fixture renamed")
    );
    println!(
        "O8_NEXT_PROJECTS_EVIDENCE {}",
        json!({"endpoint":"first completed GPUI TestAppContext CPU scene paint; debug build; test text system; no GPU/compositor", "openToFirstFrameMs":open_ms, "workspaceOpenToFrameMs":switch_ms, "registeredReposAfterRemove":0})
    );
}

#[gpui::test]
fn projects_auth_refusal_and_retry(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "");
    let client = Client::authenticated(&fixture.origin, Some("fixture-invalid".into())).unwrap();
    let (shell, mut visual) = open(
        client,
        fixture.root.join("denied.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    settle(cx);
    click(cx, "shell-projects");
    assert!(cx.debug_bounds("projects-error").is_some());
    click(cx, "projects-refresh");
    assert!(cx.debug_bounds("projects-error").is_some());
    click(cx, "project-new");
    fill(cx, "project-name", "Refused project");
    click(cx, "project-save");
    shell.read_with(cx, |s, cx| {
        assert!(
            s.surfaces
                .projects
                .view
                .as_ref()
                .unwrap()
                .read(cx)
                .error_message()
                .unwrap()
                .contains("HTTP 401")
        )
    });
    assert!(
        !projects(&fixture)
            .iter()
            .any(|p| p["name"] == "Refused project")
    );
    assert!(repos(&fixture).is_empty());
}

#[gpui::test]
fn projects_switch_active_without_saved_sessions(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "");
    fixture
        .client
        .project_request(
            "POST",
            "/api/projects",
            &json!({"name":"Empty alpha","slug":"empty-alpha"}),
        )
        .unwrap();
    fixture
        .client
        .project_request(
            "POST",
            "/api/projects",
            &json!({"name":"Empty beta","slug":"empty-beta"}),
        )
        .unwrap();
    let alpha = projects(&fixture)
        .into_iter()
        .find(|p| p["slug"] == "empty-alpha")
        .unwrap();
    let registered = fixture
        .client
        .project_request(
            "POST",
            "/api/panel/repos",
            &json!({"action":"add","localPath":fixture.folders[0]}),
        )
        .unwrap();
    fixture
        .client
        .project_request(
            "POST",
            &format!("/api/projects/{}/repos", alpha["id"].as_str().unwrap()),
            &json!({"repoId":registered["repo"]["id"]}),
        )
        .unwrap();
    fixture
        .client
        .project_request(
            "POST",
            "/api/panel/projects/active",
            &json!({"projectId":alpha["id"]}),
        )
        .unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("active.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    settle(cx);
    click(cx, "shell-projects");
    let mut interaction_ms = vec![];
    for i in 0..20 {
        let slug = if i % 2 == 0 {
            "empty-beta"
        } else {
            "empty-alpha"
        };
        interaction_ms.push(measured_click(
            &shell,
            cx,
            if slug == "empty-beta" {
                "project-activate-empty-beta"
            } else {
                "project-activate-empty-alpha"
            },
        ));
        let selected = projects(&fixture)
            .into_iter()
            .find(|p| p["slug"] == slug)
            .unwrap();
        let ledger: Value = fixture.client.get("/api/panel/projects", &[]).unwrap();
        assert_eq!(ledger["activeProjectId"], selected["id"]);
        if slug == "empty-beta" {
            assert!(
                shell.read_with(cx, |s, _| s.state.selected.is_none()),
                "switching to an empty project must clear the previous repository context"
            );
        } else {
            assert_eq!(
                fs::canonicalize(shell.read_with(cx, |s, _| s.state.selected.clone().unwrap()))
                    .unwrap(),
                fs::canonicalize(&fixture.folders[0]).unwrap()
            );
        }
    }
    println!(
        "O8_NEXT_PROJECTS_SWITCH_EVIDENCE {}",
        json!({"endpoint":"first completed GPUI TestAppContext CPU scene paint; debug build; test text system; no GPU/compositor", "interactionToFrameMs":interaction_ms})
    );
    click(cx, "project-activate-empty-beta");
    let saved = State::load(&fixture.root.join("active.json")).unwrap();
    let (restarted, mut restart_visual) = open(
        fixture.client.clone(),
        fixture.root.join("active.json"),
        saved,
        &mut cx.cx,
    );
    settle(&mut restart_visual);
    assert!(
        restarted.read_with(&restart_visual, |s, _| s.state.selected.is_none()),
        "restart must honor the active empty project instead of selecting an unrelated saved session"
    );
}

#[gpui::test]
fn projects_palette_loading_and_cancel(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("palette.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    settle(cx);
    cx.simulate_keystrokes("ctrl-k p r o j e c t s");
    cx.update(|window, cx| {
        window.dispatch_keystroke(gpui::Keystroke::parse("enter").unwrap(), cx);
    });
    draw(cx);
    assert!(
        shell.read_with(cx, |s, _| s.surfaces.projects.open),
        "Projects must be reachable from the shell palette on first run"
    );
    assert!(cx.debug_bounds("projects-loading").is_some());
    settle(cx);
    click(cx, "project-new");
    click(cx, "project-save");
    assert!(cx.debug_bounds("projects-error").is_some());
    click(cx, "project-cancel");
    click(cx, "repo-add");
    click(cx, "repo-cancel");
    click(cx, "shell-workspace");
    assert!(!shell.read_with(cx, |s, _| s.surfaces.projects.open));
}

#[gpui::test]
fn projects_reconnect_and_runtime_removal_refusal(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--projects-refuse-remove");
    fixture
        .client
        .project_request(
            "POST",
            "/api/panel/repos",
            &json!({"action":"add","localPath":fixture.folders[0]}),
        )
        .unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("refusal.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    settle(cx);
    click(cx, "shell-projects");
    click(cx, "repo-add");
    fill(cx, "repo-path", &fixture.folders[0]);
    click(cx, "repo-register");
    assert_eq!(
        repos(&fixture).len(),
        1,
        "reconnecting a registered canonical path must reuse its entry"
    );
    click(cx, "repo-remove-0");
    click(cx, "projects-confirm");
    assert!(cx.debug_bounds("projects-error").is_some());
    shell.read_with(cx, |s, cx| {
        assert!(
            s.surfaces
                .projects
                .view
                .as_ref()
                .unwrap()
                .read(cx)
                .error_message()
                .unwrap()
                .contains("repo_runtime_stop_unconfirmed (HTTP 409)")
        )
    });
    assert_eq!(
        repos(&fixture).len(),
        1,
        "unconfirmed runtime stop must retain registration"
    );
    click(cx, "projects-cancel-confirm");
}

#[gpui::test]
fn projects_lost_registration_response_preserves_membership_role(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--projects-drop-add");
    fixture
        .client
        .project_request(
            "POST",
            "/api/projects",
            &json!({"name":"Recovery project","slug":"recovery-project"}),
        )
        .unwrap();
    let (_, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("recovery.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    settle(cx);
    click(cx, "shell-projects");
    click(cx, "project-details-recovery-project");
    click(cx, "repo-add");
    fill(cx, "repo-path", &fixture.folders[0]);
    click(cx, "repo-register");
    assert_eq!(
        repos(&fixture).len(),
        1,
        "lost add response must reconcile the durable registration"
    );
    let repo_id = repos(&fixture)[0]["id"].clone();
    click(cx, "project-role-0");
    click(cx, "repo-add");
    fill(cx, "repo-path", &fixture.folders[0]);
    click(cx, "repo-register");
    assert_eq!(repos(&fixture).len(), 1);
    assert_eq!(repos(&fixture)[0]["id"], repo_id);
    let recovery = projects(&fixture)
        .into_iter()
        .find(|p| p["slug"] == "recovery-project")
        .unwrap();
    assert_eq!(recovery["repos"].as_array().unwrap().len(), 1);
    assert_eq!(
        recovery["repos"][0]["role"], "frontend",
        "reconnecting must preserve the existing project role"
    );
}

#[gpui::test]
fn projects_preserve_session_focus_and_allow_inbox_navigation(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --inbox --composer");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("navigation.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    cx.simulate_keystrokes("ctrl-k n e w enter");
    settle(cx);
    assert!(shell.read_with(cx, |s, _| s.current().unwrap().composer));
    click(cx, "shell-projects");
    shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
    assert!(
        shell.read_with(cx, |s, _| s.current().unwrap().composer),
        "Projects must retain the hidden session's saved composer focus"
    );
    cx.simulate_keystrokes("ctrl-k i n b o x enter");
    settle(cx);
    assert!(
        !shell.read_with(cx, |s, _| s.surfaces.projects.open),
        "opening Inbox must leave Projects"
    );
    assert_eq!(shell.read_with(cx, |s, _| s.active()), Some(Tab::Inbox));
    assert!(cx.debug_bounds("inbox-view-replies").is_some());
    cx.simulate_keystrokes("ctrl-k p r o j e c t s enter");
    settle(cx);
    assert!(shell.read_with(cx, |s, _| s.surfaces.projects.open));
    cx.simulate_keystrokes("ctrl-tab");
    settle(cx);
    assert!(
        !shell.read_with(cx, |s, _| s.surfaces.projects.open),
        "cycling shell surfaces must leave Projects"
    );
}
