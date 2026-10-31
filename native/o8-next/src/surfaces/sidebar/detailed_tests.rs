//! Detailed rows and the Working section, opt-in from the view menu.
use super::recents_tests::native_rows;
use super::thread_list::detailed::{fold_working, status};
use super::thread_list::Row;
use super::*;

fn session(status: &str) -> Session {
    serde_json::from_value(json!({"id": "t", "title": "T", "status": status})).unwrap()
}
fn header(kind: &str, title: &str, _status: &str) -> Row {
    Row {
        kind: kind.into(),
        workspace: String::new(),
        id: None,
        title: title.into(),
        status: String::new(),
        unread: false,
        running: false,
        age: String::new(),
        branch: false,
        attention: false,
        marker: "",
        folder: None,
    }
}
fn thread(id: &str, running: bool) -> Row {
    let mut row = header("thread", id, "");
    row.id = Some(id.into());
    row.running = running;
    row
}

#[test]
fn detailed_status_names_input_woke_running_and_done() {
    assert_eq!(status(&session("awaiting_input"), false, false, "2m").label, "Input");
    assert_eq!(status(&session("idle"), true, false, "2m").label, "Woke");
    assert_eq!(status(&session("running"), false, true, "38m").label, "38m");
    assert_eq!(status(&session("queued"), false, false, "1m").label, "Waiting");
    assert_eq!(status(&session("idle"), false, false, "2d").label, "Done");
    assert_eq!(status(&session("failed"), false, false, "2d").label, "Error");
    // An unknown status shows its age, not a guessed state.
    assert_eq!(status(&session("mystery"), false, false, "4d").label, "4d");
}

#[test]
fn working_section_takes_running_threads_before_later_shelves() {
    let rows = vec![
        header("section", "Active", ""),
        thread("a", false),
        thread("b", true),
        header("section", "Settled", ""),
        thread("c", true),
    ];
    let titles = |rows: &[Row]| rows.iter().map(|r| r.title.clone()).collect::<Vec<_>>();
    assert_eq!(
        titles(&fold_working(rows.clone(), false)),
        ["Working · 1", "b", "Active", "a", "Settled", "c"]
    );
    assert_eq!(
        titles(&fold_working(rows.clone(), true)),
        ["Working · 1", "Active", "a", "Settled", "c"]
    );
    let idle: Vec<_> = rows.into_iter().filter(|r| !r.running).collect();
    assert_eq!(titles(&fold_working(idle, false)), ["Active", "a", "Settled"]);
}

#[gpui::test]
fn sidebar_detailed_rows_and_working_section_toggle_and_persist(cx: &mut TestAppContext) {
    let fixture = Fixture::with_options(&["--sidebar", "--sidebar-markers"]);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("detailed.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    let row_height = |visual: &mut VisualTestContext| {
        visual.debug_bounds("thread-row-1").expect("a thread row").size.height
    };
    assert_eq!(row_height(&mut visual), px(28.));
    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-detailed");
    wait_for(&shell, &mut visual, |s, _| s.state.sidebar_detailed_rows);
    draw(&mut visual);
    assert_eq!(row_height(&mut visual), px(super::thread_list::detailed::ROW_HEIGHT));
    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-working");
    wait_for(&shell, &mut visual, |s, _| s.state.sidebar_working_section);
    draw(&mut visual);
    let first = shell.read_with(&visual, |s, cx| {
        let list = s.surfaces.sidebar.view.as_ref().unwrap().read(cx);
        let id = list
            .rows
            .iter()
            .filter(|r| r.kind == "thread")
            .filter_map(|r| r.id.clone())
            .find(|id| id.starts_with("thoughts-") && list.sessions.iter().any(|s| &s.id == id))
            .unwrap();
        let session = list.sessions.iter().find(|s| s.id == id).unwrap().clone();
        let row = list.rows.iter().find(|r| r.id.as_ref() == Some(&id)).unwrap();
        let key = status(&session, false, row.running, &row.age).key;
        (id, key)
    });
    let first_index = shell.read_with(&visual, |s, cx| {
        s.surfaces.sidebar.view.as_ref().unwrap().read(cx).rows.iter()
            .position(|r| r.id.as_ref() == Some(&first.0)).unwrap()
    });
    shell.update(&mut visual, |s, cx| {
        s.surfaces.sidebar.view.clone().unwrap().update(cx, |l, cx| {
            l.scroll.scroll_to_item(first_index, ScrollStrategy::Center);
            cx.notify();
        })
    });
    draw(&mut visual);
    let selector: &'static str =
        Box::leak(format!("thread-status-{}-{}", first.1, first.0).into_boxed_str());
    assert!(visual.debug_bounds(selector).is_some(), "{selector} on the first line");
    // The packet's branch shows on the third line of its thread.
    let branched = "thoughts-sidebar-0019";
    let index = shell.read_with(&visual, |s, cx| {
        s.surfaces.sidebar.view.as_ref().unwrap().read(cx).rows.iter()
            .position(|r| r.id.as_deref() == Some(branched)).unwrap()
    });
    shell.update(&mut visual, |s, cx| {
        s.surfaces.sidebar.view.clone().unwrap().update(cx, |l, cx| {
            l.scroll.scroll_to_item(index, ScrollStrategy::Center);
            cx.notify();
        })
    });
    draw(&mut visual);
    assert!(visual.debug_bounds("thread-branch-thoughts-sidebar-0019").is_some());

    // Working: a running thread folds into a section that collapses.
    // The fixture's running workers are drawn from the server's own status.
    let running = native_rows(&shell, &visual).as_array().unwrap().iter()
        .find(|r| r["running"] == true && r["kind"] == "thread")
        .and_then(|r| r["id"].as_str().map(str::to_owned))
        .expect("a running thread in the fixture");
    shell.update(&mut visual, |s, cx| {
        s.surfaces.sidebar.view.clone().unwrap().update(cx, |l, cx| {
            l.scroll.scroll_to_item(0, ScrollStrategy::Top);
            cx.notify();
        })
    });
    draw(&mut visual);
    let rows = native_rows(&shell, &visual);
    let rows = rows.as_array().unwrap();
    let header = rows.iter().position(|r| r["status"] == "working").expect("Working section");
    let end = rows[header + 1..]
        .iter()
        .position(|r| r["kind"] == "section")
        .map_or(rows.len(), |n| header + 1 + n);
    let held: Vec<_> = rows[header + 1..end].iter().filter(|r| r["kind"] == "thread").collect();
    assert_eq!(rows[header]["title"], format!("Working · {}", held.len()).as_str());
    assert!(held.iter().all(|r| r["running"] == true));
    assert!(held.iter().any(|r| r["id"] == running.as_str()), "the running thread is in Working");
    assert_eq!(rows.iter().filter(|r| r["id"] == running.as_str()).count(), 1);
    shell.update(&mut visual, |s, cx| {
        s.surfaces.sidebar.view.clone().unwrap().update(cx, |l, cx| {
            l.scroll.scroll_to_item(header, ScrollStrategy::Center);
            cx.notify();
        })
    });
    draw(&mut visual);
    click(&mut visual, "sidebar-working-header");
    draw(&mut visual);
    let rows = native_rows(&shell, &visual);
    assert!(
        !rows.as_array().unwrap().iter().any(|r| r["id"] == running.as_str()),
        "a collapsed Working section hides its threads"
    );
    let saved: State = serde_json::from_str(
        &std::fs::read_to_string(fixture.root.join("detailed.json")).unwrap(),
    )
    .unwrap();
    assert!(saved.sidebar_detailed_rows && saved.sidebar_working_section);
}

#[test]
fn sessions_read_repo_slug_and_branch_additively() {
    let s: Session = serde_json::from_value(json!({"id": "t", "title": "T", "status": "idle",
        "repoSlug": "o8-run/o8", "branch": "feature/rows"})).unwrap();
    assert_eq!(s.repo_slug.as_deref(), Some("o8-run/o8"));
    assert_eq!(s.branch.as_deref(), Some("feature/rows"));
    assert_eq!(session("idle").branch, None);
}
