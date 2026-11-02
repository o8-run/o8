//! The Inbox view through the real view menu, row control, Mod+Shift+S and
//! the Undo toast, against the fixture's copy of the inbox settlement
//! contract; and the unchanged sidebar on a host without it.
use super::scope_tests::project;
use super::*;

const FIRST: &str = "thoughts-composer-first";
const SECOND: &str = "thoughts-composer-second";
const SETTLE_KEY: &str = if cfg!(target_os = "macos") {
    "cmd-shift-s"
} else {
    "ctrl-shift-s"
};

fn list<R>(shell: &Entity<Shell>, cx: &VisualTestContext, read: impl Fn(&ThreadList) -> R) -> R {
    shell.read_with(cx, |s, cx| {
        read(s.surfaces.sidebar.view.as_ref().unwrap().read(cx))
    })
}
/// The section heading above a thread's row.
fn section(list: &ThreadList, id: &str) -> Option<String> {
    let mut heading = None;
    for row in list.rows.iter() {
        if row.kind == "section" {
            heading = Some(row.title.clone());
        } else if row.id.as_deref() == Some(id) {
            return heading;
        }
    }
    None
}
fn in_section(shell: &Shell, cx: &App, id: &str, name: &str) -> bool {
    section(shell.surfaces.sidebar.view.as_ref().unwrap().read(cx), id).as_deref() == Some(name)
}
/// The thread's row, scrolled into the painted part of the list.
fn row(shell: &Entity<Shell>, cx: &mut VisualTestContext, id: &str) -> &'static str {
    let index = list(shell, cx, |l| {
        l.rows.iter().position(|r| r.id.as_deref() == Some(id))
    })
    .unwrap_or_else(|| panic!("{id} is listed"));
    shell.update(cx, |s, cx| {
        let sidebar = s.surfaces.sidebar.view.clone().unwrap();
        sidebar.update(cx, |l, cx| {
            l.scroll_row(index, ScrollStrategy::Center, false);
            cx.notify();
        });
    });
    draw(cx);
    Box::leak(format!("thread-row-{index}").into_boxed_str())
}
/// What the server holds, read back through the listing the sidebar uses;
/// the fixture's 2000 sidebar threads span several pages.
fn stored(fixture: &Fixture, id: &str) -> Value {
    for offset in (0..).step_by(500) {
        let listed: Value = fixture
            .client
            .get(
                "/api/mobile/orchestrator/threads",
                &[("limit", "500"), ("offset", &offset.to_string())],
            )
            .unwrap();
        let page = listed["threads"].as_array().unwrap();
        if let Some(thread) = page.iter().find(|t| t["id"] == id) {
            return thread["settledOverride"].clone();
        }
        assert_eq!(page.len(), 500, "{id} is listed");
    }
    unreachable!()
}
/// Whether the shell shows the Settled toast.
fn settled_toast(shell: &Entity<Shell>, cx: &VisualTestContext) -> bool {
    shell.read_with(cx, |_, cx| {
        crate::shell::toasts::texts(cx)
            .iter()
            .any(|text| text == "Settled 1 thread")
    })
}
/// The thread whose row lies under a point of the window.
fn under(
    shell: &Entity<Shell>,
    cx: &mut VisualTestContext,
    at: gpui::Point<gpui::Pixels>,
) -> Option<String> {
    let rows = list(shell, cx, |l| l.rows.len());
    (0..rows).find_map(|i| {
        let selector = Box::leak(format!("thread-row-{i}").into_boxed_str());
        cx.debug_bounds(selector)
            .filter(|b| b.contains(&at))
            .and_then(|_| list(shell, cx, |l| l.rows[i].id.clone()))
    })
}
pub(super) fn start(
    args: &str,
    cx: &mut TestAppContext,
) -> (Fixture, Entity<Shell>, VisualTestContext, String) {
    let fixture = Fixture::start_mode(true, args);
    let repo = fixture
        .client
        .get::<Value>("/api/v2/chat-history", &[("tabId", FIRST)])
        .unwrap()["repoPath"]
        .as_str()
        .unwrap()
        .to_owned();
    let id = project(&fixture, &[repo]);
    let file = fixture.root.join("inbox.json");
    let (shell, mut visual) = open(fixture.client.clone(), file, State::default(), cx);
    wait_for(&shell, &mut visual, |s, _| s.connected);
    wait_for(&shell, &mut visual, |s, cx| {
        let list = s.surfaces.sidebar.view.as_ref().unwrap().read(cx);
        [FIRST, SECOND]
            .iter()
            .all(|id| list.rows.iter().any(|r| r.id.as_deref() == Some(*id)))
    });
    (fixture, shell, visual, id)
}

#[gpui::test]
fn sidebar_inbox_settles_advances_and_undoes(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, project) = start("--shell --composer --sidebar", cx);
    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-inbox");
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_view.get(&project).map(String::as_str) == Some("inbox")
    });
    draw(&mut visual);
    assert_eq!(list(&shell, &visual, |l| l.rows[0].title.clone()), "Active");
    for id in [FIRST, SECOND] {
        assert_eq!(
            list(&shell, &visual, |l| section(l, id)).as_deref(),
            Some("Active")
        );
    }
    assert!(list(&shell, &visual, |l| !l
        .rows
        .iter()
        .any(|r| r.title == "Settled")));

    // The row's Settle: the open thread moves to Settled, the Active thread
    // in its place opens, and Undo returns it.
    let target = row(&shell, &mut visual, FIRST);
    click(&mut visual, target);
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .selected
            .as_deref()
            == Some(FIRST)
    });
    let next = list(&shell, &visual, |l| {
        let at = l
            .rows
            .iter()
            .position(|r| r.id.as_deref() == Some(FIRST))
            .unwrap();
        let end = l
            .rows
            .iter()
            .skip(1)
            .position(|r| r.kind == "section")
            .map_or(l.rows.len(), |e| e + 1);
        l.rows[..end]
            .iter()
            .enumerate()
            .filter(|(i, r)| r.id.is_some() && *i != at)
            .find(|(i, _)| *i > at)
            .or_else(|| {
                l.rows[..at]
                    .iter()
                    .enumerate()
                    .rev()
                    .find(|(_, r)| r.id.is_some())
            })
            .and_then(|(_, r)| r.id.clone())
            .unwrap()
    });
    let target = row(&shell, &mut visual, FIRST);
    let at = visual.debug_bounds(target).unwrap().center();
    visual.simulate_mouse_move(at, None, gpui::Modifiers::default());
    click(
        &mut visual,
        Box::leak(format!("thread-settle-{FIRST}").into_boxed_str()),
    );
    wait_for(&shell, &mut visual, |s, cx| {
        in_section(s, cx, FIRST, "Settled")
            && s.surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .read(cx)
                .selected
                .as_deref()
                == Some(next.as_str())
    });
    assert_eq!(stored(&fixture, FIRST), "settled");
    // The PATCH also streams the thread, without inbox fields; the row stays.
    for _ in 0..20 {
        settle(&shell, &mut visual);
        assert!(shell.read_with(&visual, |s, cx| in_section(s, cx, FIRST, "Settled")));
        std::thread::sleep(Duration::from_millis(25));
    }
    let toast = list(&shell, &visual, |l| l.undo_toast()).expect("Settled 1 thread, with Undo");
    assert!(settled_toast(&shell, &visual));
    click(
        &mut visual,
        Box::leak(format!("toast-{toast}-action-0").into_boxed_str()),
    );
    wait_for(&shell, &mut visual, |s, cx| {
        in_section(s, cx, FIRST, "Active")
    });
    assert_eq!(stored(&fixture, FIRST), "active");
    assert!(!settled_toast(&shell, &visual));

    // Mod+Shift+S settles the current thread; on a settled one it un-settles.
    let target = row(&shell, &mut visual, SECOND);
    click(&mut visual, target);
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .selected
            .as_deref()
            == Some(SECOND)
    });
    visual.simulate_keystrokes(SETTLE_KEY);
    wait_for(&shell, &mut visual, |s, cx| {
        in_section(s, cx, SECOND, "Settled")
    });
    assert_eq!(stored(&fixture, SECOND), "settled");
    assert_ne!(
        list(&shell, &visual, |l| l.selected.clone()).as_deref(),
        Some(SECOND)
    );
    let target = row(&shell, &mut visual, SECOND);
    click(&mut visual, target);
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .selected
            .as_deref()
            == Some(SECOND)
    });
    visual.simulate_keystrokes(SETTLE_KEY);
    wait_for(&shell, &mut visual, |s, cx| {
        in_section(s, cx, SECOND, "Active")
    });
    assert_eq!(stored(&fixture, SECOND), "active");
    // Un-settling keeps the thread open where it is.
    assert_eq!(
        list(&shell, &visual, |l| l.selected.clone()).as_deref(),
        Some(SECOND)
    );
}

#[gpui::test]
fn sidebar_view_menu_takes_the_press_over_inbox_rows(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, project) = start("--shell --composer --sidebar", cx);
    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-inbox");
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_view.get(&project).map(String::as_str) == Some("inbox")
    });
    let target = row(&shell, &mut visual, SECOND);
    click(&mut visual, target);
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .selected
            .as_deref()
            == Some(SECOND)
    });
    shell.update(&mut visual, |s, cx| {
        let sidebar = s.surfaces.sidebar.view.clone().unwrap();
        sidebar.update(cx, |l, cx| {
            l.scroll.scroll_to_item(0, ScrollStrategy::Top);
            cx.notify();
        });
    });
    click(&mut visual, "sidebar-view");
    draw(&mut visual);

    // An item with another Active thread's row beneath it, pressed where
    // that row's Settle sits when the item spans it.
    let mut pick = None;
    for key in ["chronological", "repo", "date"] {
        let selector = Box::leak(format!("sidebar-view-{key}").into_boxed_str());
        let Some(bounds) = visual.debug_bounds(selector) else {
            continue;
        };
        if let Some(id) = under(&shell, &mut visual, bounds.center()).filter(|id| id != SECOND) {
            pick = Some((bounds, id));
            break;
        }
    }
    let (item, id) = pick.expect("the open menu covers another Active row");
    let check = Box::leak(format!("thread-settle-{id}").into_boxed_str());
    let mut at = item.center();
    if let Some(check) = visual.debug_bounds(check)
        && item.left() < check.center().x
        && check.center().x < item.right()
    {
        at.x = check.center().x;
    }
    let before = stored(&fixture, &id);
    visual.simulate_mouse_move(at, None, gpui::Modifiers::default());
    draw(&mut visual);
    visual.simulate_click(at, gpui::Modifiers::default());
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_view.get(&project).map(String::as_str) != Some("inbox")
    });
    draw(&mut visual);
    assert!(visual.debug_bounds("sidebar-view-menu").is_none());
    assert_eq!(
        list(&shell, &visual, |l| l.selected.clone()).as_deref(),
        Some(SECOND),
        "the row beneath the menu was not opened"
    );
    assert_eq!(stored(&fixture, &id), before, "nor settled");
    assert!(!settled_toast(&shell, &visual));
}

#[gpui::test]
fn sidebar_without_inbox_settlement_is_unchanged(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual, project) =
        start("--shell --composer --sidebar --sidebar-before-inbox", cx);
    // A saved Inbox choice falls back to the default view on this host.
    shell.update(&mut visual, |s, cx| {
        let sidebar = s.surfaces.sidebar.view.clone().unwrap();
        let views = [(project.clone(), "inbox".to_owned())]
            .into_iter()
            .collect();
        sidebar.update(cx, |l, cx| {
            l.restore_views(&views, &Default::default());
            cx.notify();
        });
    });
    draw(&mut visual);
    assert_eq!(
        list(&shell, &visual, |l| l.rows[0].title.clone()),
        "Recents"
    );
    click(&mut visual, "sidebar-view");
    draw(&mut visual);
    assert!(visual.debug_bounds("sidebar-view-chronological").is_some());
    assert!(
        visual.debug_bounds("sidebar-view-inbox").is_none(),
        "no Inbox without settlement"
    );
    visual.simulate_keystrokes("escape");
    let target = row(&shell, &mut visual, FIRST);
    let at = visual.debug_bounds(target).unwrap().center();
    visual.simulate_mouse_move(at, None, gpui::Modifiers::default());
    draw(&mut visual);
    assert!(
        visual
            .debug_bounds(Box::leak(format!("thread-settle-{FIRST}").into_boxed_str()))
            .is_none()
    );
}

#[gpui::test]
fn sidebar_inbox_mod_z_undoes_the_last_settle(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, project) = start("--shell --composer --sidebar", cx);
    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-inbox");
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_view.get(&project).map(String::as_str) == Some("inbox")
    });
    draw(&mut visual);
    let target = row(&shell, &mut visual, FIRST);
    let at = visual.debug_bounds(target).unwrap().center();
    visual.simulate_mouse_move(at, None, gpui::Modifiers::default());
    click(
        &mut visual,
        Box::leak(format!("thread-settle-{FIRST}").into_boxed_str()),
    );
    wait_for(&shell, &mut visual, |s, cx| in_section(s, cx, FIRST, "Settled"));
    assert_eq!(stored(&fixture, FIRST), "settled");
    assert!(settled_toast(&shell, &visual));
    let undo = if cfg!(target_os = "macos") { "cmd-z" } else { "ctrl-z" };
    visual.simulate_keystrokes(undo);
    wait_for(&shell, &mut visual, |s, cx| in_section(s, cx, FIRST, "Active"));
    assert_eq!(stored(&fixture, FIRST), "active");
    assert!(!settled_toast(&shell, &visual));
    // With nothing left to undo, the key is not swallowed and changes nothing.
    visual.simulate_keystrokes(undo);
    settle(&shell, &mut visual);
    assert_eq!(stored(&fixture, FIRST), "active");
}

#[gpui::test]
fn sidebar_inbox_vocabulary_keeps_merge_outcome_separate_from_attention(cx: &mut TestAppContext) {
    const MERGED: &str = "thoughts-sidebar-0019";
    let (fixture, shell, mut visual, project) = start(
        "--shell --composer --sidebar --sidebar-markers --sidebar-merged",
        cx,
    );
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces.sidebar.view.as_ref().unwrap().read(cx).sessions.iter().any(|session| {
            session.id == MERGED && session.outcome.as_deref() == Some("merged") && !session.settled()
        })
    });
    let before: Value = fixture.client.get("/api/orchestrator/state", &[]).unwrap();
    let packets = before["mission"]["packets"].as_array().expect("persisted packet array");
    assert!(!packets.is_empty(), "the fixture has a real packet to preserve");
    let packet = packets.iter().find(|packet| packet["id"] == "sidebar-branch").unwrap();
    assert_eq!(packet["status"], "released");
    assert_eq!(packet["releaseState"], "released");
    assert_eq!(packet["releaseStatePayload"]["source"], "approve_and_merge");
    let history: Value = fixture.client.get("/api/v2/chat-history", &[("tabId", MERGED)]).unwrap();
    let messages = history["messages"].as_array().expect("persisted history message array");
    assert_eq!(messages.len(), 2, "the fixture history must exist before Settle");

    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-inbox");
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_view.get(&project).map(String::as_str) == Some("inbox")
    });
    // Searching opens every shelf and exposes this older row through the real editor.
    visual.simulate_keystrokes("ctrl-f");
    visual.simulate_input("Sidebar thread 19");
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces.sidebar.view.as_ref().unwrap().read(cx).rows.iter()
            .any(|row| row.id.as_deref() == Some(MERGED))
    });
    draw(&mut visual);
    assert_eq!(
        list(&shell, &visual, |list| section(list, MERGED)).as_deref(),
        Some("Active"),
        "a merge outcome must not create a fifth thread attention state"
    );
    assert!(list(&shell, &visual, |list| list.rows.iter()
        .filter(|row| row.kind == "section")
        .all(|row| matches!(row.title.as_str(), "Active" | "Snoozed" | "Settled" | "Archived"))));

    let target = row(&shell, &mut visual, MERGED);
    let at = visual.debug_bounds(target).unwrap().center();
    visual.simulate_mouse_move(at, None, gpui::Modifiers::default());
    click(&mut visual, Box::leak(format!("thread-settle-{MERGED}").into_boxed_str()));
    wait_for(&shell, &mut visual, |s, cx| in_section(s, cx, MERGED, "Settled"));
    assert_eq!(stored(&fixture, MERGED), "settled");
    let after: Value = fixture.client.get("/api/orchestrator/state", &[]).unwrap();
    let mut after_packets = after["mission"]["packets"].as_array().expect("persisted packets after Settle").clone();
    let after_packet = after_packets.iter_mut().find(|packet| packet["id"] == "sidebar-branch")
        .expect("the same merged packet after Settle");
    // The state read normalizer regenerates only this routing timestamp.
    assert!(packet["workerRouting"]["decidedAt"].is_string());
    assert!(after_packet["workerRouting"]["decidedAt"].is_string());
    after_packet["workerRouting"]["decidedAt"] = packet["workerRouting"]["decidedAt"].clone();
    assert_eq!(&after_packets, packets,
        "settling attention must preserve packet execution and release state");
    let settled: Value = fixture.client.get("/api/v2/chat-history", &[("tabId", MERGED)]).unwrap();
    assert_eq!(settled["archivedAt"], history["archivedAt"]);
    assert_eq!(settled["messages"].as_array().expect("persisted history after Settle"), messages);

    // F8 uses the real list-focus action, leaving the search editor's own Undo.
    visual.simulate_keystrokes("f8");
    let undo = if cfg!(target_os = "macos") { "cmd-z" } else { "ctrl-z" };
    visual.simulate_keystrokes(undo);
    wait_for(&shell, &mut visual, |s, cx| in_section(s, cx, MERGED, "Active"));
    assert_eq!(stored(&fixture, MERGED), "active");
    assert!(list(&shell, &visual, |list| list.sessions.iter().any(|session| {
        session.id == MERGED && session.outcome.as_deref() == Some("merged")
    })));
}

/// What the server settles on its own while the app is open: the toast with
/// Undo, the "merged · age" note on the Settled row, and Mod+Z from a click
/// on the list's own surface, with no row opened first.
#[gpui::test]
fn sidebar_announces_server_auto_settle_with_note_and_mod_z(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, project) =
        start("--shell --composer --sidebar --sidebar-auto-settle", cx);
    // Detailed rows, the app's usual look, show the note beside the badge.
    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-detailed");
    wait_for(&shell, &mut visual, |s, _| s.state.sidebar_detailed_rows);
    draw(&mut visual);
    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-inbox");
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_view.get(&project).map(String::as_str) == Some("inbox")
    });
    draw(&mut visual);
    wait_for(&shell, &mut visual, |s, cx| in_section(s, cx, FIRST, "Active"));
    let settled: Value = fixture
        .client
        .get("/api/sidebar-fixture/auto-settle", &[("tabId", FIRST)])
        .unwrap();
    assert_eq!(settled["settled"], true);
    shell.update(&mut visual, |s, cx| {
        let sidebar = s.surfaces.sidebar.view.clone().unwrap();
        sidebar.update(cx, |l, cx| l.load(cx));
    });
    wait_for(&shell, &mut visual, |s, cx| in_section(s, cx, FIRST, "Settled"));
    assert_eq!(stored(&fixture, FIRST), "settled");
    let toast = shell.read_with(&visual, |_, cx| {
        crate::shell::toasts::texts(cx)
            .iter()
            .any(|text| text.starts_with("Auto-settled"))
    });
    assert!(toast, "the server's settle is announced");
    let age = list(&shell, &visual, |l| {
        l.rows
            .iter()
            .find(|r| r.id.as_deref() == Some(FIRST))
            .map(|r| r.age.clone())
    })
    .unwrap();
    assert!(age.starts_with("merged · "), "{age}");
    let index = list(&shell, &visual, |l| {
        l.rows.iter().position(|r| r.id.as_deref() == Some(FIRST))
    })
    .unwrap();
    shell.update(&mut visual, |s, cx| {
        let sidebar = s.surfaces.sidebar.view.clone().unwrap();
        sidebar.update(cx, |l, cx| {
            l.scroll_row(index, ScrollStrategy::Center, false);
            cx.notify();
        });
    });
    draw(&mut visual);
    draw(&mut visual);
    assert!(
        visual
            .debug_bounds(Box::leak(format!("thread-auto-note-{FIRST}").into_boxed_str()))
            .is_some(),
        "the detailed row renders the note"
    );
    // A click on the list's surface, not a row, then Mod+Z.
    let bounds = visual.debug_bounds("thread-sidebar").unwrap();
    let at = gpui::point(bounds.origin.x + gpui::px(2.), bounds.origin.y + gpui::px(2.));
    visual.simulate_mouse_down(at, gpui::MouseButton::Left, gpui::Modifiers::default());
    visual.simulate_mouse_up(at, gpui::MouseButton::Left, gpui::Modifiers::default());
    draw(&mut visual);
    let undo = if cfg!(target_os = "macos") { "cmd-z" } else { "ctrl-z" };
    visual.simulate_keystrokes(undo);
    wait_for(&shell, &mut visual, |s, cx| in_section(s, cx, FIRST, "Active"));
    assert_eq!(stored(&fixture, FIRST), "active");
}

/// The row menu turns this thread's auto-settle off (the server records the
/// opt-out) and back on; a thread with it off carries a mark.
#[gpui::test]
fn sidebar_row_menu_toggles_per_thread_auto_settle(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, _project) = start("--shell --composer --sidebar", cx);
    let opted_out = |fixture: &Fixture| {
        for offset in (0..).step_by(500) {
            let listed: Value = fixture
                .client
                .get(
                    "/api/mobile/orchestrator/threads",
                    &[("limit", "500"), ("offset", &offset.to_string())],
                )
                .unwrap();
            let page = listed["threads"].as_array().unwrap();
            if let Some(thread) = page.iter().find(|t| t["id"] == FIRST) {
                return thread["autoSettleDisabledAt"].is_string();
            }
            assert_eq!(page.len(), 500);
        }
        unreachable!()
    };
    let mark: &'static str = Box::leak(format!("thread-auto-off-{FIRST}").into_boxed_str());
    for off in [true, false] {
        let target = row(&shell, &mut visual, FIRST);
        let at = visual.debug_bounds(target).unwrap().center();
        visual.simulate_mouse_down(at, gpui::MouseButton::Right, gpui::Modifiers::default());
        visual.simulate_mouse_up(at, gpui::MouseButton::Right, gpui::Modifiers::default());
        draw(&mut visual);
        click(&mut visual, "sidebar-row-auto-settle");
        wait_for(&shell, &mut visual, |s, cx| {
            s.surfaces.sidebar.view.as_ref().unwrap().read(cx).auto_settle_off(FIRST) == off
        });
        assert_eq!(opted_out(&fixture), off);
        row(&shell, &mut visual, FIRST);
        draw(&mut visual);
        assert_eq!(visual.debug_bounds(mark).is_some(), off);
    }
}

#[gpui::test]
fn sidebar_auto_settle_undo_already_active_never_settles(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, project) =
        start("--shell --composer --sidebar --sidebar-auto-settle", cx);
    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-inbox");
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_view.get(&project).map(String::as_str) == Some("inbox")
    });
    fixture
        .client
        .get::<Value>("/api/sidebar-fixture/auto-settle", &[("tabId", FIRST)])
        .unwrap();
    shell.update(&mut visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .clone()
            .unwrap()
            .update(cx, |l, cx| l.load(cx));
    });
    wait_for(&shell, &mut visual, |s, cx| {
        in_section(s, cx, FIRST, "Settled")
    });
    let toast = list(&shell, &visual, |l| l.undo_toast()).expect("automatic Undo");
    // Another client restores the thread while the old automatic toast remains.
    let workspace = list(&shell, &visual, |l| {
        l.sessions
            .iter()
            .find(|s| s.id == FIRST)
            .unwrap()
            .repo_path
            .clone()
    })
    .expect("fixture workspace");
    fixture
        .client
        .inbox_action(Some(&workspace), FIRST, "unsettle")
        .unwrap();
    shell.update(&mut visual, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .clone()
            .unwrap()
            .update(cx, |l, cx| l.load(cx));
    });
    wait_for(&shell, &mut visual, |s, cx| {
        in_section(s, cx, FIRST, "Active")
    });
    let generation = list(&shell, &visual, |l| {
        l.diagnostic()["generation"].as_u64().unwrap()
    });
    click(
        &mut visual,
        Box::leak(format!("toast-{toast}-action-0").into_boxed_str()),
    );
    wait_for(&shell, &mut visual, |s, cx| {
        let state = s
            .surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .diagnostic();
        state["generation"]
            .as_u64()
            .is_some_and(|next| next > generation)
            && state["loading"] == false
    });
    assert_eq!(
        stored(&fixture, FIRST),
        "active",
        "Undo is idempotent after an independent restore"
    );
    let actions: Vec<String> = fixture
        .client
        .get("/api/sidebar-fixture/auto-settle-actions", &[])
        .unwrap();
    assert!(
        !actions.iter().any(|action| action == "settle"),
        "Undo must never send settle: {actions:?}"
    );
}

fn parking_view(cx: &mut TestAppContext, flags: &str, section_name: &str) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let (fixture, shell, mut visual, project) = start(
        &format!("--shell --composer --sidebar --sidebar-markers --sidebar-merged --sidebar-parked{flags}"), cx,
    );
    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-detailed");
    wait_for(&shell, &mut visual, |s, _| s.state.sidebar_detailed_rows);
    draw(&mut visual);
    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-inbox");
    wait_for(&shell, &mut visual, |s, _| {
        s.state.sidebar_view.get(&project).map(String::as_str) == Some("inbox")
    });
    visual.simulate_keystrokes("ctrl-f");
    visual.simulate_input("Sidebar thread 19");
    wait_for(&shell, &mut visual, |s, cx| in_section(s, cx, "thoughts-sidebar-0019", section_name));
    (fixture, shell, visual)
}

fn parked_row(cx: &mut TestAppContext, bytes: Option<i64>) {
    const ID: &str = "thoughts-sidebar-0019";
    let flags = match bytes { None => " --sidebar-parked-unknown", Some(0) => " --sidebar-parked-zero",
        Some(-1024) => " --sidebar-parked-negative", _ => "" };
    let (fixture, shell, mut visual) = parking_view(cx, flags, "Settled");
    let oracle: Value = fixture.client.get("/api/sidebar-fixture/parking", &[]).unwrap();
    assert_parking_owner(&oracle);
    assert_eq!(oracle["completedOwner"], true);
    assert_eq!(oracle["listed"]["parkedWorkspaces"], json!([{
        "packetId": "sidebar-branch", "repositoryUuid": "sidebar-parked-repo", "reclaimedAvailableBytes": bytes,
    }]));
    assert_eq!(oracle["snapshot"]["state"], "parked");
    assert_eq!(oracle["workspaceRestores"], json!([]));
    let receipt = oracle["transitions"].as_array().unwrap().iter()
        .find(|transition| transition["toState"] == "parked").unwrap();
    assert_eq!(receipt["receipt"]["reclaimedAvailableBytes"].as_i64(), bytes);
    let target = row(&shell, &mut visual, ID);
    assert!(visual.debug_bounds("thread-workspace-parked-thoughts-sidebar-0019").is_some(),
        "the settled row must paint its parked workspace detail");
    let detail = match bytes {
        None => "thread-workspace-freed-unknown-thoughts-sidebar-0019",
        Some(0) => "thread-workspace-freed-0-thoughts-sidebar-0019",
        Some(-1024) => "thread-workspace-freed--1024-thoughts-sidebar-0019",
        Some(2_147_483_648) => "thread-workspace-freed-2147483648-thoughts-sidebar-0019",
        Some(value) => panic!("unexpected fixture bytes: {value}"),
    };
    assert!(visual.debug_bounds(detail).is_some(),
        "the detail must distinguish observed bytes from unknown accounting");

    let at = visual.debug_bounds(target).unwrap().center();
    visual.simulate_mouse_move(at, None, gpui::Modifiers::default());
    click(&mut visual, "thread-settle-thoughts-sidebar-0019");
    wait_for(&shell, &mut visual, |s, cx| in_section(s, cx, ID, "Active"));
    assert_eq!(stored(&fixture, ID), "active");
    let untouched: Value = fixture.client.get("/api/sidebar-fixture/parking", &[]).unwrap();
    assert_eq!(untouched["snapshot"], oracle["snapshot"], "Unsettle is metadata only");
    assert_eq!(untouched["workspaceRestores"], json!([]), "Unsettle never asks to restore");

    // Explicit workspace Restore is distinct from the existing archive Restore.
    let target = row(&shell, &mut visual, ID);
    let at = visual.debug_bounds(target).unwrap().center();
    visual.simulate_mouse_down(at, gpui::MouseButton::Right, gpui::Modifiers::default());
    visual.simulate_mouse_up(at, gpui::MouseButton::Right, gpui::Modifiers::default());
    draw(&mut visual);
    assert!(visual.debug_bounds("sidebar-row-workspace-restore-sidebar-branch").is_some());
    click(&mut visual, "sidebar-row-workspace-restore-sidebar-branch");
    wait_for(&shell, &mut visual, |_, _| {
        fixture.client.get::<Value>("/api/sidebar-fixture/parking", &[])
            .is_ok_and(|state| state["workspaceRestores"].as_array().is_some_and(|requests| requests.len() == 1))
    });
    settle(&shell, &mut visual);
    let requested: Value = fixture.client.get("/api/sidebar-fixture/parking", &[]).unwrap();
    let restores = requested["workspaceRestores"].as_array().unwrap();
    assert_eq!(restores.len(), 1);
    assert_eq!(restores[0]["action"], "restore");
    assert_eq!(restores[0]["packetId"], "sidebar-branch");
    assert!(restores[0]["clientMutationId"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(restores[0]["archivedAt"].is_null());
    assert_eq!(requested["snapshot"], oracle["snapshot"], "the held restore cannot claim success");
    assert_eq!(stored(&fixture, ID), "active");
    let history: Value = fixture.client.get("/api/v2/chat-history", &[("tabId", ID)]).unwrap();
    assert!(history["archivedAt"].is_null());
    assert_eq!(history["messages"].as_array().unwrap().len(), 2);
}

fn assert_parking_owner(oracle: &Value) {
    assert_eq!(oracle["packet"]["status"], "released");
    assert_eq!(oracle["packet"]["releaseState"], "released");
    assert_eq!(oracle["packet"]["queueState"], "held");
    assert_eq!(oracle["packet"]["releaseStatePayload"]["source"], "approve_and_merge");
    assert_eq!(oracle["lane"]["status"], "completed");
    assert_eq!(oracle["lane"]["ownership"], "managed");
    assert_eq!(oracle["packet"]["id"], oracle["lane"]["packetId"]);
    assert_eq!(oracle["packet"]["runtime"], oracle["lane"]["runtime"]);
    assert_eq!(oracle["packet"]["lane"]["laneId"], oracle["lane"]["id"]);
    assert_eq!(oracle["packet"]["lane"]["sessionKey"], oracle["lane"]["sessionKey"]);
    assert_eq!(oracle["packet"]["lane"]["repoPath"], oracle["lane"]["repoPath"]);
    assert_eq!(oracle["packet"]["lane"]["worktreePath"], oracle["snapshot"]["originalPath"]);
    assert_eq!(oracle["snapshot"]["laneId"], oracle["lane"]["id"]);
}

#[gpui::test]
fn sidebar_parked_workspace_shows_receipt_and_restores_only_by_explicit_menu(cx: &mut TestAppContext) {
    parked_row(cx, Some(2_147_483_648));
}

#[gpui::test]
fn sidebar_parked_workspace_keeps_missing_freed_bytes_unknown(cx: &mut TestAppContext) {
    parked_row(cx, None);
}

#[gpui::test]
fn sidebar_parked_workspace_keeps_known_zero_bytes(cx: &mut TestAppContext) {
    parked_row(cx, Some(0));
}

#[gpui::test]
fn sidebar_parked_workspace_accepts_signed_space_receipts(cx: &mut TestAppContext) {
    parked_row(cx, Some(-1024));
}

#[gpui::test]
fn sidebar_parked_workspace_refreshes_after_delayed_completion(cx: &mut TestAppContext) {
    const ID: &str = "thoughts-sidebar-0019";
    let (fixture, shell, mut visual) = parking_view(cx, " --sidebar-parking-pending", "Active");
    let target = row(&shell, &mut visual, ID);
    let at = visual.debug_bounds(target).unwrap().center();
    visual.simulate_mouse_move(at, None, gpui::Modifiers::default());
    click(&mut visual, "thread-settle-thoughts-sidebar-0019");
    wait_for(&shell, &mut visual, |s, cx| in_section(s, cx, ID, "Settled"));
    wait_for(&shell, &mut visual, |s, cx| {
        let state = s.surfaces.sidebar.view.as_ref().unwrap().read(cx).diagnostic();
        state["loading"] == false && state["dirty"] == false && state["settling"] == false
    });
    assert_eq!(stored(&fixture, ID), "settled", "Settle must answer before parking finishes");
    let before: Value = fixture.client.get("/api/sidebar-fixture/parking", &[]).unwrap();
    assert_parking_owner(&before);
    assert_eq!(before["completedOwner"], false);
    assert_eq!(before["snapshot"]["state"], "materialized");
    assert!(before["listed"]["parkedWorkspaces"].is_null());
    assert!(list(&shell, &visual, |l| l.sessions.iter().find(|s| s.id == ID).unwrap().parked_workspaces.is_empty()));

    // This completes a real canonical receipt and emits only the production
    // completed parking mutation, after the ordinary Settle response.
    let completed: Value = fixture.client.get("/api/sidebar-fixture/parking-complete", &[]).unwrap();
    assert_eq!(completed["snapshot"]["state"], "parked");
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces.sidebar.view.as_ref().unwrap().read(cx).sessions.iter()
            .find(|s| s.id == ID).is_some_and(|s| s.parked_workspaces.len() == 1)
    });
    row(&shell, &mut visual, ID);
    assert!(visual.debug_bounds("thread-workspace-freed-2147483648-thoughts-sidebar-0019").is_some(),
        "the completed mutation must paint the authoritative receipt without the 300-second fallback");
    let after: Value = fixture.client.get("/api/sidebar-fixture/parking", &[]).unwrap();
    assert_parking_owner(&after);
    assert_eq!(after["completedOwner"], true);
    assert_eq!(after["listed"]["parkedWorkspaces"][0]["reclaimedAvailableBytes"], 2_147_483_648_i64);
    assert_eq!(after["workspaceRestores"], json!([]));
}

#[gpui::test]
fn sidebar_parked_runtime_keeps_receipt_and_restore_after_inventory_refresh(cx: &mut TestAppContext) {
    const ID: &str = "pi-builtin-owned:grid-runtime";
    let (fixture, shell, mut visual, _) = start(
        "--shell --composer --sidebar --sidebar-markers --sidebar-merged --sidebar-parked --sidebar-parked-runtime --sidebar-parked-negative", cx,
    );
    click(&mut visual, "sidebar-view");
    click(&mut visual, "sidebar-view-detailed");
    wait_for(&shell, &mut visual, |s, _| s.state.sidebar_detailed_rows);
    visual.simulate_keystrokes("ctrl-f");
    visual.simulate_input("Grid runtime worker");
    wait_for(&shell, &mut visual, |s, cx| {
        let list = s.surfaces.sidebar.view.as_ref().unwrap().read(cx);
        list.rows.iter().any(|row| row.id.as_deref() == Some(ID))
            && list.diagnostic()["loading"] == false && list.diagnostic()["dirty"] == false
            && list.diagnostic()["inventoryLoading"] == false
    });
    let oracle: Value = fixture.client.get("/api/sidebar-fixture/parking", &[]).unwrap();
    assert_parking_owner(&oracle);
    assert_eq!(oracle["completedOwner"], true);
    assert_eq!(oracle["listed"]["inboxSubject"]["kind"], "runtime");
    assert_eq!(oracle["listed"]["inboxSubject"]["id"], ID);
    assert!(oracle["listed"]["parentInboxSubject"].is_null());
    assert_eq!(oracle["listed"]["parkedWorkspaces"], json!([{
        "packetId": "sidebar-branch", "repositoryUuid": "sidebar-parked-repo", "reclaimedAvailableBytes": -1024,
    }]));
    let expected = list(&shell, &visual, |l| l.sessions.iter().find(|s| s.id == ID).unwrap().parked_workspaces.clone());
    assert_eq!(expected.len(), 1);
    assert_eq!(expected[0].reclaimed_available_bytes, Some(-1024));
    row(&shell, &mut visual, ID);
    assert!(visual.debug_bounds("thread-workspace-freed--1024-pi-builtin-owned:grid-runtime").is_some());
    let generation = list(&shell, &visual, |l| l.diagnostic()["generation"].clone());
    shell.update(&mut visual, |s, cx| {
        s.surfaces.sidebar.view.clone().unwrap().update(cx, |l, cx| {
            l.expire_inventory_cadence();
            l.tick(cx);
            assert_eq!(l.diagnostic()["inventoryLoading"], true, "the ordinary cadence must launch its inventory request");
        });
    });
    wait_for(&shell, &mut visual, |s, cx| {
        s.surfaces.sidebar.view.as_ref().unwrap().read(cx).diagnostic()["inventoryLoading"] == false
    });
    assert_eq!(list(&shell, &visual, |l| l.diagnostic()["generation"].clone()), generation,
        "a full listing reload must not mask the inventory adapter");
    assert_eq!(list(&shell, &visual, |l| l.sessions.iter().find(|s| s.id == ID).unwrap().parked_workspaces.clone()), expected);
    let target = row(&shell, &mut visual, ID);
    assert!(visual.debug_bounds("thread-workspace-parked-pi-builtin-owned:grid-runtime").is_some());
    assert!(visual.debug_bounds("thread-workspace-freed--1024-pi-builtin-owned:grid-runtime").is_some());
    let at = visual.debug_bounds(target).unwrap().center();
    visual.simulate_mouse_down(at, gpui::MouseButton::Right, gpui::Modifiers::default());
    visual.simulate_mouse_up(at, gpui::MouseButton::Right, gpui::Modifiers::default());
    click(&mut visual, "sidebar-row-workspace-restore-sidebar-branch");
    wait_for(&shell, &mut visual, |_, _| {
        fixture.client.get::<Value>("/api/sidebar-fixture/parking", &[])
            .is_ok_and(|state| state["workspaceRestores"].as_array().is_some_and(|requests| requests.len() == 1))
    });
    let after: Value = fixture.client.get("/api/sidebar-fixture/parking", &[]).unwrap();
    assert_eq!(after["workspaceRestores"][0]["action"], "restore");
    assert_eq!(after["workspaceRestores"][0]["packetId"], "sidebar-branch");
    assert!(after["workspaceRestores"][0]["clientMutationId"].as_str().is_some_and(|id| !id.is_empty()));
    assert_eq!(after["snapshot"], oracle["snapshot"], "the explicit held request cannot restore the checkout");
}
