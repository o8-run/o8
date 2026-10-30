//! Real scope picker and row menu input -> the chat list and the saved shell state.
use super::*;

pub(super) fn project(fixture: &Fixture, paths: &[String]) -> String {
    let created = fixture
        .client
        .project_request(
            "POST",
            "/api/projects",
            &json!({"name":"Scope project","slug":"scope-project"}),
        )
        .unwrap();
    let id = created["project"]["id"].as_str().unwrap().to_owned();
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
    fixture
        .client
        .project_request(
            "POST",
            "/api/panel/projects/active",
            &json!({"projectId":id}),
        )
        .unwrap();
    id
}
pub(super) fn repo_name(fixture: &Fixture, path: &str) -> String {
    let repos: Value = fixture.client.get("/api/panel/repos", &[]).unwrap();
    repos["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["localPath"] == path)
        .and_then(|r| r["name"].as_str())
        .unwrap()
        .to_owned()
}
pub(super) fn listed(shell: &Entity<Shell>, cx: &VisualTestContext) -> Vec<String> {
    shell.read_with(cx, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .rows
            .iter()
            .filter_map(|r| r.id.clone())
            .filter(|id| id.starts_with("thoughts-composer-"))
            .collect()
    })
}
fn press(cx: &mut VisualTestContext, selector: &str, modifiers: gpui::Modifiers) {
    draw(cx);
    let bounds = cx
        .debug_bounds(Box::leak(selector.to_owned().into_boxed_str()))
        .unwrap_or_else(|| panic!("missing {selector}"));
    cx.simulate_click(bounds.center(), modifiers);
}
fn right_click(cx: &mut VisualTestContext, selector: &'static str) {
    draw(cx);
    let at = cx.debug_bounds(selector).unwrap().center();
    cx.simulate_mouse_down(at, gpui::MouseButton::Right, gpui::Modifiers::default());
    cx.simulate_mouse_up(at, gpui::MouseButton::Right, gpui::Modifiers::default());
}
fn row_of(shell: &Entity<Shell>, cx: &VisualTestContext, id: &str) -> &'static str {
    let index = shell.read_with(cx, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .rows
            .iter()
            .position(|r| r.id.as_deref() == Some(id))
            .unwrap()
    });
    Box::leak(format!("thread-row-{index}").into_boxed_str())
}

#[gpui::test]
fn sidebar_scope_picker_and_row_filter_scope_the_list(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --composer --sidebar");
    let id = project(&fixture, &fixture.folders);
    let (first, second) = ("thoughts-composer-first", "thoughts-composer-second");
    for (tab, path) in [(first, &fixture.folders[0]), (second, &fixture.folders[1])] {
        fixture
            .client
            .project_request(
                "PATCH",
                "/api/v2/chat-history",
                &json!({"tabId":tab,"repoPath":path}),
            )
            .unwrap();
    }
    let names = [
        repo_name(&fixture, &fixture.folders[0]),
        repo_name(&fixture, &fixture.folders[1]),
    ];
    let file = fixture.root.join("scope.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    wait_for(&shell, &mut visual, |s, _| s.connected);
    wait_for(&shell, &mut visual, |s, cx| {
        let listed = s
            .surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .rows
            .clone();
        [first, second]
            .iter()
            .all(|id| listed.iter().any(|r| r.id.as_deref() == Some(*id)))
    });

    // A plain pick scopes the list to one repository and closes the picker.
    click(&mut visual, "sidebar-scope");
    press(
        &mut visual,
        &format!("sidebar-scope-item-{}", names[0]),
        gpui::Modifiers::default(),
    );
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_scope.get(&id) == Some(&vec![fixture.folders[0].clone()])
    });
    draw(&mut visual);
    assert_eq!(listed(&shell, &visual), vec![first.to_owned()]);
    assert!(visual.debug_bounds("sidebar-scope-menu").is_none());
    let monogram: String = names[0]
        .split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .filter_map(|word| word.chars().next())
        .take(2)
        .flat_map(char::to_uppercase)
        .collect();
    let mark = format!("sidebar-scope-identity:{monogram}");
    assert!(
        visual
            .debug_bounds(Box::leak(mark.into_boxed_str()))
            .is_some()
    );

    // Shift adds a repository and keeps the picker open.
    click(&mut visual, "sidebar-scope");
    press(
        &mut visual,
        &format!("sidebar-scope-item-{}", names[1]),
        gpui::Modifiers::shift(),
    );
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_scope.get(&id).map(Vec::len) == Some(2)
    });
    draw(&mut visual);
    assert!(visual.debug_bounds("sidebar-scope-menu").is_some());
    let mut both = listed(&shell, &visual);
    both.sort();
    assert_eq!(both, vec![first.to_owned(), second.to_owned()]);

    // The search narrows the items; Enter picks the highlighted one.
    assert!(names[1].ends_with("two") && !names[0].contains("two"));
    visual.simulate_keystrokes("t w o");
    draw(&mut visual);
    assert!(visual.debug_bounds("sidebar-scope-all").is_none());
    visual.simulate_keystrokes("enter");
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_scope.get(&id) == Some(&vec![fixture.folders[1].clone()])
    });
    draw(&mut visual);
    assert_eq!(listed(&shell, &visual), vec![second.to_owned()]);

    // The row menu shows every repository again, then filters by the row's.
    let row = row_of(&shell, &visual, second);
    right_click(&mut visual, row);
    click(&mut visual, "sidebar-row-filter");
    wait_for(&shell, &mut visual, |s, _| {
        !s.state.sidebar_scope.contains_key(&id)
    });
    draw(&mut visual);
    let all = listed(&shell, &visual);
    assert!(all.iter().any(|t| t == first) && all.iter().any(|t| t == second));
    let row = row_of(&shell, &visual, first);
    right_click(&mut visual, row);
    click(&mut visual, "sidebar-row-filter");
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_scope.get(&id) == Some(&vec![fixture.folders[0].clone()])
    });

    // The scope is saved per project and restored on the next launch.
    assert_eq!(
        State::load(&file).unwrap().sidebar_scope.get(&id),
        Some(&vec![fixture.folders[0].clone()])
    );
    drop(shell);
    let saved = State::load(&file).unwrap();
    let (shell, mut visual) = open(fixture.client.clone(), file, saved, cx);
    wait_for(&shell, &mut visual, |s, cx| {
        let listed = s
            .surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .rows
            .clone();
        listed.iter().any(|r| r.id.as_deref() == Some(first))
    });
    draw(&mut visual);
    assert_eq!(listed(&shell, &visual), vec![first.to_owned()]);

    // Opening a thread the scope hides widens it to every repository.
    let sidebar = shell.read_with(&visual, |s, _| s.surfaces.sidebar.view.clone().unwrap());
    sidebar.update(&mut visual, |s, cx| s.sync_selection(second.into(), cx));
    wait_for(&shell, &mut visual, |s, _| {
        !s.state.sidebar_scope.contains_key(&id)
    });
    draw(&mut visual);
    let all = listed(&shell, &visual);
    assert!(all.iter().any(|t| t == first) && all.iter().any(|t| t == second));
}
