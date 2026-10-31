//! Real view picker, folder and New thread input -> the chat list, the saved
//! shell state and the desktop's chat history route.
use super::scope_tests::{listed, project, repo_name};
use super::*;

fn rows(shell: &Entity<Shell>, cx: &VisualTestContext) -> Vec<thread_list::Row> {
    shell.read_with(cx, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .rows
            .to_vec()
    })
}
fn conversations(fixture: &Fixture) -> Vec<Value> {
    let list: Value = fixture
        .client
        .get("/api/v2/chat-history/list", &[("include", "orchestrator")])
        .unwrap();
    list["conversations"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}
/// The thread New thread opened: selected in a list that carries it. Empty
/// conversations stay out of the chat-history list until they have content.
fn started(shell: &Shell, cx: &App, except: Option<&str>) -> Option<String> {
    let list = shell.surfaces.sidebar.view.as_ref().unwrap().read(cx);
    let id = list.selected.clone()?;
    (id.starts_with("thoughts-next-")
        && Some(id.as_str()) != except
        && list
            .rows
            .iter()
            .any(|r| r.id.as_deref() == Some(id.as_str())))
    .then_some(id)
}
fn hover_click(cx: &mut VisualTestContext, row: &str, selector: &str) {
    draw(cx);
    let at = cx
        .debug_bounds(Box::leak(row.to_owned().into_boxed_str()))
        .unwrap_or_else(|| panic!("missing {row}"))
        .center();
    cx.simulate_mouse_move(at, None, gpui::Modifiers::default());
    draw(cx);
    let bounds = cx
        .debug_bounds(Box::leak(selector.to_owned().into_boxed_str()))
        .unwrap_or_else(|| panic!("missing {selector}"));
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
}

#[gpui::test]
fn sidebar_views_fold_threads_into_repo_folders_and_start_threads(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --composer --sidebar --settings");
    let (first, second) = ("thoughts-composer-first", "thoughts-composer-second");
    // The owned fixture repository is the only one that admits New thread.
    let repo = conversations(&fixture)
        .into_iter()
        .find(|c| c["tabId"] == first)
        .and_then(|c| c["repoPath"].as_str().map(str::to_owned))
        .unwrap();
    let paths = [repo.clone(), fixture.folders[0].clone()];
    let id = project(&fixture, &paths);
    fixture
        .client
        .project_request(
            "PATCH",
            "/api/v2/chat-history",
            &json!({"tabId":second,"repoPath":paths[1]}),
        )
        .unwrap();
    let names = [
        repo_name(&fixture, &paths[0]),
        repo_name(&fixture, &paths[1]),
    ];
    let file = fixture.root.join("views.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    wait_for(&shell, &mut visual, |s, _| s.connected);
    wait_for(&shell, &mut visual, |s, cx| {
        let rows = s
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
            .all(|id| rows.iter().any(|r| r.id.as_deref() == Some(*id)))
    });

    // Group by repo: one folder per repository, each above its threads.
    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-repo");
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_view.get(&id).map(String::as_str) == Some("repo")
    });
    let folders: Vec<_> = rows(&shell, &visual)
        .into_iter()
        .filter(|r| r.kind == "folder")
        .map(|r| r.title)
        .collect();
    assert_eq!(folders[..2], names);
    let order: Vec<_> = rows(&shell, &visual)
        .into_iter()
        .filter_map(|r| r.id.or((r.kind == "folder").then_some(r.title)))
        .filter(|key| !key.starts_with("thoughts-") || key.starts_with("thoughts-composer-"))
        .collect();
    let at = |key: &str| order.iter().position(|k| k == key).unwrap();
    assert!(at(&names[0]) < at(first) && at(first) < at(&names[1]));
    assert!(at(&names[1]) < at(second));

    // A closed folder hides its threads and keeps their count; the state saves.
    click(
        &mut visual,
        Box::leak(format!("sidebar-folder-{}", names[0]).into_boxed_str()),
    );
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_closed_folders.contains(&paths[0])
    });
    draw(&mut visual);
    assert_eq!(listed(&shell, &visual), vec![second.to_owned()]);
    let folder = rows(&shell, &visual)
        .into_iter()
        .find(|r| r.title == names[0])
        .unwrap()
        .folder
        .unwrap();
    assert!(!folder.open);
    assert!(folder.count >= 1);
    assert!(
        visual
            .debug_bounds(Box::leak(
                format!("sidebar-folder-count:{}", folder.count).into_boxed_str()
            ))
            .is_some()
    );

    // The view and closed folders return on the next launch.
    drop(shell);
    let saved = State::load(&file).unwrap();
    assert_eq!(
        saved.sidebar_view.get(&id).map(String::as_str),
        Some("repo")
    );
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), saved, cx);
    wait_for(&shell, &mut visual, |s, cx| {
        let rows = s
            .surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .rows
            .clone();
        rows.iter().any(|r| r.id.as_deref() == Some(second))
    });
    draw(&mut visual);
    assert_eq!(listed(&shell, &visual), vec![second.to_owned()]);
    click(
        &mut visual,
        Box::leak(format!("sidebar-folder-{}", names[0]).into_boxed_str()),
    );
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_closed_folders.is_empty()
    });

    // A folder's New thread starts a conversation in that repository, on the
    // operator's lead rather than the server's runtime placeholder.
    fixture
        .client
        .request("POST", &fixture.client.url("/api/panel/operator-defaults").unwrap())
        .send_json(json!({"orchestratorBackend": "claude", "orchestratorModel": "claude-opus-5-5"}))
        .unwrap();
    hover_click(
        &mut visual,
        &format!("sidebar-folder-{}", names[0]),
        &format!("sidebar-folder-new-{}", names[0]),
    );
    wait_for(&shell, &mut visual, |s, cx| started(s, cx, None).is_some());
    let created = shell
        .read_with(&visual, |s, cx| started(s, cx, None))
        .unwrap();
    let record: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", &created)])
        .unwrap();
    assert_eq!(record["repoPath"], paths[0]);
    assert_eq!(record["backend"], "claude");
    // The lead's model, not the placeholder "claude-code" that failed to send.
    assert_eq!(record["model"], "claude-opus-5-5");
    // The shell opened it rather than putting the previous thread back.
    for _ in 0..3 {
        draw(&mut visual);
        visual.run_until_parked();
    }
    assert_eq!(
        shell.read_with(&visual, |s, cx| started(s, cx, None)),
        Some(created.clone())
    );

    // Chronological: one list, no date headings.
    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-chronological");
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_view.get(&id).map(String::as_str) == Some("chronological")
    });
    let sections: Vec<_> = rows(&shell, &visual)
        .into_iter()
        .filter(|r| r.kind == "section")
        .map(|r| r.title)
        .collect();
    assert!(
        !sections
            .iter()
            .any(|t| t == "Today" || t.starts_with("Previous"))
    );
    let all = listed(&shell, &visual);
    assert!(all.iter().any(|t| t == first) && all.iter().any(|t| t == second));

    // A trigger closes its own open menu rather than reopening it.
    click(&mut visual, "sidebar-view");
    draw(&mut visual);
    assert!(visual.debug_bounds("sidebar-view-menu").is_some());
    click(&mut visual, "sidebar-view");
    draw(&mut visual);
    assert!(visual.debug_bounds("sidebar-view-menu").is_none());

    // Outside By repo, with two repositories, New thread asks which one.
    click(&mut visual, "sidebar-new-thread");
    draw(&mut visual);
    assert!(visual.debug_bounds("sidebar-new-thread-menu").is_some());
    click(
        &mut visual,
        Box::leak(format!("sidebar-new-thread-in-{}", names[0]).into_boxed_str()),
    );
    wait_for(&shell, &mut visual, |s, cx| {
        started(s, cx, Some(&created)).is_some()
    });
    draw(&mut visual);
    assert!(visual.debug_bounds("sidebar-new-thread-menu").is_none());

    // Choosing another thread before the list carries a new one keeps that
    // choice when the load lands.
    let sidebar = shell.read_with(&visual, |s, _| s.surfaces.sidebar.view.clone().unwrap());
    sidebar.update(&mut visual, |s, cx| {
        s.expect_open(&created);
        s.choose(first.into(), cx);
        s.load(cx);
    });
    for _ in 0..3 {
        visual.run_until_parked();
        draw(&mut visual);
    }
    assert_eq!(
        sidebar.read_with(&visual, |s, _| s.selected.clone()),
        Some(first.to_owned())
    );
}
