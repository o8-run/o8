//! Real header input and desktop project routes; no injected sidebar state.
use super::*;

fn project(fixture: &Fixture, name: &str, slug: &str, paths: &[String]) -> String {
    let created = fixture
        .client
        .project_request("POST", "/api/projects", &json!({"name":name,"slug":slug}))
        .unwrap();
    let id = created["project"]["id"].as_str().unwrap();
    for path in paths {
        let repo = fixture
            .client
            .project_request(
                "POST",
                "/api/panel/repos",
                &json!({"action":"add","localPath":path}),
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
    id.into()
}
fn activate(fixture: &Fixture, id: &str) {
    fixture
        .client
        .project_request(
            "POST",
            "/api/panel/projects/active",
            &json!({"projectId":id}),
        )
        .unwrap();
}
fn header_project(shell: &Entity<Shell>, cx: &VisualTestContext) -> Value {
    shell.read_with(cx, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .diagnostic()["project"]
            .clone()
    })
}
fn choose(cx: &mut VisualTestContext, id: &str) {
    click(
        cx,
        Box::leak(format!("sidebar-project-{id}").into_boxed_str()),
    );
}

#[gpui::test]
fn sidebar_chooser_never_clears_workspace_for_a_phantom_project(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --composer --sidebar");
    let first = project(&fixture, "Field Work", "field-work", &fixture.folders[..1]);
    let second = project(
        &fixture,
        "Second Project",
        "second-project",
        &fixture.folders[1..],
    );
    for (tab, path) in [
        ("thoughts-composer-first", &fixture.folders[0]),
        ("thoughts-composer-second", &fixture.folders[1]),
    ] {
        fixture
            .client
            .project_request(
                "PATCH",
                "/api/v2/chat-history",
                &json!({"tabId":tab,"repoPath":path}),
            )
            .unwrap();
    }
    activate(&fixture, &first);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("chooser.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    wait_for(&shell, &mut visual, |s, _| s.active().is_some());
    click(&mut visual, "sidebar-project-switcher");
    draw(&mut visual);
    let legacy = visual.debug_bounds("sidebar-project-default");
    if legacy.is_some() {
        // Reproduce the reported click before checking the chooser's contents.
        click(&mut visual, "sidebar-project-default");
        wait_for(&shell, &mut visual, |s, cx| {
            s.surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .read(cx)
                .diagnostic()["headerMenu"]
                .is_null()
        });
        let server: Value = fixture.client.get("/api/panel/projects", &[]).unwrap();
        assert_eq!(header_project(&shell, &visual), server["activeProjectId"]);
        assert_eq!(
            shell.read_with(&visual, |s, _| s.state.selected.clone()),
            Some(fixture.folders[0].clone()),
            "a chooser choice must not clear the workspace while the server keeps the named project"
        );
    }
    assert!(
        legacy.is_none(),
        "named projects must not offer the legacy Projects choice"
    );
    for (id, path) in [
        (&second, &fixture.folders[1]),
        (&first, &fixture.folders[0]),
    ] {
        choose(&mut visual, id);
        wait_for(&shell, &mut visual, |s, cx| {
            s.state.selected.as_ref() == Some(path)
                && s.surfaces
                    .sidebar
                    .view
                    .as_ref()
                    .unwrap()
                    .read(cx)
                    .diagnostic()["project"]
                    == id.as_str()
        });
        let server: Value = fixture.client.get("/api/panel/projects", &[]).unwrap();
        assert_eq!(server["activeProjectId"], id.as_str());
        assert_eq!(header_project(&shell, &visual), server["activeProjectId"]);
        assert!(shell.read_with(&visual, |s, _| s.active().is_some()));
        click(&mut visual, "sidebar-project-switcher");
    }
}

#[gpui::test]
fn sidebar_header_matches_desktop_identity_count_and_add_at_1440(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --composer");
    let mut paths = fixture.folders.clone();
    for name in ["o8-tools", "service-api"] {
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
    let id = project(&fixture, "Field Work", "field-work", &paths);
    fixture
        .client
        .project_request(
            "PATCH",
            &format!("/api/panel/projects/{id}"),
            &json!({"color":"#7fa68f"}),
        )
        .unwrap();
    let brand = project(&fixture, "o8 preview", "o8-preview", &[]);
    activate(&fixture, &brand);
    let state = State {
        bounds: [100., 100., 1440., 900.],
        ..State::default()
    };
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("header-look.json"),
        state,
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    click(&mut visual, "sidebar-project-switcher");
    choose(&mut visual, &id);
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .diagnostic()["project"]
            == id
    });
    draw(&mut visual);
    visual.update(|window, _| assert_eq!(window.bounds().size, size(px(1440.), px(900.))));
    let mark = visual
        .debug_bounds("sidebar-project-identity:FW:#7fa68f")
        .expect("project identity must match the desktop monogram and server color");
    let name = visual
        .debug_bounds("sidebar-project-name:Field Work")
        .expect("project name must be rendered from the desktop ledger");
    let count = visual
        .debug_bounds("sidebar-project-count:4")
        .expect("repository count must follow the project name");
    let chevron = visual
        .debug_bounds("sidebar-project-chevron")
        .expect("project chevron");
    let add = visual
        .debug_bounds("sidebar-project-add")
        .expect("Add repository control must follow the switcher");
    let host = visual.debug_bounds("sidebar-project-header").unwrap();
    assert_eq!(mark.size, size(px(17.), px(17.)));
    assert_eq!(mark.origin.x - host.origin.x, px(8.));
    assert_eq!(name.origin.x - host.origin.x, px(37.));
    assert!(
        mark.right() <= name.left()
            && name.right() <= count.left()
            && count.right() <= chevron.left()
            && chevron.right() <= add.left(),
        "header content must keep the desktop order"
    );
    assert_eq!(add.size, size(px(28.), px(28.)));
    assert_eq!(host.right() - add.right(), px(5.));
    let chip = visual.debug_bounds("sidebar-repo-0").unwrap();
    assert_eq!(chip.origin.x - host.origin.x, px(37.));
    assert!(chip.top() >= add.bottom());
    let repos: Value = fixture.client.get("/api/panel/repos", &[]).unwrap();
    let selected = shell.read_with(&visual, |s, _| s.state.selected.clone().unwrap());
    let repo = repos["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["localPath"] == selected)
        .unwrap();
    let repo_name = repo["name"].as_str().unwrap();
    let monogram: String = repo_name
        .split([' ', '_', '-'])
        .filter(|s| !s.is_empty())
        .take(2)
        .filter_map(|s| s.chars().next())
        .flat_map(char::to_uppercase)
        .collect();
    let chip_mark = visual
        .debug_bounds(Box::leak(
            format!("sidebar-repo-identity:{monogram}").into_boxed_str(),
        ))
        .expect("repository chips must show their desktop identities");
    assert_eq!(chip_mark.size, size(px(14.), px(14.)));
    assert!(chip.contains(&chip_mark.origin));
    click(&mut visual, "sidebar-project-switcher");
    choose(&mut visual, &brand);
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .diagnostic()["project"]
            == brand
    });
    draw(&mut visual);
    assert!(
        visual.debug_bounds("sidebar-project-identity:o8").is_some(),
        "o8 projects must use the same embedded identity asset as the desktop"
    );
}

#[gpui::test]
fn sidebar_add_takes_a_dropped_folder_like_projects_switcher(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --composer");
    let id = project(&fixture, "Field Work", "field-work", &fixture.folders[..1]);
    activate(&fixture, &id);
    let dropped = std::path::Path::new(&fixture.folders[0])
        .parent()
        .unwrap()
        .join("dropped-repo");
    fs::create_dir(&dropped).unwrap();
    assert!(
        Process::new("git")
            .args(["init", "--quiet"])
            .arg(&dropped)
            .status()
            .unwrap()
            .success()
    );
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("header-drop.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    draw(&mut visual);
    let position = visual.debug_bounds("sidebar-project-add").unwrap().center();
    let drop = |visual: &mut VisualTestContext, paths: Vec<std::path::PathBuf>| {
        visual.simulate_event(gpui::FileDropEvent::Entered {
            position,
            paths: gpui::ExternalPaths::new(paths),
        });
        draw(visual);
        visual.simulate_event(gpui::FileDropEvent::Submit { position });
        visual.run_until_parked();
        draw(visual);
    };
    // Two items are not one repository: nothing registers.
    drop(&mut visual, vec![dropped.clone(), dropped.join(".git")]);
    let canonical = fs::canonicalize(&dropped).unwrap();
    let registered = |fixture: &Fixture| {
        let repos: Value = fixture.client.get("/api/panel/repos", &[]).unwrap();
        repos["repos"].as_array().unwrap().iter().any(|r| {
            fs::canonicalize(r["localPath"].as_str().unwrap())
                .ok()
                .as_ref()
                == Some(&canonical)
        })
    };
    assert!(!registered(&fixture), "a multi-item drop must not register");
    drop(&mut visual, vec![dropped.clone()]);
    wait_for(&shell, &mut visual, |_, _| registered(&fixture));
    let projects: Value = fixture.client.get("/api/panel/projects", &[]).unwrap();
    let joined = projects["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id)
        .map(|p| p.to_string())
        .unwrap_or_default();
    assert!(
        joined.contains("dropped-repo"),
        "the dropped folder joins the active project: {joined}"
    );
}
