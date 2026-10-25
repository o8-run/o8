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
    let fixture = Fixture::start(true);
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
    let fixture = Fixture::start(true);
    let (alpha, _) = seed_project(&fixture, "Review alpha", "review-alpha", 0);
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
}

fn repointed_open(cx: &mut TestAppContext, selector: &'static str) {
    let fixture = Fixture::start(true);
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
