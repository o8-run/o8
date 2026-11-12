//! The Working drawer at the foot of the sidebar: the fold, its rows, the
//! keyboard order and the setting, headless.
use super::*;
use gpui::{TestAppContext, VisualTestContext};

fn session(id: &str, status: &str, at: &str) -> Session {
    serde_json::from_value(json!({
        "id": id, "title": format!("Thread {id}"), "status": status,
        "lastMessageAt": at, "repoPath": "/fixture/repo", "messageCount": 2,
        "runStartedAt": "2026-10-01T09:00:00Z",
    }))
    .unwrap()
}

fn sessions() -> Vec<Session> {
    vec![
        session("idle-new", "idle", "2026-10-03T10:00:00Z"),
        session("run", "running", "2026-10-02T10:00:00Z"),
        session("idle-old", "idle", "2026-10-01T10:00:00Z"),
    ]
}

fn make(
    cx: &mut TestAppContext,
    sessions: Vec<Session>,
) -> (Entity<ThreadList>, &mut VisualTestContext) {
    cx.add_window_view(|window, cx| {
        let mut list = ThreadList::new(Client::new("http://127.0.0.1:9").unwrap(), cx);
        list.sessions = sessions;
        list.views.insert(String::new(), folders::View::Date);
        list.rebuild();
        list.focus.focus(window);
        list
    })
}

fn ids(list: &Entity<ThreadList>, cx: &VisualTestContext) -> Vec<String> {
    list.read_with(cx, |list, _| list.rows.iter().filter_map(|r| r.id.clone()).collect())
}

fn drawer(list: &Entity<ThreadList>, cx: &VisualTestContext) -> Option<(String, String)> {
    list.read_with(cx, |list, _| {
        list.rows
            .iter()
            .find(|r| r.kind == "drawer")
            .map(|r| (r.title.clone(), r.age.clone()))
    })
}

fn choice(list: &Entity<ThreadList>, cx: &VisualTestContext) -> Option<String> {
    list.read_with(cx, |list, _| list.choice.clone())
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
        window.refresh();
        window.draw(cx).clear();
    });
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    draw(cx);
    let at = cx.debug_bounds(selector).expect(selector).center();
    cx.simulate_click(at, Default::default());
    draw(cx);
}

fn header(kind: &str, title: &str) -> Row {
    recents::header(kind, title, "")
}

fn thread(id: &str, running: bool) -> Row {
    let mut row = header("thread", id);
    row.id = Some(id.into());
    row.title = id.into();
    row.running = running;
    row
}

fn titles(rows: &[Row]) -> Vec<String> {
    rows.iter().map(|r| r.title.clone()).collect()
}

#[test]
fn fold_moves_running_threads_to_a_drawer_at_the_foot() {
    let rows = vec![
        header("section", "Today"),
        thread("a", false),
        thread("b", true),
        header("section", "Older"),
        thread("c", true),
        header("section", "Archived"),
        thread("d", true),
    ];
    let none = |_: &str| false;
    assert_eq!(
        titles(&detailed::fold_working(rows.clone(), true, none)),
        ["Today", "a", "Archived", "d", "Working", "b", "c"],
        "Older lost its only thread; Archived keeps its own"
    );
    let closed = detailed::fold_working(rows.clone(), false, none);
    assert_eq!(titles(&closed), ["Today", "a", "Archived", "d", "Working"]);
    let foot = closed.last().unwrap();
    assert_eq!((foot.kind.as_str(), foot.age.as_str(), foot.status.as_str()), ("drawer", "2", ""));
    // A run that needs the person stays in its group.
    let asks = |id: &str| id == "c";
    assert_eq!(
        titles(&detailed::fold_working(rows.clone(), true, asks)),
        ["Today", "a", "Older", "c", "Archived", "d", "Working", "b"]
    );
    let mut marked = rows.clone();
    marked[2].marker = "input";
    assert_eq!(titles(&detailed::fold_working(marked, true, none))[..3], ["Today", "a", "b"]);
    // Nothing running: no drawer, no empty state.
    let idle: Vec<_> = rows.into_iter().map(|mut r| { r.running = false; r }).collect();
    assert!(!detailed::fold_working(idle, true, none).iter().any(|r| r.kind == "drawer"));
}

#[test]
fn fold_keeps_the_first_heading_and_moves_nested_children() {
    let mut child = thread("child", false);
    child.depth = 1;
    let rows = vec![header("section", "Chronological"), thread("p", true), child, thread("q", false)];
    let folded = detailed::fold_working(rows, true, |_| false);
    assert_eq!(titles(&folded), ["Chronological", "q", "Working", "p", "child"]);
    let only = vec![header("section", "Chronological"), thread("p", true)];
    assert_eq!(
        titles(&detailed::fold_working(only, false, |_| false)),
        ["Chronological", "Working"],
        "the first heading carries the list's controls"
    );
}

#[gpui::test]
fn sidebar_drawer_is_on_and_closed_by_default(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, sessions());
    assert_eq!(ids(&list, cx), ["idle-new", "idle-old"]);
    assert_eq!(drawer(&list, cx), Some(("Working".into(), "1".into())));
    draw(cx);
    let head = cx.debug_bounds("sidebar-working-header").expect("the closed drawer");
    let side = cx.debug_bounds("thread-sidebar").unwrap();
    assert!(cx.debug_bounds("sidebar-working-dot").is_some());
    assert!(cx.debug_bounds("sidebar-working-rows").is_none(), "closed is one row");
    // Pinned to the foot, under the list.
    assert!(side.bottom() - head.bottom() <= gpui::px(4.), "{head:?} in {side:?}");
}

#[gpui::test]
fn sidebar_drawer_opens_on_click_and_animates(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, sessions());
    click(cx, "sidebar-working-header");
    assert_eq!(ids(&list, cx), ["idle-new", "idle-old", "run"]);
    list.read_with(cx, |list, _| {
        assert!(!list.working_closed);
        assert!(list.drawer_motion.is_some_and(|(_, opening)| opening), "a click animates");
        assert_eq!(list.rows.last().unwrap().id.as_deref(), Some("run"));
    });
    std::thread::sleep(drawer::MOTION + std::time::Duration::from_millis(20));
    draw(cx);
    let rows = cx.debug_bounds("sidebar-working-rows").expect("open rows");
    let head = cx.debug_bounds("sidebar-working-header").unwrap();
    assert!(rows.top() >= head.bottom(), "the threads sit under the header");
    assert!(rows.size.height >= gpui::px(28.), "{rows:?}");
    list.read_with(cx, |list, _| assert!(list.drawer_motion.is_none()));
    // A click on a drawer row opens its thread.
    let index = list.read_with(cx, |list, _| list.rows.len() - 1);
    let selector: &'static str = Box::leak(format!("thread-row-{index}").into_boxed_str());
    click(cx, selector);
    assert_eq!(choice(&list, cx).as_deref(), Some("run"));
    // Closing keeps the rows until the motion ends, then folds them away.
    click(cx, "sidebar-working-header");
    assert_eq!(choice(&list, cx).as_deref(), Some("idle-old"), "the choice leaves");
    assert!(ids(&list, cx).contains(&"run".into()));
    std::thread::sleep(drawer::MOTION + std::time::Duration::from_millis(20));
    draw(cx);
    draw(cx);
    assert_eq!(ids(&list, cx), ["idle-new", "idle-old"]);
}

#[gpui::test]
fn sidebar_drawer_rows_follow_the_list_in_keyboard_order(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, sessions());
    assert_eq!(choice(&list, cx).as_deref(), Some("idle-new"));
    cx.simulate_keystrokes("down");
    assert_eq!(choice(&list, cx).as_deref(), Some("idle-old"));
    // Down past the list's last thread opens the drawer, without motion.
    cx.simulate_keystrokes("down");
    assert_eq!(choice(&list, cx).as_deref(), Some("run"));
    list.read_with(cx, |list, _| {
        assert!(!list.working_closed);
        assert!(list.drawer_motion.is_none(), "the keyboard does not animate");
    });
    cx.simulate_keystrokes("down");
    assert_eq!(choice(&list, cx).as_deref(), Some("run"), "the drawer ends the order");
    cx.simulate_keystrokes("up");
    assert_eq!(choice(&list, cx).as_deref(), Some("idle-old"));
    // End from a closed drawer reaches its last thread.
    list.update(cx, |list, _| {
        list.working_closed = true;
        list.rebuild();
    });
    cx.simulate_keystrokes("home");
    cx.simulate_keystrokes("end");
    assert_eq!(choice(&list, cx).as_deref(), Some("run"));
    // Shift-click picks across the list into the drawer, for bulk actions.
    let picked = list.update(cx, |list, cx| {
        list.pick("idle-new", Default::default(), cx);
        list.pick("run", gpui::Modifiers::shift(), cx);
        list.picked.len()
    });
    assert_eq!(picked, 3);
}

#[gpui::test]
fn sidebar_drawer_returns_threads_and_respects_input_search_and_setting(
    cx: &mut TestAppContext,
) {
    let (list, cx) = make(cx, sessions());
    // A run that ends goes back to its group; the drawer leaves with it.
    list.update(cx, |list, _| {
        list.sessions[1].status = "idle".into();
        list.rebuild();
    });
    assert_eq!(ids(&list, cx), ["idle-new", "run", "idle-old"]);
    assert_eq!(drawer(&list, cx), None);
    draw(cx);
    assert!(cx.debug_bounds("sidebar-working-drawer").is_none());
    // A thread that needs input is not working.
    list.update(cx, |list, _| {
        list.sessions[1].status = "awaiting_input".into();
        list.rebuild();
    });
    assert_eq!(drawer(&list, cx), None);
    // A search lists a running thread in place and hides the drawer.
    list.update(cx, |list, _| {
        list.sessions[1].status = "running".into();
        list.query = "Thread".into();
        list.rebuild();
    });
    assert_eq!(ids(&list, cx), ["idle-new", "run", "idle-old"]);
    assert_eq!(drawer(&list, cx), None);
    // The setting off keeps runs in their groups.
    list.update(cx, |list, _| {
        list.query.clear();
        list.working_section = false;
        list.rebuild();
    });
    assert_eq!(ids(&list, cx), ["idle-new", "run", "idle-old"]);
    assert_eq!(drawer(&list, cx), None);
}

#[gpui::test]
fn sidebar_drawer_fits_the_narrowest_sidebar(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, sessions());
    cx.simulate_resize(gpui::size(gpui::px(250.), gpui::px(400.)));
    list.update(cx, |list, _| {
        list.working_closed = false;
        list.rebuild();
    });
    draw(cx);
    let side = cx.debug_bounds("thread-sidebar").unwrap();
    for part in ["sidebar-working-header", "sidebar-working-count", "sidebar-working-dot"] {
        let b = cx.debug_bounds(part).expect(part);
        assert!(b.right() <= side.right() && b.left() >= side.left(), "{part} {b:?} in {side:?}");
    }
    // At most 40% of the sidebar, however many threads run.
    list.update(cx, |list, _| {
        list.sessions.extend((0..30).map(|n| session(&format!("r{n}"), "running", "2026-10-02T10:00:00Z")));
        list.rebuild();
    });
    draw(cx);
    let drawer = cx.debug_bounds("sidebar-working-drawer").unwrap();
    assert!(drawer.size.height <= side.size.height * 0.4 + gpui::px(1.), "{drawer:?}");
}

#[gpui::test]
fn sidebar_drawer_runs_take_no_place_under_a_group_cap(cx: &mut TestAppContext) {
    // Twelve idle threads and a newer run in one date group: the run goes to
    // the drawer and all twelve idle threads still show before Show more.
    let mut all: Vec<_> = (0..13)
        .map(|n| session(&format!("idle-{n:02}"), "idle", &format!("2026-10-01T10:{n:02}:00Z")))
        .collect();
    all.push(session("run", "running", "2026-10-02T10:00:00Z"));
    let (list, cx) = make(cx, all);
    let main = ids(&list, cx);
    assert_eq!(main.len(), 12, "{main:?}");
    assert!(!main.contains(&"run".into()));
    list.read_with(cx, |list, _| {
        let more = list.rows.iter().position(|r| r.kind == "more").expect("Show more");
        assert_eq!(list.rows[more].title, "Show 1 more");
        assert_eq!(list.rows[more + 1].kind, "drawer");
        assert_eq!(list.rows[more + 1].age, "1");
    });
}

#[gpui::test]
fn sidebar_choice_that_starts_running_keeps_its_group_folded(cx: &mut TestAppContext) {
    // One date group of 14: twelve show, then Show 2 more.
    let all: Vec<_> = (0..14)
        .map(|n| session(&format!("t{n:02}"), "idle", &format!("2026-10-01T10:{n:02}:00Z")))
        .collect();
    let (list, cx) = make(cx, all);
    cx.simulate_keystrokes("down down");
    assert_eq!(choice(&list, cx).as_deref(), Some("t11"));
    // Sending to it opens it and starts a run: it moves to the closed drawer.
    list.update(cx, |list, _| {
        list.selected = Some("t11".into());
        list.sessions.iter_mut().find(|s| s.id == "t11").unwrap().status = "running".into();
        list.rebuild();
    });
    let shown = ids(&list, cx);
    assert!(!shown.contains(&"t11".into()));
    assert_eq!(shown.len(), 12, "the group stays folded: {shown:?}");
    list.read_with(cx, |list, _| {
        let more = list.rows.iter().find(|r| r.kind == "more").expect("Show more stays");
        assert_eq!(more.title, "Show 1 more");
    });
    assert_eq!(choice(&list, cx).as_deref(), Some("t12"), "the choice moves to the nearest row");
    // The header carries the selection while the drawer is closed.
    draw(cx);
    let fill = cx.debug_bounds("sidebar-working-selected").expect("selection drawn on the header");
    let head = cx.debug_bounds("sidebar-working-header").unwrap();
    assert_eq!(fill, head);
    // Open, the thread's own row carries it and the header lets go.
    list.update(cx, |list, _| list.open_drawer());
    draw(cx);
    assert!(cx.debug_bounds("sidebar-working-selected").is_none());
    assert_eq!(ids(&list, cx).last().map(String::as_str), Some("t11"));
}

#[gpui::test]
fn sidebar_drawer_leaves_out_archived_and_archiving_threads(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, sessions());
    assert_eq!(drawer(&list, cx), Some(("Working".into(), "1".into())));
    // An archive in flight keeps the thread where the archive will take it from.
    list.update(cx, |list, _| {
        list.archiving.insert("run".into(), true);
        list.rebuild();
    });
    assert_eq!(drawer(&list, cx), None);
    assert!(ids(&list, cx).contains(&"run".into()));
    // Archived, with Archived folded, it is in neither the drawer nor the list.
    list.update(cx, |list, _| {
        list.archiving.clear();
        list.sessions[1].status = "archived".into();
        list.rebuild();
    });
    assert_eq!(drawer(&list, cx), None);
    assert!(!ids(&list, cx).contains(&"run".into()));
}

#[test]
fn fold_leaves_running_rows_under_merged_and_settled() {
    let mut late = thread("late", true);
    late.marker = detailed::DRAWER_RUN;
    let rows = vec![
        header("section", "Today"),
        thread("a", false),
        header("section", "Merged"),
        thread("m", true),
        header("section", "Settled"),
        thread("s", true),
        late,
    ];
    assert_eq!(
        titles(&detailed::fold_working(rows, true, |_| false)),
        ["Today", "a", "Merged", "m", "Settled", "s", "Working", "late"],
        "shelf rows stay; a run held out of the groups still reaches the drawer"
    );
}

#[gpui::test]
fn sidebar_drawer_in_date_and_repo_views_takes_settled_runs_not_merged(cx: &mut TestAppContext) {
    // Date and Repo views have no Merged or Settled shelves (the Inbox has,
    // and keeps its own Working shelf): a settled thread that runs is
    // running work; a merged one is done and stays listed.
    let mut all = sessions();
    let mut settled = session("settled-run", "running", "2026-10-02T11:00:00Z");
    settled.settled_override = Some("settled".into());
    let mut merged = session("merged", "running", "2026-10-02T12:00:00Z");
    merged.outcome = Some("merged".into());
    all.extend([settled, merged]);
    let (list, cx) = make(cx, all);
    for view in [folders::View::Date, folders::View::Repo] {
        list.update(cx, |list, _| {
            list.views.insert(String::new(), view);
            list.working_closed = false;
            list.rebuild();
        });
        assert_eq!(drawer(&list, cx), Some(("Working".into(), "2".into())), "{view:?}");
        let rows = ids(&list, cx);
        assert!(rows.contains(&"merged".into()), "{view:?}: {rows:?}");
        let drawer_ids = list.read_with(cx, |list, _| {
            let at = list.drawer_index.unwrap();
            list.rows[at + 1..].iter().filter_map(|r| r.id.clone()).collect::<Vec<_>>()
        });
        assert_eq!(drawer_ids, ["settled-run", "run"], "{view:?}");
    }
}

#[gpui::test]
fn sidebar_archive_in_flight_stays_out_and_a_failed_one_returns(cx: &mut TestAppContext) {
    let mut all = sessions();
    all.push(session("box:run", "running", "2026-10-02T09:00:00Z"));
    let (list, cx) = make(cx, all);
    assert_eq!(drawer(&list, cx), Some(("Working".into(), "2".into())));
    // A native thread mid-archive stays out of the drawer.
    list.update(cx, |list, cx| list.archive_id("run".into(), cx));
    assert_eq!(drawer(&list, cx), Some(("Working".into(), "1".into())));
    // The archive fails (the test host is unreachable): it is back.
    cx.run_until_parked();
    assert_eq!(drawer(&list, cx), Some(("Working".into(), "2".into())));
    // The same for a machine thread, whose retry id outlives the attempt.
    list.update(cx, |list, cx| list.archive_id("box:run".into(), cx));
    assert_eq!(drawer(&list, cx), Some(("Working".into(), "1".into())));
    cx.run_until_parked();
    assert_eq!(drawer(&list, cx), Some(("Working".into(), "2".into())));
}

#[gpui::test]
fn sidebar_archive_that_succeeds_leaves_and_a_restored_run_returns(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, sessions());
    // Archived: it leaves the drawer and, with Archived folded, the list.
    list.update(cx, |list, cx| {
        list.archive_id("run".into(), cx);
        list.archive_done("run", true);
    });
    assert_eq!(drawer(&list, cx), None);
    assert!(!ids(&list, cx).contains(&"run".into()));
    // Restored while its run goes on: out while the restore is in flight,
    // in the drawer once it answers (the reload brings the running status).
    list.update(cx, |list, cx| {
        list.saving = false;
        list.archive_id("run".into(), cx);
        list.sessions[1].status = "running".into();
        list.rebuild();
    });
    assert_eq!(drawer(&list, cx), None);
    list.update(cx, |list, _| list.archive_done("run", true));
    assert_eq!(drawer(&list, cx), Some(("Working".into(), "1".into())));
}

#[gpui::test]
fn sidebar_closed_drawer_shows_unread_news_inside(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, sessions());
    draw(cx);
    assert!(cx.debug_bounds("sidebar-working-unread").is_none(), "nothing unread yet");
    list.update(cx, |list, _| {
        list.sessions[1].unread = true;
        list.rebuild();
    });
    draw(cx);
    let dot = cx.debug_bounds("sidebar-working-unread").expect("the closed header shows it");
    let head = cx.debug_bounds("sidebar-working-header").unwrap();
    assert!(head.contains(&dot.center()));
    // Open, the thread's own row speaks for it and the header's dot goes.
    list.update(cx, |list, _| list.open_drawer());
    draw(cx);
    assert!(cx.debug_bounds("sidebar-working-unread").is_none());
    assert_eq!(ids(&list, cx).last().map(String::as_str), Some("run"));
    let unread = list.read_with(cx, |list, _| list.rows.last().unwrap().unread);
    assert!(unread, "the row keeps its unread state");
}

/// Thirty idle threads a month old under a run from today (#6021).
fn long_list(run_status: &str) -> Vec<Session> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut all = vec![session("run", run_status, &super::iso_timestamp(now - 60))];
    all.extend((0..30).map(|n| {
        session(&format!("old-{n:02}"), "idle", &format!("2026-10-01T10:{n:02}:00Z"))
    }));
    all
}

/// The top visible row's identity and how far into it the list starts.
fn top_row(list: &Entity<ThreadList>, cx: &VisualTestContext) -> (String, gpui::Pixels) {
    list.read_with(cx, |list, _| {
        let (ix, within) = if list.detailed {
            let top = list.detailed_list.logical_scroll_top();
            (top.item_ix, top.offset_in_item)
        } else {
            let y = -list.scroll.0.borrow().base_handle.offset().y;
            let ix = (y / gpui::px(28.)).floor() as usize;
            (ix, y - gpui::px(28.) * ix as f32)
        };
        let row = &list.rows[ix];
        (row.id.clone().unwrap_or_else(|| row.title.clone()), within)
    })
}

fn set_detailed(list: &Entity<ThreadList>, cx: &mut VisualTestContext, detailed: bool) {
    list.update(cx, |list, _| {
        list.detailed = detailed;
        // All thirty listed, so a scrolled view sits mid-list, not at its end.
        list.expanded.insert("Older".into());
        list.rebuild();
    });
    cx.simulate_resize(gpui::size(gpui::px(300.), gpui::px(420.)));
    draw(cx);
}

fn scroll_down(list: &Entity<ThreadList>, cx: &mut VisualTestContext) {
    list.update(cx, |list, _| {
        if list.detailed {
            list.detailed_list.scroll_to(gpui::ListOffset {
                item_ix: 12,
                offset_in_item: gpui::px(10.),
            });
        } else {
            list.scroll.0.borrow().base_handle.set_offset(gpui::point(gpui::px(0.), gpui::px(-346.)));
        }
    });
    draw(cx);
}

fn first_row_at_list_top(cx: &mut VisualTestContext) {
    let list = cx.debug_bounds("thread-list").expect("the list");
    let row = cx.debug_bounds("thread-row-0").expect("row 0 drawn");
    assert!((row.top() - list.top()).abs() <= gpui::px(2.), "{row:?} vs {list:?}");
}

#[gpui::test]
fn sidebar_list_at_top_stays_at_top_when_a_run_returns(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, long_list("running"));
    for detailed in [true, false] {
        set_detailed(&list, cx, detailed);
        list.update(cx, |list, _| {
            list.sessions[0].status = "running".into();
            list.rebuild();
        });
        draw(cx);
        first_row_at_list_top(cx);
        // The run ends: the thread and its Today heading come back on top.
        list.update(cx, |list, _| {
            list.sessions[0].status = "idle".into();
            list.rebuild();
        });
        draw(cx);
        let heads = list.read_with(cx, |list, _| {
            list.rows[..3].iter().map(|r| r.title.clone()).collect::<Vec<_>>()
        });
        assert_eq!(heads, ["Recents", "Today", "Thread run"], "detailed {detailed}");
        first_row_at_list_top(cx);
    }
}

#[gpui::test]
fn sidebar_scrolled_list_keeps_its_rows_when_a_run_returns(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, long_list("running"));
    for detailed in [true, false] {
        set_detailed(&list, cx, detailed);
        list.update(cx, |list, _| {
            list.sessions[0].status = "running".into();
            list.rebuild();
        });
        scroll_down(&list, cx);
        let before = top_row(&list, cx);
        list.update(cx, |list, _| {
            list.sessions[0].status = "idle".into();
            list.rebuild();
        });
        draw(cx);
        assert_eq!(top_row(&list, cx), before, "detailed {detailed}");
    }
}

#[gpui::test]
fn sidebar_list_does_not_jump_when_a_top_thread_starts_running(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, long_list("idle"));
    for detailed in [true, false] {
        set_detailed(&list, cx, detailed);
        list.update(cx, |list, _| {
            list.sessions[0].status = "idle".into();
            list.choice = Some("run".into());
            list.rebuild();
        });
        draw(cx);
        // At the top: the run leaves for the drawer and the list stays put.
        list.update(cx, |list, _| {
            list.sessions[0].status = "running".into();
            list.rebuild();
        });
        draw(cx);
        first_row_at_list_top(cx);
        // Scrolled: the rows in view stay where they are.
        list.update(cx, |list, _| {
            list.sessions[0].status = "idle".into();
            list.rebuild();
        });
        scroll_down(&list, cx);
        let before = top_row(&list, cx);
        list.update(cx, |list, _| {
            list.sessions[0].status = "running".into();
            list.rebuild();
        });
        draw(cx);
        assert_eq!(top_row(&list, cx), before, "detailed {detailed}");
    }
}

fn in_repo(id: &str, repo: &str, at: &str) -> Session {
    serde_json::from_value(json!({
        "id": id, "title": format!("Thread {id}"), "status": "idle",
        "lastMessageAt": at, "repoPath": repo, "messageCount": 2,
    }))
    .unwrap()
}

/// Row `ix` is drawn inside the list's visible bounds.
fn drawn_in_view(cx: &mut VisualTestContext, ix: usize) -> bool {
    let list = cx.debug_bounds("thread-list").expect("the list");
    let selector: &'static str = Box::leak(format!("thread-row-{ix}").into_boxed_str());
    cx.debug_bounds(selector)
        .is_some_and(|row| row.top() >= list.top() - gpui::px(1.) && row.bottom() <= list.bottom() + gpui::px(1.))
}

fn index_of(list: &Entity<ThreadList>, cx: &VisualTestContext, id: &str) -> usize {
    list.read_with(cx, |list, _| list.rows.iter().position(|r| r.id.as_deref() == Some(id)).unwrap())
}

#[gpui::test]
fn sidebar_new_thread_is_revealed_in_a_scrolled_list(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, long_list("idle"));
    for (detailed, id) in [(true, "new-a"), (false, "new-b")] {
        set_detailed(&list, cx, detailed);
        scroll_down(&list, cx);
        // New thread: its load arrives and open_pending follows the selection.
        list.update(cx, |list, cx| {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
            list.sessions.push(session(id, "idle", &super::iso_timestamp(now)));
            list.pending_open = Some((id.into(), std::time::Instant::now()));
            list.open_pending(cx);
        });
        draw(cx);
        let ix = index_of(&list, cx, id);
        assert!(drawn_in_view(cx, ix), "detailed {detailed}: the new row {ix} is in view");
    }
}

#[gpui::test]
fn sidebar_selection_from_outside_reveals_a_folder_below_the_fold(cx: &mut TestAppContext) {
    let mut all: Vec<_> = (0..30)
        .map(|n| in_repo(&format!("a{n:02}"), "/fixture/alpha", &format!("2026-10-02T10:{n:02}:00Z")))
        .collect();
    all.push(in_repo("b-one", "/fixture/beta", "2026-09-01T10:00:00Z"));
    all.push(in_repo("b-two", "/fixture/beta", "2026-09-01T09:00:00Z"));
    let (list, cx) = make(cx, all);
    for (detailed, id) in [(true, "b-one"), (false, "b-two")] {
        list.update(cx, |list, _| {
            list.views.insert(String::new(), folders::View::Repo);
            // A switch from a thread in view, not the launch's restore.
            list.selected = Some("a00".into());
        });
        set_detailed(&list, cx, detailed);
        list.update(cx, |list, _| {
            list.detailed_list.scroll_to(gpui::ListOffset { item_ix: 0, offset_in_item: gpui::px(0.) });
            list.scroll.0.borrow().base_handle.set_offset(gpui::point(gpui::px(0.), gpui::px(0.)));
        });
        draw(cx);
        list.update(cx, |list, cx| list.sync_selection(id.into(), cx));
        draw(cx);
        let ix = index_of(&list, cx, id);
        assert!(drawn_in_view(cx, ix), "detailed {detailed}: {id} at row {ix} is revealed");
    }
}

#[gpui::test]
fn sidebar_search_starts_at_the_top_and_clearing_returns(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, long_list("idle"));
    for detailed in [true, false] {
        set_detailed(&list, cx, detailed);
        scroll_down(&list, cx);
        let before = top_row(&list, cx);
        let editor = list.read_with(cx, |list, _| list.editor.clone());
        editor.update(cx, |e, cx| e.set_text("Thread", cx));
        draw(cx);
        first_row_at_list_top(cx);
        // A refined search goes back to the top again.
        scroll_down(&list, cx);
        editor.update(cx, |e, cx| e.set_text("Thread old", cx));
        draw(cx);
        first_row_at_list_top(cx);
        // Cleared: the list returns to where it was before the search.
        editor.update(cx, |e, cx| e.clear(cx));
        draw(cx);
        assert_eq!(top_row(&list, cx), before, "detailed {detailed}");
    }
}

#[gpui::test]
fn sidebar_anchor_tells_two_show_more_rows_apart(cx: &mut TestAppContext) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let mut all: Vec<_> = (0..14)
        .map(|n| session(&format!("today-{n:02}"), "idle", &super::iso_timestamp(now - 60 - n)))
        .collect();
    all.extend((0..14).map(|n| {
        session(&format!("week-{n:02}"), "idle", &super::iso_timestamp(now - 3 * 86_400 - n))
    }));
    all.extend((0..30).map(|n| {
        session(&format!("old-{n:02}"), "idle", &format!("2026-09-01T10:{n:02}:00Z"))
    }));
    let (list, cx) = make(cx, all);
    set_detailed(&list, cx, false);
    // Put the second group's Show more at the top.
    let more = list.read_with(cx, |list, _| {
        list.rows.iter().enumerate().filter(|(_, r)| r.kind == "more").nth(1).map(|(i, r)| (i, r.status.clone())).unwrap()
    });
    let first = list.read_with(cx, |list, _| list.rows.iter().find(|r| r.kind == "more").unwrap().title.clone());
    let second = list.read_with(cx, |list, _| list.rows[more.0].title.clone());
    assert_eq!(first, second, "both groups say the same Show more");
    list.update(cx, |list, _| {
        list.scroll.0.borrow().base_handle.set_offset(gpui::point(gpui::px(0.), gpui::px(-28. * more.0 as f32)));
    });
    draw(cx);
    list.update(cx, |list, _| list.rebuild());
    draw(cx);
    let top = list.read_with(cx, |list, _| {
        let y = -list.scroll.0.borrow().base_handle.offset().y;
        let row = &list.rows[(y / gpui::px(28.)).floor() as usize];
        (row.kind.clone(), row.status.clone())
    });
    assert_eq!(top, ("more".into(), more.1));
}

#[gpui::test]
fn sidebar_ticks_and_refreshes_do_not_move_the_list(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, long_list("idle"));
    for detailed in [true, false] {
        set_detailed(&list, cx, detailed);
        list.update(cx, |list, _| {
            list.detailed_list.scroll_to(gpui::ListOffset { item_ix: 0, offset_in_item: gpui::px(0.) });
            list.scroll.0.borrow().base_handle.set_offset(gpui::point(gpui::px(0.), gpui::px(0.)));
        });
        draw(cx);
        for scrolled in [false, true] {
            if scrolled {
                scroll_down(&list, cx);
            }
            let before = top_row(&list, cx);
            // The working tick rebuilds unchanged rows; a refresh brings a
            // newer thread in above.
            list.update(cx, |list, _| list.rebuild());
            draw(cx);
            assert_eq!(top_row(&list, cx), before, "tick, detailed {detailed}");
            list.update(cx, |list, _| {
                let n = list.sessions.len();
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
                list.sessions.push(session(&format!("fresh-{detailed}-{n}"), "idle", &super::iso_timestamp(now)));
                list.rebuild();
            });
            draw(cx);
            if scrolled {
                assert_eq!(top_row(&list, cx), before, "refresh, detailed {detailed}");
            } else {
                first_row_at_list_top(cx);
            }
        }
    }
}

/// Twenty runs for the drawer, then thirty idle threads in the list.
fn runs_and_list() -> Vec<Session> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let mut all: Vec<_> = (0..20)
        .map(|n| session(&format!("run-{n:02}"), "running", &super::iso_timestamp(now - 60 - n)))
        .collect();
    all.extend((0..30).map(|n| {
        session(&format!("old-{n:02}"), "idle", &format!("2026-10-01T10:{n:02}:00Z"))
    }));
    all
}

#[gpui::test]
fn sidebar_selection_in_the_open_drawer_scrolls_the_drawer_only(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, runs_and_list());
    list.update(cx, |list, _| list.open_drawer());
    for (detailed, id) in [(true, "run-19"), (false, "run-18")] {
        set_detailed(&list, cx, detailed);
        list.update(cx, |list, _| list.drawer_scroll.scroll_to_item(0, ScrollStrategy::Top));
        draw(cx);
        scroll_down(&list, cx);
        let before = top_row(&list, cx);
        list.update(cx, |list, cx| {
            list.selected = Some("old-00".into());
            list.sync_selection(id.into(), cx)
        });
        draw(cx);
        assert_eq!(top_row(&list, cx), before, "detailed {detailed}: the main list stays");
        let ix = index_of(&list, cx, id);
        let drawer = cx.debug_bounds("sidebar-working-rows").expect("the open drawer");
        let selector: &'static str = Box::leak(format!("thread-row-{ix}").into_boxed_str());
        let row = cx.debug_bounds(selector).expect("the drawer row drawn");
        assert!(
            row.top() >= drawer.top() - gpui::px(1.) && row.bottom() <= drawer.bottom() + gpui::px(1.),
            "detailed {detailed}: {row:?} in {drawer:?}"
        );
    }
}

#[gpui::test]
fn sidebar_selection_in_the_closed_drawer_never_pulls_the_list_later(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, runs_and_list());
    for detailed in [true, false] {
        list.update(cx, |list, _| {
            list.working_closed = true;
            list.selected = None;
        });
        set_detailed(&list, cx, detailed);
        list.update(cx, |list, cx| list.sync_selection("run-15".into(), cx));
        draw(cx);
        scroll_down(&list, cx);
        let before = top_row(&list, cx);
        // The working tick, a refresh, then the drawer opening.
        list.update(cx, |list, _| list.rebuild());
        draw(cx);
        assert_eq!(top_row(&list, cx), before, "tick, detailed {detailed}");
        list.update(cx, |list, _| {
            list.sessions.push(session(&format!("older-{detailed}"), "idle", "2026-09-01T10:00:00Z"));
            list.rebuild();
        });
        draw(cx);
        assert_eq!(top_row(&list, cx), before, "refresh, detailed {detailed}");
        list.update(cx, |list, _| list.open_drawer());
        draw(cx);
        assert_eq!(top_row(&list, cx), before, "drawer opened, detailed {detailed}");
    }
}

#[gpui::test]
fn sidebar_search_return_is_dropped_when_the_project_changes(cx: &mut TestAppContext) {
    let (list, cx) = make(cx, long_list("idle"));
    for detailed in [true, false] {
        set_detailed(&list, cx, detailed);
        scroll_down(&list, cx);
        let editor = list.read_with(cx, |list, _| list.editor.clone());
        editor.update(cx, |e, cx| e.set_text("Thread", cx));
        draw(cx);
        let project = list.read_with(cx, |list, _| list.header.ledger.active_project_id.clone());
        list.update(cx, |list, _| {
            list.header.ledger.active_project_id = format!("other-{detailed}");
            list.rebuild();
        });
        draw(cx);
        editor.update(cx, |e, cx| e.clear(cx));
        draw(cx);
        first_row_at_list_top(cx);
        list.update(cx, |list, _| {
            list.header.ledger.active_project_id = project;
            list.rebuild();
        });
        draw(cx);
    }
}
