//! Inbox snooze expiry and selection disclosure, on a list built in memory.
use super::*;
use gpui::{TestAppContext, VisualTestContext};

fn session(id: &str, status: &str, settled: bool) -> Session {
    serde_json::from_value(json!({
        "id": id, "title": format!("Thread {id}"), "status": status,
        "lastMessageAt": "2026-11-02T10:00:00Z", "repoPath": "/fixture/repo",
        "messageCount": 2,
        "settledOverride": if settled { Some("settled") } else { None },
        // A host that projects settlement, so the list is the Inbox.
        "inboxSubject": {"kind": "conversation", "id": id},
    }))
    .unwrap()
}

fn inbox(
    cx: &mut TestAppContext,
    sessions: Vec<Session>,
) -> (Entity<ThreadList>, &mut VisualTestContext) {
    cx.add_window_view(|_, cx| {
        let mut list = ThreadList::new(Client::new("http://127.0.0.1:9").unwrap(), cx);
        list.sessions = sessions;
        // Nothing reaches out to the unreachable host during the ticks.
        list.pr_loading = true;
        list.machines_loading = true;
        list.views.insert(String::new(), folders::View::Inbox);
        list.rebuild();
        list
    })
}

#[gpui::test]
fn an_ended_snooze_rebuilds_the_inbox_once_even_when_its_thread_needs_input(
    cx: &mut TestAppContext,
) {
    let (list, cx) = inbox(cx, vec![session("asks", "approval", false)]);
    list.update(cx, |l, cx| {
        l.snoozes.insert("asks".into(), recents::now() - 5);
        l.tick(cx);
    });
    let after_wake = list.read_with(cx, |l, _| {
        let row = l
            .rows
            .iter()
            .find(|r| r.id.as_deref() == Some("asks"))
            .unwrap();
        // Needing input outranks Back, so the marker never reads "back".
        assert_eq!(row.marker, "input");
        l.rows.clone()
    });
    for _ in 0..20 {
        list.update(cx, |l, cx| l.tick(cx));
    }
    list.read_with(cx, |l, _| {
        assert!(
            Rc::ptr_eq(&l.rows, &after_wake),
            "later ticks rebuilt the list"
        );
        assert!(!l.snooze_due());
    });
}

#[gpui::test]
fn selecting_a_settled_thread_keeps_the_settled_shelf_capped(cx: &mut TestAppContext) {
    let sessions: Vec<_> = (0..14)
        .map(|i| session(&format!("done-{i:02}"), "idle", true))
        .chain([session("live", "idle", false)])
        .collect();
    let (list, cx) = inbox(cx, sessions);
    list.update(cx, |l, _| {
        l.open_shelves();
        l.selected = Some("done-03".into());
        l.rebuild();
    });
    list.read_with(cx, |l, _| {
        assert!(
            !l.expanded.contains("Settled"),
            "the bare key shows every row"
        );
        assert!(l.expanded.contains(&inbox::open_key("Settled")));
        let at = l
            .rows
            .iter()
            .position(|r| r.kind == "shelf" && r.title == "Settled")
            .unwrap();
        let shelf: Vec<_> = l.rows[at + 1..]
            .iter()
            .take_while(|r| r.kind != "shelf")
            .collect();
        let threads = shelf.iter().filter(|r| r.id.is_some()).count();
        assert_eq!(threads, 10, "the shelf stays at its cap");
        assert!(shelf.iter().any(|r| r.kind == "more"), "Show more stays");
        assert!(shelf.iter().any(|r| r.id.as_deref() == Some("done-03")));
    });
}
