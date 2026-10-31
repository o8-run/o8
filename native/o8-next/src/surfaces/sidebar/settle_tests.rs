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
            l.scroll.scroll_to_item(index, ScrollStrategy::Center);
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
fn start(
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
