//! Row archive and restore read back the same saved metadata used by desktop.
use super::*;

fn archive_fixture(cx: &mut TestAppContext, restore: bool) {
    let fixture = Fixture::with_sidebar(true);
    let id = "thoughts-sidebar-1999";
    if restore {
        fixture
            .client
            .patch_thread(id, json!({"archivedAt":"2026-10-01T01:00:00.000Z"}))
            .unwrap();
    }
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("archive-row.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    if restore {
        click(&mut visual, "sidebar-archived");
        draw(&mut visual);
    }
    let sidebar = shell.read_with(&visual, |s, _| {
        s.surfaces.sidebar.view.as_ref().unwrap().clone()
    });
    let selected = sidebar.read_with(&visual, |s, _| s.selected.clone());
    let index = sidebar.read_with(&visual, |s, _| {
        s.rows
            .iter()
            .position(|r| r.id.as_deref() == Some(id))
            .unwrap()
    });
    sidebar.update(&mut visual, |s, cx| {
        s.scroll.scroll_to_item_strict(index, ScrollStrategy::Top);
        cx.notify();
    });
    draw(&mut visual);
    let bounds = visual
        .debug_bounds(Box::leak(format!("thread-row-{index}").into_boxed_str()))
        .unwrap();
    visual.simulate_mouse_move(bounds.center(), None, gpui::Modifiers::default());
    draw(&mut visual);
    let action = visual
        .debug_bounds(Box::leak(format!("thread-archive-{id}").into_boxed_str()))
        .unwrap();
    let rail = visual.debug_bounds("thread-sidebar").unwrap();
    assert!(
        action.right() <= rail.right(),
        "row actions must stay inside the sidebar"
    );
    click(
        &mut visual,
        Box::leak(format!("thread-archive-{id}").into_boxed_str()),
    );
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .sessions
            .iter()
            .any(|r| r.id == id && (r.status == "archived") != restore)
    });
    assert_eq!(
        sidebar.read_with(&visual, |s, _| s.selected.clone()),
        selected,
        "row actions must not activate another thread"
    );
    let record: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", id)])
        .unwrap();
    assert_eq!(record["archivedAt"].is_null(), restore);
    assert_eq!(record["messages"].as_array().unwrap().len(), 2);
    let desktop: Value = fixture
        .client
        .get(
            "/api/v2/chat-history/list",
            &[
                ("include", "orchestrator"),
                ("archived", if restore { "exclude" } else { "only" }),
            ],
        )
        .unwrap();
    assert!(
        desktop["conversations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["tabId"] == id)
    );
}
#[gpui::test]
fn sidebar_row_archive_uses_desktop_metadata(cx: &mut TestAppContext) {
    archive_fixture(cx, false);
}
#[gpui::test]
fn sidebar_row_unarchive_uses_desktop_metadata(cx: &mut TestAppContext) {
    archive_fixture(cx, true);
}
