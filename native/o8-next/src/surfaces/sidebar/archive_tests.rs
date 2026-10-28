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

// Include release events: GPUI's focused click activation happens on key-up.
fn press_keys(visual: &mut VisualTestContext, keys: &str) {
    for key in keys.split_whitespace() {
        visual.simulate_keystrokes(key);
        draw(visual);
        visual.simulate_event(gpui::KeyUpEvent {
            keystroke: gpui::Keystroke::parse(key).unwrap(),
        });
        draw(visual);
    }
}

#[gpui::test]
fn sidebar_archived_disclosure_keyboard_activation_and_navigation(cx: &mut TestAppContext) {
    let fixture = Fixture::with_sidebar(true);
    fixture
        .client
        .patch_thread(
            "thoughts-sidebar-1999",
            json!({"archivedAt":"2026-10-01T01:00:00.000Z"}),
        )
        .unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("disclosure-keys.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    let sidebar = shell.read_with(&visual, |s, _| {
        s.surfaces.sidebar.view.as_ref().unwrap().clone()
    });
    let selected = sidebar.read_with(&visual, |s, _| s.selected.clone());
    press_keys(&mut visual, "f8 tab enter");
    draw(&mut visual);
    assert!(
        visual.debug_bounds("sidebar-archived-header").is_some(),
        "Tab and Enter must open Archived"
    );
    press_keys(&mut visual, "space");
    draw(&mut visual);
    assert!(
        visual.debug_bounds("sidebar-archived").is_some(),
        "Space must collapse the focused header"
    );
    press_keys(&mut visual, "space");
    draw(&mut visual);
    assert!(
        visual.debug_bounds("sidebar-archived-header").is_some(),
        "focus must survive moving between footer and header"
    );
    press_keys(&mut visual, "up");
    draw(&mut visual);
    sidebar.read_with(&visual, |s, _| {
        assert_ne!(s.diagnostic()["choice"]["status"], "archived")
    });
    press_keys(&mut visual, "tab down");
    draw(&mut visual);
    sidebar.read_with(&visual, |s, _| {
        assert_eq!(s.diagnostic()["choice"]["status"], "archived")
    });
    press_keys(&mut visual, "tab home down up");
    draw(&mut visual);
    let first = sidebar.read_with(&visual, |s, _| {
        s.rows.iter().find_map(|r| r.id.clone()).unwrap()
    });
    sidebar.read_with(&visual, |s, _| {
        assert_eq!(s.diagnostic()["choice"]["id"], first)
    });
    press_keys(&mut visual, "tab end");
    draw(&mut visual);
    let last = sidebar.read_with(&visual, |s, _| {
        s.rows.iter().rev().find_map(|r| r.id.clone()).unwrap()
    });
    sidebar.read_with(&visual, |s, _| {
        assert_eq!(s.diagnostic()["choice"]["id"], last)
    });
    press_keys(&mut visual, "tab enter");
    draw(&mut visual);
    assert!(
        visual.debug_bounds("sidebar-archived").is_some(),
        "Tab must return to the expanded disclosure"
    );
    assert_eq!(
        sidebar.read_with(&visual, |s, _| s.selected.clone()),
        selected,
        "disclosure keys must keep the active session"
    );
    press_keys(&mut visual, "f2 delete");
    let record: Value = fixture
        .client
        .get(
            "/api/v2/chat-history",
            &[("tabId", "thoughts-sidebar-1999")],
        )
        .unwrap();
    assert!(
        record["archivedAt"].is_string(),
        "disclosure input must not mutate a thread"
    );
    assert_eq!(record["messages"].as_array().unwrap().len(), 2);
}

#[gpui::test]
fn sidebar_titles_ellipsize_with_visible_archive_and_restore_at_280(cx: &mut TestAppContext) {
    let fixture = Fixture::with_sidebar(true);
    let long = "Double click archive 界 👩‍💻 with a long sidebar title";
    for (id, title, archived) in [
        ("thoughts-sidebar-1999", long, Value::Null),
        (
            "thoughts-sidebar-1998",
            long,
            json!("2026-10-01T01:00:00.000Z"),
        ),
        ("thoughts-sidebar-1997", "Short", Value::Null),
    ] {
        fixture
            .client
            .patch_thread(id, json!({"title":title,"archivedAt":archived}))
            .unwrap();
    }
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("title-width.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    let sidebar = shell.read_with(&visual, |s, _| {
        s.surfaces.sidebar.view.as_ref().unwrap().clone()
    });
    for (id, expected) in [
        ("thoughts-sidebar-1999", long),
        ("thoughts-sidebar-1997", "Short"),
        ("thoughts-sidebar-1998", long),
    ] {
        if id.ends_with("1998") {
            click(&mut visual, "sidebar-archived");
        }
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
        let row = visual
            .debug_bounds(Box::leak(format!("thread-row-{index}").into_boxed_str()))
            .unwrap();
        visual.simulate_mouse_move(row.center(), None, gpui::Modifiers::default());
        draw(&mut visual);
        let rail = visual.debug_bounds("thread-sidebar").unwrap();
        assert_eq!(rail.size.width, px(280.));
        let action = visual
            .debug_bounds(Box::leak(format!("thread-archive-{id}").into_boxed_str()))
            .unwrap();
        sidebar.read_with(&visual, |s, _| {
            let layout = &s.title_layouts[id];
            let text = layout.text();
            if expected == "Short" {
                assert_eq!(text, expected);
            } else {
                assert!(
                    text.ends_with('…'),
                    "long row title must end in an actual ellipsis: {text:?}"
                );
            }
            assert!(
                layout.bounds().right() <= action.left(),
                "title must not overlap the action"
            );
            assert!(action.right() <= rail.right());
            assert_eq!(action.size.width, px(38.));
        });
    }
}
