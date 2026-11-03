//! Sidebar descriptors and real disclosure, row and keyboard dispatch.
use super::*;
use gpui::{TestAppContext, VisualTestContext};

fn session(id: &str, status: &str, parent: Option<&str>, at: &str) -> Session {
    serde_json::from_value(json!({
        "id": id, "title": format!("Thread {id}"), "status": status,
        "lastMessageAt": at, "repoPath": "/fixture/repo", "messageCount": 2,
        "parentInboxSubject": parent.map(|id| json!({"kind": "conversation", "id": id})),
    }))
    .unwrap()
}

fn family(status: &str) -> Vec<Session> {
    vec![
        session("parent", "idle", None, "2026-10-01T10:00:00Z"),
        session("old", "idle", Some("parent"), "2026-11-01T10:00:00Z"),
        session("new", status, Some("parent"), "2026-11-02T10:00:00Z"),
        session("orphan", "idle", Some("absent"), "2026-09-01T10:00:00Z"),
    ]
}

fn make(
    cx: &mut TestAppContext,
    sessions: Vec<Session>,
    detailed: bool,
) -> (Entity<ThreadList>, &mut VisualTestContext) {
    cx.add_window_view(|window, cx| {
        let mut list = ThreadList::new(Client::new("http://127.0.0.1:9").unwrap(), cx);
        list.sessions = sessions;
        list.detailed = detailed;
        list.rebuild();
        list.focus.focus(window);
        list
    })
}

fn ids(list: &Entity<ThreadList>, cx: &VisualTestContext) -> Vec<String> {
    list.read_with(cx, |list, _| {
        list.rows.iter().filter_map(|r| r.id.clone()).collect()
    })
}

fn row(list: &Entity<ThreadList>, cx: &VisualTestContext, id: &str) -> Value {
    list.read_with(cx, |list, _| {
        serde_json::to_value(
            list.rows
                .iter()
                .find(|r| r.id.as_deref() == Some(id))
                .unwrap(),
        )
        .unwrap()
    })
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
        window.refresh();
        window.draw(cx).clear();
    });
}

fn click(cx: &mut VisualTestContext, selector: &str) {
    draw(cx);
    let selector = Box::leak(selector.to_owned().into_boxed_str());
    let at = cx.debug_bounds(selector).expect(selector).center();
    cx.simulate_click(at, Default::default());
    draw(cx);
}

#[gpui::test]
fn sidebar_nesting_groups_counts_and_keeps_orphans(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, family("running"), true);
    assert_eq!(ids(&list, cx), ["parent", "new", "old", "orphan"]);
    assert_eq!(row(&list, cx, "parent")["child_count"], 2);
    assert_eq!(row(&list, cx, "new")["depth"], 1);
    assert_eq!(row(&list, cx, "orphan")["depth"], 0);
    list.read_with(cx, |list, _| {
        assert!(
            !list.rows.windows(2).any(|r| r[0].kind == "section"
                && r[1].kind == "section"
                && r[0].title != "Recents")
        );
    });
    list.update(cx, |list, _| {
        list.sessions[0].status = "archived".into();
        list.rebuild();
    });
    assert_eq!(ids(&list, cx), ["new", "old", "orphan"]);
    assert_eq!(row(&list, cx, "new")["depth"], 0);
    // A parent behind Show more cannot take its children off this page.
    list.update(cx, |list, _| {
        list.sessions = family("running");
        list.sessions.extend(
            (0..13).map(|n| session(&format!("page-{n}"), "idle", None, "2026-10-01T11:00:00Z")),
        );
        list.rebuild();
    });
    assert!(!ids(&list, cx).contains(&"parent".into()));
    assert_eq!(row(&list, cx, "new")["depth"], 0);
    // Pins keep their order; a pinned parent carries its unpinned children.
    list.update(cx, |list, _| {
        list.sessions = family("running");
        list.sessions[0].pinned_at = Some("2026-11-01T00:00:00Z".into());
        list.rebuild();
    });
    assert_eq!(ids(&list, cx), ["parent", "new", "old", "orphan"]);
    list.update(cx, |list, _| {
        list.sessions[2].pinned_at = Some("2026-10-31T00:00:00Z".into());
        list.rebuild();
    });
    assert_eq!(ids(&list, cx), ["new", "parent", "orphan"]);
    assert_eq!(row(&list, cx, "parent")["child_count"], 1);
    list.update(cx, |list, _| {
        list.sessions = family("running");
        list.sessions[0].status = "running".into();
        list.working_section = true;
        list.rebuild();
    });
    assert_eq!(ids(&list, cx), ["parent", "new", "old", "orphan"]);
    list.update(cx, |list, _| {
        list.working_closed = true;
        list.rebuild();
    });
    assert_eq!(ids(&list, cx), ["orphan"], "Working folds the whole family");
}

#[gpui::test]
fn sidebar_nesting_defaults_follow_child_status(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, family("completed"), true);
    assert_eq!(ids(&list, cx), ["parent", "orphan"]);
    for status in [
        "running",
        "working",
        "awaiting_input",
        "awaiting_human",
        "approval",
    ] {
        list.update(cx, |list, _| {
            list.sessions[2].status = status.into();
            list.rebuild();
        });
        assert_eq!(
            ids(&list, cx),
            ["parent", "new", "old", "orphan"],
            "{status}"
        );
        assert_eq!(row(&list, cx, "parent")["children_open"], true);
    }
    list.update(cx, |list, _| {
        list.sessions[2].status = "failed".into();
        list.rebuild();
    });
    assert_eq!(ids(&list, cx), ["parent", "orphan"]);
}

#[gpui::test]
fn sidebar_nesting_toggle_survives_rebuild_and_status(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, family("running"), true);
    assert_eq!(row(&list, cx, "parent")["children_open"], true);
    draw(cx);
    assert!(cx.debug_bounds("thread-children-count-parent:2").is_some());
    click(cx, "thread-children-parent");
    assert_eq!(ids(&list, cx), ["parent", "orphan"]);
    assert_eq!(
        list.read_with(cx, |list, _| list.selected.clone()),
        None,
        "disclosure does not select"
    );
    list.update(cx, |list, _| {
        list.sessions[2].status = "awaiting_input".into();
        list.rebuild();
    });
    assert_eq!(ids(&list, cx), ["parent", "orphan"]);
    click(cx, "thread-children-parent");
    list.update(cx, |list, _| {
        list.sessions[2].status = "completed".into();
        list.detailed = false;
        list.rebuild();
    });
    assert_eq!(ids(&list, cx), ["parent", "new", "old", "orphan"]);
    assert_eq!(row(&list, cx, "parent")["children_open"], true);
}

#[gpui::test]
fn sidebar_nesting_keyboard_skips_hidden_children(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, family("completed"), true);
    assert_eq!(ids(&list, cx), ["parent", "orphan"]);
    cx.simulate_keystrokes("home down");
    assert_eq!(
        list.read_with(cx, |list, _| list.choice.clone()).as_deref(),
        Some("orphan")
    );
    cx.simulate_keystrokes("up");
    assert_eq!(
        list.read_with(cx, |list, _| list.choice.clone()).as_deref(),
        Some("parent")
    );
    click(cx, "thread-children-parent");
    cx.simulate_keystrokes("down enter");
    assert_eq!(
        list.read_with(cx, |list, _| list.selected.clone())
            .as_deref(),
        Some("new")
    );
    click(cx, "thread-children-parent");
    assert_eq!(
        ids(&list, cx),
        ["parent", "orphan"],
        "selected children do not override a toggle"
    );
}

#[gpui::test]
fn sidebar_nesting_search_stays_flat_and_restores_toggle(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, family("completed"), true);
    assert_eq!(ids(&list, cx), ["parent", "orphan"]);
    click(cx, "thread-children-parent");
    click(cx, "thread-children-parent");
    list.update(cx, |list, _| {
        list.sessions[2].status = "running".into();
        list.query = "Thread".into();
        list.rebuild();
    });
    assert_eq!(ids(&list, cx), ["new", "old", "parent", "orphan"]);
    assert_eq!(row(&list, cx, "parent")["child_count"], 0);
    assert_eq!(row(&list, cx, "new")["depth"], 0);
    list.update(cx, |list, _| {
        list.query = "new".into();
        list.rebuild();
    });
    assert_eq!(ids(&list, cx), ["new"]);
    list.update(cx, |list, _| {
        list.query.clear();
        list.rebuild();
    });
    assert_eq!(ids(&list, cx), ["parent", "orphan"]);
    list.update(cx, |list, _| {
        list.header.ledger = serde_json::from_value(json!({
            "activeProjectId": "fixture", "projects": [{"id": "fixture", "repoPaths": ["/fixture/repo"]}]
        })).unwrap();
        list.scopes.insert("fixture".into(), vec!["/fixture/repo".into()]);
        list.rebuild();
    });
    assert_eq!(
        ids(&list, cx),
        ["new", "old", "parent", "orphan"],
        "repository filters stay flat"
    );
    assert_eq!(row(&list, cx, "parent")["child_count"], 0);
}

#[gpui::test]
fn sidebar_nesting_compact_requires_disclosure(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, family("running"), false);
    assert_eq!(ids(&list, cx), ["parent", "orphan"]);
    click(cx, "thread-children-parent");
    assert_eq!(ids(&list, cx), ["parent", "new", "old", "orphan"]);
    draw(cx);
    let index = list.read_with(cx, |list, _| {
        list.rows
            .iter()
            .position(|r| r.id.as_deref() == Some("new"))
            .unwrap()
    });
    let selector = format!("thread-row-{index}");
    click(cx, &selector);
    assert_eq!(
        list.read_with(cx, |list, _| list.selected.clone())
            .as_deref(),
        Some("new")
    );
    archive_child(&list, cx);
}

fn archive_child(list: &Entity<ThreadList>, cx: &mut VisualTestContext) {
    use crate::shell::test_support::Fixture;
    let fixture = Fixture::new();
    let (mut sessions, _) = fixture.client.sidebar_sessions_with_branches().unwrap();
    let (parent, child) = ("thoughts-composer-first", "thoughts-composer-second");
    sessions.retain(|s| s.id == parent || s.id == child);
    assert_eq!(sessions.len(), 2);
    sessions
        .iter_mut()
        .find(|s| s.id == child)
        .unwrap()
        .parent_inbox_subject = Some(json!({"kind": "conversation", "id": parent}));
    list.update(cx, |list, _| {
        list.client = fixture.client.clone();
        list.sessions = sessions;
        list.selected = None;
        list.choice = None;
        list.rebuild();
    });
    click(cx, &format!("thread-children-{parent}"));
    assert_eq!(row(list, cx, child)["depth"], 1);
    let index = list.read_with(cx, |list, _| {
        list.rows
            .iter()
            .position(|r| r.id.as_deref() == Some(child))
            .unwrap()
    });
    let selector = Box::leak(format!("thread-row-{index}").into_boxed_str());
    let at = cx.debug_bounds(selector).unwrap().center();
    cx.simulate_mouse_down(at, gpui::MouseButton::Right, Default::default());
    cx.simulate_mouse_up(at, gpui::MouseButton::Right, Default::default());
    click(cx, "sidebar-row-archive");
    let start = Instant::now();
    loop {
        cx.run_until_parked();
        if list.read_with(cx, |list, _| {
            !list.saving
                && !list.loading
                && list
                    .sessions
                    .iter()
                    .any(|s| s.id == child && s.status == "archived")
        }) {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "child archive must reload"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let record: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", child)])
        .unwrap();
    assert!(
        record["archivedAt"].is_string(),
        "the child archive persists"
    );
    let record: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", parent)])
        .unwrap();
    assert!(record["archivedAt"].is_null(), "the parent stays active");
}
