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
    assert!(history.page.as_ref().unwrap().has_more);
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
fn apply_poll(h: &Host, t: &mut Transcript, state: &mut crate::worker_transcript::State) {
    let entries = state.poll(&h.client).unwrap();
    t.apply(&json!({"channel":"history","event":"update","data":{"sessionKey":t.key,"replace":false,"entries":entries}}));
}
#[test]
fn steer_insertion_does_not_duplicate_the_answer_or_skip_the_steer() {
    let h = Host::new(200);
    *h.events.lock().unwrap() = vec![event(1, "answer", "Final answer", "2026-01-01T00:00:02Z")];
    let history = h.history();
    let mut state = crate::worker_transcript::State::from_history(&history).unwrap();
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
    let mut state = crate::worker_transcript::State::from_history(&history).unwrap();
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
