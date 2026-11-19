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
    // The project's four repositories head the switcher's menu.
    click(&mut visual, "sidebar-project-switcher");
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

#[gpui::test]
fn sidebar_project_menu_closes_on_a_press_outside(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --composer");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("project-outside.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    let cx = &mut visual;
    let press = |cx: &mut VisualTestContext, at: gpui::Point<gpui::Pixels>| {
        cx.simulate_click(at, gpui::Modifiers::default());
        cx.run_until_parked();
        draw(cx);
    };
    let switcher = cx
        .debug_bounds("sidebar-project-switcher")
        .unwrap()
        .center();
    press(cx, switcher);
    assert!(cx.debug_bounds("sidebar-header-menu").is_some(), "opens");
    press(cx, switcher);
    assert!(
        cx.debug_bounds("sidebar-header-menu").is_none(),
        "the switcher still toggles it closed"
    );
    press(cx, switcher);
    assert!(cx.debug_bounds("sidebar-header-menu").is_some());
    let header = cx.debug_bounds("sidebar-project-header").unwrap();
    // A press in the main pane, well right of the sidebar.
    press(
        cx,
        gpui::point(header.right() + px(300.), header.bottom() + px(200.)),
    );
    assert!(
        cx.debug_bounds("sidebar-header-menu").is_none(),
        "a press outside closes it"
    );
}

#[gpui::test]
fn sidebar_project_row_keeps_its_measured_height(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --composer");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("project-level.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    let cx = &mut visual;
    let header = cx
        .debug_bounds("sidebar-project-header")
        .expect("project header");
    // The 32px switcher sits 13px down the header. Measured in the desktop
    // DOM: Switch project 69. The home mark it lined up with left with the rail.
    let row = f32::from(header.origin.y) + 13. + 16.;
    assert_eq!(row, 69.);
}

#[gpui::test]
fn sidebar_project_menu_opens_the_project_in_the_editor(cx: &mut TestAppContext) {
    let (_code, log) = crate::editor_command::fake_code::install();
    let fixture = Fixture::start_mode(true, "--shell --composer");
    let project = fixture
        .client
        .project_request(
            "POST",
            "/api/projects",
            &json!({"name":"Editor project", "slug":"editor-project"}),
        )
        .unwrap();
    let id = project["project"]["id"].as_str().unwrap();
    // A folder name with a space stays one argument.
    let path = std::path::Path::new(&fixture.folders[0])
        .parent()
        .unwrap()
        .join("my project");
    fs::create_dir(&path).unwrap();
    Process::new("git")
        .args(["init", "--quiet"])
        .arg(&path)
        .status()
        .unwrap();
    let path = path.to_string_lossy().into_owned();
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
        fixture.root.join("editor.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| {
        s.state.selected.as_ref() == Some(&path)
    });
    click(&mut visual, "sidebar-project-switcher");
    draw(&mut visual);
    click(&mut visual, "sidebar-open-in-editor");
    wait_for(&shell, &mut visual, |_, _| {
        !crate::editor_command::fake_code::args(&log).is_empty()
    });
    assert_eq!(crate::editor_command::fake_code::args(&log), [path]);
    assert!(
        visual.debug_bounds("sidebar-header-menu").is_none(),
        "the action closes the menu"
    );
}

#[gpui::test]
fn project_inventory_notice_refreshes_real_window_without_losing_draft(cx: &mut TestAppContext) {
    struct Producer(std::process::Child);
    impl Drop for Producer {
        fn drop(&mut self) {
            drop(self.0.stdin.take());
            let _ = self.0.wait();
        }
    }
    let repo = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut producer = Producer(
        Process::new("node")
            .current_dir(&repo)
            .args([
                "--import",
                "./scripts/register-server-only-stub.mjs",
                "--import",
                "tsx",
                "tests/fixtures/projects-refresh-ws.ts",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let mut lines = BufReader::new(producer.0.stdout.take().unwrap()).lines();
    let receipt: Value = lines
        .by_ref()
        .find_map(|line| {
            let value: Value = serde_json::from_str(&line.ok()?).ok()?;
            value["origin"].as_str()?;
            Some(value)
        })
        .expect("production WS fixture receipt");
    std::thread::spawn(move || for _ in lines {});
    let client = crate::client::Client::authenticated(
        receipt["origin"].as_str().unwrap(),
        Some(receipt["token"].as_str().unwrap().into()),
    )
    .unwrap();
    let root = std::path::PathBuf::from(receipt["root"].as_str().unwrap());
    let (shell, mut visual) = open(
        client.clone(),
        root.join("window.json"),
        State::default(),
        cx,
    );
    shell.update(&mut visual, |s, _| s.surfaces.setup.skip_first_run());
    wait_for(&shell, &mut visual, |s, _| s.connected);
    shell.update_in(&mut visual, |s, window, cx| {
        s.open_thread_by_id("thoughts-review".into(), window, cx)
    });
    wait_for(&shell, &mut visual, |s, cx| {
        s.active()
            .and_then(|t| s.content.get(&s.key(&t)))
            .is_some_and(|c| c.ready(cx))
    });
    let surface = shell.read_with(&visual, |s, _| {
        match s.content.get(&s.key(&s.active().unwrap())).unwrap() {
            Content::Session(surface) => surface.clone(),
            _ => panic!("selected transcript"),
        }
    });
    surface.update_in(&mut visual, |s, window, cx| s.shell_focus(true, window, cx));
    visual.simulate_input("Unsent inventory refresh draft");
    let selection = shell.read_with(&visual, |s, _| (s.state.selected.clone(), s.active()));
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .diagnostic()["projectNames"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "Inventory A")
    });
    // Let connected's initial dirty read complete before the external mutation.
    wait_for(&shell, &mut visual, |s, cx| {
        let list = s.surfaces.sidebar.view.as_ref().unwrap().read(cx);
        list.diagnostic()["loading"] == false && list.diagnostic()["dirty"] == false
    });
    let project = receipt["project"].as_str().unwrap();
    client
        .project_request(
            "PATCH",
            &format!("/api/panel/projects/{project}"),
            &json!({"name":"Inventory B"}),
        )
        .unwrap();
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .diagnostic()["projectNames"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "Inventory B")
    });
    assert_eq!(
        shell.read_with(&visual, |s, _| (s.state.selected.clone(), s.active())),
        selection
    );
    assert_eq!(
        surface.read_with(&visual, |s, cx| s.shell_issue_state(cx)["draft"].clone()),
        "Unsent inventory refresh draft"
    );
    assert_eq!(
        shell.read_with(&visual, |s, cx| s
            .surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .diagnostic()["project"]
            .clone()),
        project
    );
}
