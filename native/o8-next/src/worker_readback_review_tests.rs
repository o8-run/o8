use super::*;
fn event(seq: u64, id: &str, text: &str, at: &str) -> Value {
    json!({"seq":seq,"eventId":id,"type":"assistant","text":text,"ts":at})
}
#[test]
fn empty_normalization_keeps_saved_answers_and_page() {
    let h = Host::new(200);
    h.events.lock().unwrap().clear();
    let history = h.history();
    assert!(
        history.transcript.iter().any(|e| e.id == "legacy"),
        "a successful empty readback cannot erase answers"
    );

    assert!(
        !h.requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("before=")),
        "opening does not wait for older pages"
    );
}
#[test]
fn tail_normalization_keeps_older_saved_answers_and_system_entries() {
    let h = Host::new(200);
    h.complete.store(false, Ordering::Release);
    h.saved.lock().unwrap().push(
        json!({"id":"old-tool","role":"system","text":"Earlier tool output","timestamp":1100}),
    );
    *h.events.lock().unwrap() = vec![event(1, "new", "Latest answer", "1970-01-01T00:00:02.000Z")];
    let history = h.history();
    assert!(history.transcript.iter().any(|e| e.id == "legacy"));
    assert!(history.transcript.iter().any(|e| e.id == "old-tool"));
    assert!(history.transcript.iter().any(|e| e.text == "Latest answer"));
}
fn apply_poll(
    h: &Host,
    t: &mut Transcript,
    state: &mut crate::shell::session::worker_transcript::State,
) {
    let entries = state.poll(&h.client).unwrap();
    t.apply(&json!({"channel":"history","event":"update","data":{"sessionKey":t.key,"replace":false,"entries":entries}}));
}
#[test]
fn steer_insertion_does_not_duplicate_the_answer_or_skip_the_steer() {
    let h = Host::new(200);
    *h.events.lock().unwrap() = vec![event(1, "answer", "Final answer", "2026-01-01T00:00:02Z")];
    let history = h.history();
    let mut state =
        crate::shell::session::worker_transcript::State::from_history(&history).unwrap();
    let mut t = Transcript::new(history);
    *h.events.lock().unwrap() = vec![
        json!({"seq":1,"eventId":"steer","type":"steer","text":"One more check","ts":"2026-01-01T00:00:01Z"}),
        event(2, "answer", "Final answer", "2026-01-01T00:00:02Z"),
    ];
    apply_poll(&h, &mut t, &mut state);
    assert_eq!(
        t.entries
            .iter()
            .filter(|e| e.text == "Final answer")
            .count(),
        1
    );
    assert!(t.entries.iter().any(|e| e.text == "One more check"));
}
#[test]
fn sliding_window_resets_cursor_and_keeps_overlap_identity() {
    let h = Host::new(200);
    *h.events.lock().unwrap() = vec![
        event(1, "a", "Earlier answer", "2026-01-01T00:00:01Z"),
        event(2, "b", "Overlap answer", "2026-01-01T00:00:02Z"),
    ];
    let history = h.history();
    let mut state =
        crate::shell::session::worker_transcript::State::from_history(&history).unwrap();
    let mut t = Transcript::new(history);
    *h.events.lock().unwrap() = vec![event(1, "b", "Overlap answer", "2026-01-01T00:00:02Z")];
    apply_poll(&h, &mut t, &mut state);
    h.events
        .lock()
        .unwrap()
        .push(event(2, "c", "Newest answer", "2026-01-01T00:00:03Z"));
    apply_poll(&h, &mut t, &mut state);
    assert!(
        t.entries.iter().any(|e| e.text == "Newest answer"),
        "a backwards cursor must not stall later events"
    );
    assert_eq!(
        t.entries
            .iter()
            .filter(|e| e.text == "Overlap answer")
            .count(),
        1
    );
}

#[test]
fn newest_page_returns_before_any_older_saved_page_is_requested() {
    let h = Host::new(200);
    h.paged.store(true, Ordering::Release);
    let history = h.history();
    assert!(
        !h.requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("before=")),
        "opening must not block on older saved pages"
    );
    assert!(history.page.as_ref().unwrap().has_more);
}

#[test]
fn unstamped_worker_events_append_in_initial_and_live_history() {
    let h = Host::new(200);
    *h.events.lock().unwrap() = vec![
        event(1, "dated", "Dated answer", "2026-01-01T00:00:02Z"),
        json!({"seq":2,"eventId":"unstamped","type":"assistant","text":"Unstamped answer"}),
    ];
    let history = h.history();
    let texts: Vec<_> = history
        .transcript
        .iter()
        .filter(|e| e.role == "assistant" && !e.text.is_empty())
        .map(|e| e.text.as_str())
        .collect();
    assert_eq!(texts, vec!["Dated answer", "Unstamped answer"]);
    let mut state =
        crate::shell::session::worker_transcript::State::from_history(&history).unwrap();
    let mut t = Transcript::new(history);
    h.events.lock().unwrap().push(
        json!({"seq":3,"eventId":"later","type":"assistant","text":"Later unstamped answer"}),
    );
    apply_poll(&h, &mut t, &mut state);
    assert_eq!(
        t.entries[t.entries.len() - 2].text,
        "Later unstamped answer"
    );
}
#[test]
fn inactive_sessions_without_done_use_socket_invalidation_not_a_timer() {
    let h = Host::new(200);
    *h.events.lock().unwrap() = vec![event(1, "idle", "Old answer", "2026-01-01T00:00:02Z")];
    let history = h.history();
    let subscription = transport::subscribe_history(h.client.clone(), &history);
    std::thread::sleep(Duration::from_millis(400));
    let count = h.reads().len();
    std::thread::sleep(Duration::from_millis(2300));
    assert_eq!(
        h.reads().len(),
        count,
        "an inactive session must not reread its log every two seconds"
    );
    h.wake.store(true, Ordering::Release);
    let deadline = Instant::now() + Duration::from_secs(5);
    while h.reads().len() == count && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        h.reads().len() > count,
        "the retained socket still invalidates idle history"
    );
    drop(subscription);
}

#[test]
fn older_pages_arrive_after_install_and_preserve_the_reading_anchor() {
    let h = Host::new(200);
    h.paged.store(true, Ordering::Release);
    *h.events.lock().unwrap() = completed();
    let history = h.history();
    let mut pane = crate::pane::Pane::new(Some(history.session_key.clone()));
    pane.install(history, h.client.clone());
    let anchor = pane.rows[pane.list.logical_scroll_top().item_ix]
        .borrow()
        .row
        .id()
        .to_owned();
    assert!(
        !pane
            .transcript
            .as_ref()
            .unwrap()
            .entries
            .iter()
            .any(|e| e.id == "older-answer")
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !pane
        .transcript
        .as_ref()
        .unwrap()
        .entries
        .iter()
        .any(|e| e.id == "older-answer")
        && Instant::now() < deadline
    {
        pane.poll();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        pane.transcript
            .as_ref()
            .unwrap()
            .entries
            .iter()
            .any(|e| e.id == "older-answer")
    );
    assert_eq!(
        pane.rows[pane.list.logical_scroll_top().item_ix]
            .borrow()
            .row
            .id(),
        anchor
    );
}
#[test]
fn mentioning_a_worker_reads_the_saved_page_without_normalization_or_backfill() {
    let h = Host::new(200);
    h.paged.store(true, Ordering::Release);
    let source = serde_json::from_value(
        json!({"id":"codex-owned:reviewer","title":"Worker","repoPath":"/fixture","status":"idle"}),
    )
    .unwrap();
    let text = crate::composer::mention::thread_context(
        &h.client,
        vec![("Worker".into(), "codex-owned:reviewer".into())],
        vec![],
        source,
    );
    assert!(text.contains("Saved legacy answer"));
    assert!(h.reads().is_empty());
    assert!(
        !h.requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("before="))
    );
}

#[test]
fn null_cursor_keeps_saved_rows_and_stops_timed_polling() {
    let h = Host::new(200);
    let history = h.history();
    let mut state =
        crate::shell::session::worker_transcript::State::from_history(&history).unwrap();
    let mut transcript = Transcript::new(history);
    let before = transcript.rows.clone();
    let was_active = state.active;
    h.events.lock().unwrap().clear();
    apply_poll(&h, &mut transcript, &mut state);
    assert!(
        !state.cursor_available,
        "null is no cursor, not numeric position zero"
    );
    assert_eq!(
        state.active, was_active,
        "empty readback is not a terminal event"
    );
    assert_eq!(
        transcript.rows, before,
        "an empty readback retains existing work"
    );
}

#[test]
fn native_unknown_time_appends_without_reinterpreting_a_legacy_fallback_time() {
    let h = Host::new(200);
    *h.events.lock().unwrap() = vec![
        event(1, "dated", "Dated answer", "2026-01-02T00:00:02Z"),
        json!({"seq":2,"eventId":"unknown","type":"assistant","text":"Unknown time answer","ts":"2026-01-01T00:00:02Z","nativeTimestamp":""}),
    ];
    let history = h.history();
    let answers: Vec<_> = history
        .transcript
        .iter()
        .filter(|e| e.role == "assistant" && !e.text.is_empty())
        .map(|e| e.text.as_str())
        .collect();
    assert_eq!(answers, vec!["Dated answer", "Unknown time answer"]);
}
