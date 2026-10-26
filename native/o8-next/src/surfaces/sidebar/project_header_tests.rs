//! Shell input -> project selection -> the desktop's persisted project ledger.
use super::*;
use crate::shell_state::State;

#[gpui::test]
fn sidebar_project_header_switches_repos_and_projects(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --composer");
    let project = fixture
        .client
        .project_request(
            "POST",
            "/api/projects",
            &json!({"name":"Sidebar project", "slug":"sidebar-project"}),
        )
        .unwrap();
    let id = project["project"]["id"].as_str().unwrap();
    let mut paths = fixture.folders.clone();
    for name in ["third", "fourth"] {
        let path = std::path::Path::new(&fixture.folders[0])
            .parent()
            .unwrap()
            .join(name);
        fs::create_dir(&path).unwrap();
        Process::new("git")
            .args(["init", "--quiet"])
            .arg(&path)
            .status()
            .unwrap();
        paths.push(path.to_string_lossy().into_owned());
    }
    for path in &paths {
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
                &format!("/api/projects/{id}/repos"),
                &json!({"repoId":repo["repo"]["id"]}),
            )
            .unwrap();
    }
    let second = fixture
        .client
        .project_request(
            "POST",
            "/api/projects",
            &json!({"name":"Second project", "slug":"second-project"}),
        )
        .unwrap();
    let second_id = second["project"]["id"].as_str().unwrap();
    fixture
        .client
        .project_request(
            "POST",
            "/api/panel/projects/active",
            &json!({"projectId":id}),
        )
        .unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("header.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    draw(&mut visual);
    assert!(
        visual.debug_bounds("sidebar-project-switcher").is_some(),
        "project name and switcher must be painted above Recents"
    );
    assert!(
        visual.debug_bounds("sidebar-repo-overflow").is_some(),
        "four repos must expose a +N overflow"
    );
    click(&mut visual, "sidebar-repo-overflow");
    draw(&mut visual);
    click(&mut visual, "sidebar-repo-3");
    wait_for(&shell, &mut visual, |s, _| {
        s.state.selected.as_ref() == Some(&paths[3])
    });
    let ledger: Value = fixture.client.get("/api/panel/projects", &[]).unwrap();
    assert_eq!(ledger["activeProjectId"], id);
    click(&mut visual, "sidebar-project-switcher");
    draw(&mut visual);
    click(
        &mut visual,
        Box::leak(format!("sidebar-project-{second_id}").into_boxed_str()),
    );
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .diagnostic()["project"]
            == second_id
    });
    let ledger: Value = fixture.client.get("/api/panel/projects", &[]).unwrap();
    assert_eq!(ledger["activeProjectId"], second_id);
}
