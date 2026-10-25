//! Review regressions through the real shell and the desktop's persisted routes.
use super::*;

fn seed_project(fixture: &Fixture, name: &str, slug: &str, folder: usize) -> (String, String) {
    let repo = fixture
        .client
        .project_request(
            "POST",
            "/api/panel/repos",
            &json!({
                "action":"add", "localPath":fixture.folders[folder],
            }),
        )
        .unwrap()["repo"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let project = fixture
        .client
        .project_request(
            "POST",
            "/api/projects",
            &json!({
                "name":name, "slug":slug, "repoIds":[repo], "mainRepoId":repo,
            }),
        )
        .unwrap()["project"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (project, repo)
}

#[gpui::test]
fn review_p1_rejects_duplicate_rename_before_deleting_alpha(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "");
    let (alpha, _) = seed_project(&fixture, "Review alpha", "review-alpha", 0);
    let (beta, beta_repo) = seed_project(&fixture, "Review beta", "review-beta", 1);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("duplicate.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    settle(cx);
    click(cx, "shell-projects");
    click(cx, "project-edit-review-alpha");
    fill(cx, "project-name", "  Review beta  ");
    click(cx, "project-save");
    assert_eq!(
        project(&fixture, &alpha)["name"],
        "Review alpha",
        "duplicate display names must be rejected before mutating Alpha"
    );
    shell.read_with(cx, |s, cx| {
        assert!(
            s.projects
                .as_ref()
                .unwrap()
                .read(cx)
                .error_message()
                .unwrap()
                .contains("already exists")
        )
    });
    click(cx, "project-cancel");
    click(cx, "project-delete-review-alpha");
    click(cx, "projects-confirm");
    assert!(!projects(&fixture).iter().any(|p| p["id"] == alpha));
    assert_eq!(project(&fixture, &beta)["name"], "Review beta");
    assert!(
        repos(&fixture).iter().any(|r| r["id"] == beta_repo),
        "Beta's exclusive repository must survive Alpha's deletion"
    );
}

#[gpui::test]
fn review_p1_deletes_existing_duplicate_by_stable_id(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "");
    let (alpha, alpha_repo) = seed_project(&fixture, "Review alpha", "review-alpha", 0);
    let (beta, beta_repo) = seed_project(&fixture, "Review beta", "review-beta", 1);
    // A desktop/API rename can predate this native snapshot. Distinct slugs
    // disambiguate the duplicate labels, but only the stable ID may select a mutation.
    fixture
        .client
        .project_request(
            "PATCH",
            &format!("/api/projects/{alpha}"),
            &json!({"name":"Review beta"}),
        )
        .unwrap();
    let (_, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("existing-duplicate.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    settle(cx);
    click(cx, "shell-projects");
    click(cx, "project-delete-review-beta-2");
    click(cx, "projects-confirm");
    assert!(
        projects(&fixture).iter().any(|p| p["id"] == beta),
        "deleting the renamed Alpha must never delete the original Beta"
    );
    assert!(
        repos(&fixture).iter().any(|r| r["id"] == beta_repo),
        "the original Beta's exclusive repository registration must survive"
    );
    assert!(
        !projects(&fixture).iter().any(|p| p["id"] == alpha),
        "the selected Alpha ID must be deleted"
    );
    let remaining = projects(&fixture);
    assert_eq!(
        remaining.len(),
        1,
        "Alpha must not be recreated under any ID"
    );
    assert_eq!(remaining[0]["id"], beta);
    assert!(remaining.iter().all(|p| {
        p["repos"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["repoId"] != alpha_repo)
    }));
    let registered = repos(&fixture);
    assert_eq!(
        registered.len(),
        1,
        "Alpha's exclusive repository must not survive under any ID"
    );
    assert_eq!(registered[0]["id"], beta_repo);
    assert!(registered.iter().all(
        |r| fs::canonicalize(r["localPath"].as_str().unwrap()).unwrap()
            != fs::canonicalize(&fixture.folders[0]).unwrap()
    ));
    let ledger: Value = fixture.client.get("/api/panel/projects", &[]).unwrap();
    assert!(ledger["projects"].as_array().unwrap().iter().all(|p| {
        p["repoPaths"]
            .as_array()
            .unwrap()
            .iter()
            .all(|path| path.as_str() != Some(&fixture.folders[0]))
    }));
}

fn repointed_open(cx: &mut TestAppContext, selector: &'static str) {
    let fixture = Fixture::start_mode(true, "");
    let (_, repo_id) = seed_project(&fixture, "Review alpha", "review-alpha", 0);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("repoint.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    settle(cx);
    click(cx, "shell-projects");
    // Change the production registry after the native controls captured their snapshot.
    fixture
        .client
        .project_request(
            "POST",
            "/api/panel/repos",
            &json!({
                "action":"update", "id":repo_id, "localPath":fixture.folders[1],
            }),
        )
        .unwrap();
    assert_eq!(
        fs::canonicalize(repos(&fixture)[0]["localPath"].as_str().unwrap()).unwrap(),
        fs::canonicalize(&fixture.folders[1]).unwrap()
    );
    click(cx, selector);
    assert_eq!(
        fs::canonicalize(shell.read_with(cx, |s, _| s.state.selected.clone().unwrap())).unwrap(),
        fs::canonicalize(&fixture.folders[1]).unwrap(),
        "Open must resolve the repository ID against fresh inventory, never the captured old checkout"
    );
    shell.read_with(cx, |s, _| {
        assert!(
            !s.workspaces
                .iter()
                .any(|p| fs::canonicalize(p).ok() == fs::canonicalize(&fixture.folders[0]).ok()),
            "the repointed checkout must leave the workspace picker"
        )
    });
}

#[gpui::test]
fn review_p2_project_open_resolves_repointed_repository(cx: &mut TestAppContext) {
    repointed_open(cx, "project-open-review-alpha");
}

#[gpui::test]
fn review_p2_repository_open_resolves_repointed_repository(cx: &mut TestAppContext) {
    repointed_open(cx, "repo-open-0");
}

#[gpui::test]
fn round2_project_delete_refuses_unconfirmed_runtime(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--projects-refuse-remove");
    let (alpha, alpha_repo) = seed_project(&fixture, "Review alpha", "review-alpha", 0);
    let (beta, beta_repo) = seed_project(&fixture, "Review beta", "review-beta", 1);
    let direct = fixture
        .client
        .project_request("DELETE", "/api/panel/repos", &json!({"id":alpha_repo}))
        .unwrap_err();
    assert!(direct.contains("repo_runtime_stop_unconfirmed (HTTP 409)"));
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("delete-runtime.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    settle(cx);
    click(cx, "shell-projects");
    click(cx, "project-delete-review-alpha");
    click(cx, "projects-confirm");
    assert!(
        projects(&fixture).iter().any(|p| p["id"] == alpha),
        "unconfirmed live runtime must retain the project before any destructive write"
    );
    assert_eq!(project(&fixture, &alpha)["repos"][0]["repoId"], alpha_repo);
    assert!(repos(&fixture).iter().any(|r| r["id"] == alpha_repo));
    assert_eq!(project(&fixture, &beta)["repos"][0]["repoId"], beta_repo);
    shell.read_with(cx, |s, cx| {
        assert!(
            s.projects
                .as_ref()
                .unwrap()
                .read(cx)
                .error_message()
                .unwrap()
                .contains("repo_runtime_stop_unconfirmed (HTTP 409)")
        )
    });
}

fn legacy_shell(cx: &mut TestAppContext) -> (Fixture, Entity<Shell>, VisualTestContext, String) {
    let fixture = Fixture::start_mode(true, "--projects-legacy");
    let id = projects(&fixture)
        .into_iter()
        .find(|p| p["slug"] == "legacy-alpha")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(id, "legacy-alpha-id");
    let ledger: Value = fixture.client.get("/api/panel/projects", &[]).unwrap();
    assert!(
        ledger["projects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == "legacy-alpha-id")
    );
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("legacy.json"),
        State::default(),
        cx,
    );
    settle(&mut visual);
    click(&mut visual, "shell-projects");
    (fixture, shell, visual, id)
}

#[gpui::test]
fn round2_legacy_rename_updates_both_stable_ids(cx: &mut TestAppContext) {
    let (fixture, _, mut visual, id) = legacy_shell(cx);
    let cx = &mut visual;
    click(cx, "project-edit-legacy-alpha");
    fill(cx, "project-name", "Legacy renamed");
    click(cx, "project-save");
    assert_eq!(
        project(&fixture, &id)["name"],
        "Legacy renamed",
        "rename success must update the existing SQLite identity"
    );
    let ledger: Value = fixture.client.get("/api/panel/projects", &[]).unwrap();
    assert_eq!(
        ledger["projects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "legacy-alpha-id")
            .unwrap()["name"],
        "Legacy renamed"
    );
    assert_eq!(
        projects(&fixture).len(),
        2,
        "renaming a legacy pair must not create a second project"
    );
}

fn legacy_selection(cx: &mut TestAppContext, selector: &'static str) {
    let (fixture, shell, mut visual, _) = legacy_shell(cx);
    click(&mut visual, selector);
    shell.read_with(&visual, |s, cx| {
        assert!(
            s.projects
                .as_ref()
                .unwrap()
                .read(cx)
                .error_message()
                .is_none()
        );
    });
    let selected = shell.read_with(&visual, |s, _| s.state.selected.clone());
    assert!(
        selected.is_some(),
        "legacy SQLite IDs must resolve before Open or Switch"
    );
    assert_eq!(
        fs::canonicalize(selected.unwrap()).unwrap(),
        fs::canonicalize(&fixture.folders[0]).unwrap()
    );
    let ledger: Value = fixture.client.get("/api/panel/projects", &[]).unwrap();
    assert_eq!(ledger["activeProjectId"], "legacy-alpha-id");
}

#[gpui::test]
fn round2_legacy_open_resolves_id_pair(cx: &mut TestAppContext) {
    legacy_selection(cx, "project-open-legacy-alpha");
}

#[gpui::test]
fn round2_legacy_switch_resolves_id_pair(cx: &mut TestAppContext) {
    legacy_selection(cx, "project-activate-legacy-alpha");
}

#[gpui::test]
fn round2_legacy_desktop_rename_before_native_read_keeps_one_pair(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--projects-legacy");
    let id = projects(&fixture)
        .into_iter()
        .find(|p| p["slug"] == "legacy-alpha")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    fixture
        .client
        .project_request(
            "PATCH",
            &format!("/api/projects/{id}"),
            &json!({"name":"Legacy moved"}),
        )
        .unwrap();
    let (_, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("legacy-desktop-rename.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    settle(cx);
    click(cx, "shell-projects");
    assert_eq!(
        projects(&fixture).len(),
        2,
        "a desktop rename before the first native read must not recreate the legacy project"
    );
    click(cx, "project-delete-legacy-moved");
    click(cx, "projects-confirm");
    let remaining = projects(&fixture);
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0]["name"], "Legacy beta");
    assert!(repos(&fixture).is_empty());
}
