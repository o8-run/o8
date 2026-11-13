use super::*;

#[gpui::test]
fn approval_audit_all_time_ranges_include_the_boundary(cx: &mut TestAppContext) {
    let peer = Peer::new();
    let (inbox, cx) =
        cx.add_window_view(|_, cx| Inbox::new(peer.client.clone(), String::new(), cx));
    cx.run_until_parked();
    inbox.update(cx, |inbox, _| {
        inbox.audit.rows = flatten(&records());
        for (index, hours) in [(1, 1.), (2, 24.), (3, 168.), (4, 720.)] {
            inbox.audit.choose(2, index);
            assert_eq!(inbox.audit.visible(3000. + hours * 3600000.).len(), 2);
            assert!(inbox.audit.visible(3001. + hours * 3600000.).is_empty());
        }
        inbox.audit.clear();
        assert_eq!(inbox.audit.visible(f64::MAX).len(), 3);
    });
}

#[gpui::test]
fn approval_audit_empty_errors_and_long_filter_labels_are_readable(cx: &mut TestAppContext) {
    let peer = Peer::new();
    let (inbox, cx) =
        cx.add_window_view(|_, cx| Inbox::new(peer.client.clone(), String::new(), cx));
    cx.run_until_parked();
    inbox.update(cx, |inbox, cx| inbox.select_lane(LANE, cx));
    cx.run_until_parked();
    inbox.update(cx, |inbox, cx| {
        inbox.audit.rows.clear();
        inbox.audit.session = Some("long-session-".repeat(40));
        cx.notify();
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("approval-audit-empty").is_some());
    assert!(cx.debug_bounds("approval-audit-clear").is_some());
    assert!(
        cx.debug_bounds("approval-audit-session")
            .unwrap()
            .size
            .width
            <= gpui::px(180.)
    );
    inbox.update(cx, |inbox, cx| {
        inbox.audit.error = Some("HTTP 403".into());
        cx.notify();
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("approval-audit-error").is_some());
    assert!(cx.debug_bounds("approval-audit-retry").is_some());
    assert!(cx.debug_bounds("approval-audit-empty").is_none());
    inbox.update(cx, |inbox, cx| {
        inbox.audit.error = None;
        inbox.audit.rows = flatten(&records());
        cx.notify();
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("approval-audit-empty").is_some());
    inbox.update(cx, |inbox, cx| inbox.audit_control(3, cx));
    cx.run_until_parked();
    assert!(cx.debug_bounds("approval-audit-empty").is_none());
    assert!(cx.debug_bounds("approval-audit-clear").is_none());
}

#[gpui::test]
fn approval_audit_large_history_is_bounded_and_can_show_more(cx: &mut TestAppContext) {
    let peer = Peer::new();
    let (inbox, cx) =
        cx.add_window_view(|_, cx| Inbox::new(peer.client.clone(), String::new(), cx));
    cx.run_until_parked();
    inbox.update(cx, |inbox, cx| inbox.select_lane(LANE, cx));
    cx.run_until_parked();
    inbox.update(cx, |inbox, cx| {
        let approvals: Vec<_> = (0..400)
            .map(|i| {
                json!({"id":i.to_string(),"title":"Audit event",
            "audit":[{"type":"created","timestamp":1000}]})
            })
            .collect();
        inbox.audit.rows = flatten(&approvals);
        cx.notify();
    });
    cx.run_until_parked();
    assert!(
        cx.debug_bounds("approval-audit-more").is_some(),
        "a large history needs bounded disclosure"
    );
    assert!(cx.debug_bounds("approval-audit-row-50").is_none());
    inbox.update(cx, |inbox, cx| inbox.audit_control(6, cx));
    cx.run_until_parked();
    assert!(cx.debug_bounds("approval-audit-row-50").is_some());
    assert!(cx.debug_bounds("approval-audit-row-100").is_none());
}

#[gpui::test]
fn approval_audit_keeps_background_inbox_polling(cx: &mut TestAppContext) {
    let peer = Peer::new();
    let (inbox, cx) =
        cx.add_window_view(|_, cx| Inbox::new(peer.client.clone(), String::new(), cx));
    cx.run_until_parked();
    inbox.update(cx, |inbox, cx| inbox.select_lane(LANE, cx));
    cx.run_until_parked();
    peer.requests.lock().unwrap().clear();
    inbox.update(cx, |inbox, cx| {
        inbox.last_refresh = Instant::now() - Duration::from_secs(301);
        inbox.questions_at = Instant::now() - Duration::from_secs(11);
        inbox.tick(cx);
    });
    cx.run_until_parked();
    assert!(
        peer.requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.contains("/api/panel/supervisor-inbox")),
        "Needs-reply must keep refreshing while Audit is open"
    );
    assert!(
        peer.requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.contains("questionsOnly=1")),
        "the independent questions poll stays active"
    );
}
