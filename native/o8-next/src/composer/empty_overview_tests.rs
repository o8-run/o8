use super::*;
use serde_json::json;

fn session(id: &str, fields: serde_json::Value) -> Session {
    let mut record = json!({
        "id": id, "title": format!("Thread {id}"), "status": "idle",
        "lastMessageAt": "2026-11-10T12:00:00Z", "messageCount": 3,
        "repoPath": "/r/site"
    });
    for (key, value) in fields.as_object().unwrap() {
        record[key] = value.clone();
    }
    serde_json::from_value(record).unwrap()
}

/// 2026-11-11T12:00:00Z.
const NOW: u64 = 1_794_398_400;

fn empty_chat(
    cx: &mut gpui::TestAppContext,
) -> (gpui::Entity<Surface>, &mut gpui::VisualTestContext) {
    let client = crate::client::Client::new("http://127.0.0.1:9").unwrap();
    let (surface, cx) = cx.add_window_view(|window, cx| Surface::new(client, window, cx));
    surface.update(cx, |s, _| {
        s.sessions = vec![session(
            "thoughts-next-1",
            json!({"title": "New conversation", "messageCount": 0}),
        )];
        s.selected = Some("thoughts-next-1".into());
    });
    (surface, cx)
}

fn drawn(cx: &mut gpui::VisualTestContext, selector: &'static str) -> bool {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    cx.debug_bounds(selector).is_some()
}

#[gpui::test]
fn an_empty_new_chat_shows_the_overview_until_a_send_starts(cx: &mut gpui::TestAppContext) {
    let (surface, cx) = empty_chat(cx);
    assert!(surface.read_with(cx, |s, _| s.empty_chat()));
    assert!(drawn(cx, "empty-overview"));
    for selector in [
        "empty-overview-needs",
        "empty-overview-recent",
        "empty-overview-usage",
        "empty-overview-week",
    ] {
        assert!(drawn(cx, selector), "{selector}");
    }
    // A send on its way hides it at once.
    surface.update(cx, |s, _| s.saving = true);
    assert!(!surface.read_with(cx, |s, _| s.empty_chat()));
    assert!(!drawn(cx, "empty-overview"));
    surface.update(cx, |s, _| {
        s.saving = false;
        s.pending
            .insert("thoughts-next-1".into(), json!({"id": "q-1"}));
    });
    assert!(!drawn(cx, "empty-overview"));
}

#[gpui::test]
fn a_thread_with_history_never_shows_the_overview(cx: &mut gpui::TestAppContext) {
    let (surface, cx) = empty_chat(cx);
    // The first message lands.
    surface.update(cx, |s, _| s.sessions[0].message_count = 1);
    assert!(!drawn(cx, "empty-overview"));
    // A thread that is not a new chat, even an empty one.
    surface.update(cx, |s, _| {
        s.sessions = vec![session("worker-1", json!({"messageCount": 0}))];
        s.selected = Some("worker-1".into());
    });
    assert!(!drawn(cx, "empty-overview"));
}

#[gpui::test]
fn the_overview_reads_the_shells_whole_list(cx: &mut gpui::TestAppContext) {
    let (surface, cx) = empty_chat(cx);
    let other = session("t-other", json!({"repoPath": "/r/other", "unread": true}));
    surface.update(cx, |s, cx| {
        let mut all = s.sessions.clone();
        all.push(other.clone());
        s.shell_overview(&all, &BTreeMap::new(), cx);
    });
    assert!(drawn(cx, "empty-overview-needs-0"));
    assert!(drawn(cx, "empty-overview-recent-0"));
}

#[gpui::test]
fn cards_sit_two_abreast_on_a_wide_pane_and_stack_on_a_narrow_one(cx: &mut gpui::TestAppContext) {
    let (_surface, cx) = empty_chat(cx);
    let tops = |cx: &mut gpui::VisualTestContext| {
        drawn(cx, "empty-overview");
        let needs = cx.debug_bounds("empty-overview-needs").unwrap().origin.y;
        let recent = cx.debug_bounds("empty-overview-recent").unwrap().origin.y;
        (needs, recent)
    };
    cx.simulate_resize(gpui::size(px(1600.), px(1000.)));
    let (needs, recent) = tops(cx);
    assert_eq!(needs, recent, "two columns");
    // Two columns, not four: the pane is far wider than the overview, and
    // the cards wrap at the overview's width and stay inside it.
    let frame = cx.debug_bounds("empty-overview").unwrap();
    let usage = cx.debug_bounds("empty-overview-usage").unwrap();
    assert!(usage.origin.y > needs, "the third card starts a second row");
    for card in ["empty-overview-recent", "empty-overview-week"] {
        assert!(
            cx.debug_bounds(card).unwrap().right() <= frame.right(),
            "{card} stays inside the overview"
        );
    }
    assert!(frame.size.width <= px(crate::theme::chat_width()));
    cx.simulate_resize(gpui::size(px(560.), px(1000.)));
    let (needs, recent) = tops(cx);
    assert!(recent > needs, "one column");
}

#[test]
fn needs_you_lists_questions_first_as_the_inbox_does_and_skips_what_is_not_waiting() {
    let sessions = vec![
        session("idle", json!({})),
        session(
            "approval",
            json!({"status": "approval", "lastMessageAt": "2026-11-07T11:00:00Z"}),
        ),
        session(
            "question",
            json!({"status": "awaiting_input", "lastMessageAt": "2026-11-08T11:00:00Z"}),
        ),
        session(
            "review",
            json!({"status": "review", "lastMessageAt": "2026-11-11T11:00:00Z"}),
        ),
        session(
            "failed",
            json!({"status": "failed", "lastMessageAt": "2026-11-09T11:00:00Z"}),
        ),
        session("unread", json!({"unread": true, "repoSlug": "o8-run/o8"})),
        session(
            "settled",
            json!({"status": "failed", "settledOverride": "settled"}),
        ),
        session("archived", json!({"status": "archived", "unread": true})),
        session(
            "child",
            json!({"status": "failed", "parentInboxSubject": {"kind": "thread"}}),
        ),
        session("open", json!({"status": "failed"})),
    ];
    let none = BTreeMap::new();
    let rows = needs_you(&sessions, &none, Some("open"), NOW);
    let ids: Vec<_> = rows.iter().map(|r| r.id.as_str()).collect();
    // The Inbox heads its list with what waits on you; an older question
    // still comes before a newer failure.
    assert_eq!(ids, ["question", "approval", "failed", "review"]);
    assert_eq!(rows[0].note, Some("Waiting on you"));
    assert_eq!(rows[1].note, Some("Waiting on you"));
    assert_eq!(rows[2].note, Some("Failed"));
    assert_eq!(rows[3].note, Some("Review ready"));
    assert_eq!(rows[3].age, "1h");
    let rows = needs_you(&sessions[3..], &none, Some("open"), NOW);
    assert_eq!(rows[2].id, "unread");
    assert_eq!(rows[2].note, Some("Unread"));
    assert_eq!(rows[2].repo, "o8");
    assert!(needs_you(&sessions[..1], &none, None, NOW).is_empty());
}

#[test]
fn a_snoozed_thread_stays_out_of_needs_you_until_it_wakes() {
    let sessions = vec![session("failed", json!({"status": "failed"}))];
    let asleep = BTreeMap::from([("failed".to_string(), NOW + 60)]);
    assert!(needs_you(&sessions, &asleep, None, NOW).is_empty());
    let woken = BTreeMap::from([("failed".to_string(), NOW - 60)]);
    assert_eq!(needs_you(&sessions, &woken, None, NOW).len(), 1);
}

#[test]
fn needs_you_and_recent_stop_at_four_rows() {
    let sessions: Vec<_> = (0..6)
        .map(|i| {
            session(
                &format!("t{i}"),
                json!({"unread": true, "lastMessageAt": format!("2026-11-0{}T12:00:00Z", i + 1)}),
            )
        })
        .collect();
    assert_eq!(needs_you(&sessions, &BTreeMap::new(), None, NOW).len(), 4);
    let recent = recent(&sessions, None, NOW);
    let ids: Vec<_> = recent.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["t5", "t4", "t3", "t2"]);
    assert_eq!(recent[0].age, "5d");
    assert_eq!(recent[0].note, None);
}

#[test]
fn recent_skips_empty_new_chats_and_other_machines() {
    let mut far = session("far", json!({}));
    far.machine = Some("box".into());
    let sessions = vec![
        session("thoughts-next-2", json!({"messageCount": 0})),
        far,
        session("kept", json!({"repoPath": null})),
    ];
    let rows = recent(&sessions, None, NOW);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "kept");
    assert_eq!(rows[0].repo, "No project");
}

#[test]
fn finished_threads_land_on_their_day() {
    let today = NOW - 12 * 3600;
    let sessions = vec![
        session(
            "merged-today",
            json!({"status": "merged", "lastMessageAt": "2026-11-11T08:00:00Z"}),
        ),
        session(
            "outcome",
            json!({"outcome": "merged", "lastMessageAt": "2026-11-10T08:00:00Z"}),
        ),
        session(
            "done",
            json!({"status": "completed", "lastMessageAt": "2026-11-10T09:00:00Z"}),
        ),
        session(
            "old",
            json!({"status": "merged", "lastMessageAt": "2026-01-01T09:00:00Z"}),
        ),
        session(
            "open",
            json!({"status": "running", "lastMessageAt": "2026-11-11T09:00:00Z"}),
        ),
    ];
    let starts: [u64; DAYS] = std::array::from_fn(|day| today - (DAYS - 1 - day) as u64 * 86_400);
    let days = finished_by_day(&sessions, &starts);
    assert_eq!(days[DAYS - 1], 1);
    assert_eq!(days[DAYS - 2], 2);
    assert_eq!(days.iter().sum::<u32>(), 3);
    assert_eq!(
        week_total(&days),
        "3 in the last 7 days · 3 in 12 weeks"
    );
    let mut one = [0; DAYS];
    one[0] = 1;
    assert_eq!(
        week_total(&one),
        "0 in the last 7 days · 1 in 12 weeks"
    );
}

#[test]
fn a_thread_finished_in_a_long_day_s_extra_hour_stays_on_that_day() {
    // 2026-11-11T00:00:00Z stands for local midnight; the day before it is
    // 25 hours long, as on the day the clocks go back.
    let today = NOW - 12 * 3600;
    let starts: [u64; DAYS] = std::array::from_fn(|day| match DAYS - 1 - day {
        0 => today,
        ago => today - 3_600 - ago as u64 * 86_400,
    });
    // Half an hour into that long day: more than 24 hours before midnight.
    let sessions = vec![session(
        "merged",
        json!({"status": "merged", "lastMessageAt": "2026-11-09T23:30:00Z"}),
    )];
    let days = finished_by_day(&sessions, &starts);
    assert_eq!(days[DAYS - 2], 1, "{:?}", &days[DAYS - 3..]);
    // A time ahead of this clock counts as today; one before the window, never.
    let ahead = vec![
        session("ahead", json!({"status": "merged", "lastMessageAt": "2026-11-12T09:00:00Z"})),
        session("early", json!({"status": "merged", "lastMessageAt": "2026-08-01T09:00:00Z"})),
    ];
    let days = finished_by_day(&ahead, &starts);
    assert_eq!(days[DAYS - 1], 1);
    assert_eq!(days.iter().sum::<u32>(), 1);
}

#[test]
fn heat_levels_scale_to_the_busiest_day() {
    assert_eq!(level(0, 5), 0);
    assert_eq!(level(1, 8), 1);
    assert_eq!(level(4, 8), 2);
    assert_eq!(level(8, 8), 4);
    assert_eq!(level(3, 0), 0);
}
