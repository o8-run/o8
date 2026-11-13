use super::*;

#[gpui::test]
fn approval_audit_fetch_is_bounded_and_show_more_expands_the_prefix(cx: &mut TestAppContext) {
    let events: Vec<_> = (0..400)
        .map(|i| json!({"type":"created","timestamp":400000-i}))
        .collect();
    let peer = Peer::with_history(vec![json!({"id":"large","title":"History",
        "sessionKey":"fixture","risk":"high","audit":events})]);
    let (inbox, cx) =
        cx.add_window_view(|_, cx| Inbox::new(peer.client.clone(), String::new(), cx));
    cx.run_until_parked();
    inbox.update(cx, |inbox, cx| inbox.select_lane(LANE, cx));
    cx.run_until_parked();
    inbox.read_with(cx, |inbox, _| assert_eq!(inbox.audit.rows.len(), 50));
    assert!(cx.debug_bounds("approval-audit-more").is_some());
    assert!(cx.debug_bounds("approval-audit-row-50").is_none());
    inbox.update(cx, |inbox, cx| inbox.audit_control(6, cx));
    cx.run_until_parked();
    inbox.read_with(cx, |inbox, _| assert_eq!(inbox.audit.rows.len(), 100));
    assert!(cx.debug_bounds("approval-audit-row-50").is_some());
    assert!(cx.debug_bounds("approval-audit-row-100").is_none());
    let requests = peer.requests.lock().unwrap();
    for limit in [50, 100] {
        assert!(requests.iter().any(|request| request.starts_with(&format!(
            "GET /api/panel/approvals?status=all&auditLimit={limit} "
        ))));
    }
}
