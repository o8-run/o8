use super::*;

#[gpui::test]
fn maintenance_keeps_a_workspace_outside_the_active_project(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --composer");
    let mut projects = Vec::new();
    let mut repos = Vec::new();
    for (index, name) in ["Active", "Other"].into_iter().enumerate() {
        fixture
            .client
            .project_request(
                "POST",
                "/api/projects",
                &json!({"name":name,"slug":name.to_lowercase()}),
            )
            .unwrap();
        let ledger: Value = fixture.client.get("/api/projects", &[]).unwrap();
        let project = ledger["projects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == name)
            .unwrap()["id"]
            .clone();
        let repo = fixture
            .client
            .project_request(
                "POST",
                "/api/panel/repos",
                &json!({"action":"add","localPath":fixture.folders[index]}),
            )
            .unwrap();
        fixture
            .client
            .project_request(
                "POST",
                &format!("/api/projects/{}/repos", project.as_str().unwrap()),
                &json!({"repoId":repo["repo"]["id"]}),
            )
            .unwrap();
        projects.push(project);
        repos.push(repo["repo"]["id"].clone());
    }
    fixture
        .client
        .project_request(
            "POST",
            "/api/panel/projects/active",
            &json!({"projectId":projects[0]}),
        )
        .unwrap();
    let file = fixture.root.join("maintenance.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    let cx = &mut visual;
    settled(&shell, cx);
    let active = fs::canonicalize(&fixture.folders[0])
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let other = fs::canonicalize(&fixture.folders[1])
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        shell.read_with(cx, |s, _| s.state.selected.clone()),
        Some(active.clone())
    );
    shell.update_in(cx, |s, window, cx| s.switch(other.clone(), window, cx));
    assert_eq!(
        shell.read_with(cx, |s, _| s.state.selected.clone()),
        Some(other.clone())
    );
    shell.update_in(cx, |s, window, cx| s.tick(true, window, cx));
    settled(&shell, cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s.state.selected.clone()),
        Some(other.clone()),
        "maintenance must preserve a valid workspace outside the server-active project"
    );
    assert_eq!(State::load(&file).unwrap().selected, Some(other.clone()));
    let ledger: Value = fixture.client.get("/api/panel/projects", &[]).unwrap();
    assert_eq!(ledger["activeProjectId"], projects[0]);

    // A removed workspace is a real bootstrap condition even on a healthy
    // connection. The server-active project is then the fallback again.
    fixture
        .client
        .project_request("DELETE", "/api/panel/repos", &json!({"id":repos[1]}))
        .unwrap();
    shell.update_in(cx, |s, window, cx| s.tick(true, window, cx));
    settled(&shell, cx);
    assert!(!shell.read_with(cx, |s, _| s.workspaces.contains(&other)));
    assert_eq!(
        shell.read_with(cx, |s, _| s.state.selected.clone()),
        Some(active.clone())
    );
    assert_eq!(State::load(&file).unwrap().selected, Some(active));
}
