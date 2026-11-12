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
