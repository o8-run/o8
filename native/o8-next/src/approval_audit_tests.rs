use super::*;
use gpui::TestAppContext;
use serde_json::json;
use std::io::{Read, Write};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

fn records() -> Vec<Value> {
    vec![
        json!({"id":"one","title":"Change","sessionKey":"z","risk":"high","updatedAt":1000,
        "audit":[{"type":"created","actor":"system"},
        {"type":"orchestrator_review","timestamp":3000,"actor":"orchestrator","approved":false,
        "reviewer":"review","diffSha":"abc","reviewedHeadSha":"c".repeat(40),"note":"Evidence",
        "findings":[{"file":"file.rs","line":12,"severity":"bug","description":"Broken", "resolution":"deferred","fixSuggestion":"Repair"}]}]}),
        json!({"id":"two","sessionKey":"a","risk":"low","updatedAt":3000,"audit":[{"type":"updated"}]}),
    ]
}
#[test]
fn approval_audit_flattens_fallback_stable_sort_and_structured_findings() {
    let rows = flatten(&records());
    assert_eq!(
        rows.iter()
            .map(|r| r.approval_id.as_str())
            .collect::<Vec<_>>(),
        ["one", "two", "one"]
    );
    assert_eq!(rows[2].timestamp, 1000.);
    let event = &rows[0].event;
    assert_eq!(event["reviewer"], "review");
    assert_eq!(event["approved"], false);
    assert_eq!(event["diffSha"], "abc");
    assert_eq!(event["reviewedHeadSha"], "c".repeat(40));
    assert_eq!(
        event["findings"][0],
        json!({"file":"file.rs","line":12,"severity":"bug","description":"Broken","resolution":"deferred","fixSuggestion":"Repair"})
    );
}

// A bounded peer tolerates idle/closed sockets and independent concurrent Inbox reads.
struct Peer {
    client: Client,
    requests: Arc<Mutex<Vec<String>>>,
    fail: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Peer {
    fn new() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let client = Client::authenticated(
            &format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port()),
            Some("fixture".into()),
        )
        .unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let fail = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (seen, refused, done) = (requests.clone(), fail.clone(), stop.clone());
        let worker = std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        let seen = seen.clone();
                        let refused = refused.clone();
                        std::thread::spawn(move || {
                            let _ = socket.set_nonblocking(false);
                            let _ = socket.set_read_timeout(Some(Duration::from_millis(300)));
                            let mut bytes = Vec::new();
                            while !bytes.ends_with(b"\r\n\r\n") && bytes.len() < 8192 {
                                let mut chunk = [0; 1024];
                                let Ok(count) = socket.read(&mut chunk) else {
                                    return;
                                };
                                if count == 0 {
                                    return;
                                }
                                bytes.extend_from_slice(&chunk[..count]);
                            }
                            let request = String::from_utf8_lossy(&bytes).to_string();
                            let audit = request.starts_with("GET /api/panel/approvals?status=all ");
                            seen.lock().unwrap().push(request);
                            let status = if audit && refused.load(Ordering::Relaxed) {
                                "403 Forbidden"
                            } else {
                                "200 OK"
                            };
                            let body = if audit { json!({"approvals":records()}) } else { json!({"items":[],"maintainer":{"contributions":[],"replies":[],"sources":[],"truncated":false,"repliesTruncated":false},"approvals":[]}) }.to_string();
                            let _ = write!(
                                socket,
                                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            );
                        });
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(2)),
                }
            }
        });
        Self {
            client,
            requests,
            fail,
            stop,
            worker: Some(worker),
        }
    }
    fn audit_reads(&self) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.starts_with("GET /api/panel/approvals?status=all "))
            .count()
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

#[gpui::test]
fn approval_audit_filters_clear_and_read_only_handlers(cx: &mut TestAppContext) {
    let peer = Peer::new();
    let (inbox, cx) =
        cx.add_window_view(|_, cx| Inbox::new(peer.client.clone(), String::new(), cx));
    cx.run_until_parked();
    inbox.update(cx, |inbox, cx| inbox.select_lane(LANE, cx));
    cx.run_until_parked();
    for selector in ["approval-audit-session", "approval-audit-risk", "approval-audit-range",
        "approval-audit-refresh"] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    inbox.update(cx, |inbox, cx| {
        assert_eq!(inbox.audit.options(0), ["All sessions", "a", "z"]);
        inbox.audit.choose(0, 2);
        inbox.audit.choose(1, 1);
        inbox.audit.choose(2, 1);
        assert_eq!(inbox.audit.visible(3602000.).len(), 1);
        inbox.audit.choose(1, 3);
        assert!(inbox.audit.visible(3602000.).is_empty());
        inbox.selected = 2;
        inbox.audit_control(3, cx);
        assert_eq!(inbox.selected, 0);
        assert_eq!(inbox.audit.visible(3602000.).len(), 3);
        let card = Card::approval(&json!({"id":"pending","status":"pending"}));
        assert!(!inbox.can_resolve(&card));
        inbox.respond(&card, cx);
        assert!(inbox.notice.is_empty());
        assert!(inbox.cards[LANE].is_empty());
        inbox.select_lane(VIEWS.len(), cx);
        assert_eq!(inbox.lane, LANE);
    });
}

#[gpui::test]
fn approval_audit_refresh_busy_stale_error_retry_and_poll(cx: &mut TestAppContext) {
    let peer = Peer::new();
    let (inbox, cx) =
        cx.add_window_view(|_, cx| Inbox::new(peer.client.clone(), "project".into(), cx));
    cx.run_until_parked();
    inbox.update(cx, |inbox, cx| {
        inbox.select_lane(LANE, cx);
        inbox.load(cx);
        inbox.audit_control(4, cx);
        assert!(inbox.audit.loading);
        assert!(!inbox.audit.loaded);
    });
    cx.run_until_parked();
    assert_eq!(peer.audit_reads(), 1);
    peer.fail.store(true, Ordering::Relaxed);
    inbox.update(cx, |inbox, cx| {
        inbox.audit.choose(0, 2);
        inbox.audit.choose(1, 1);
        inbox.load(cx);
        assert!(inbox.audit.loaded && inbox.audit.loading);
    });
    cx.run_until_parked();
    inbox.update(cx, |inbox, _| {
        assert_eq!(inbox.audit.error.as_deref(), Some("HTTP 403"));
        assert_eq!(inbox.audit.rows.len(), 3);
        assert_eq!(inbox.audit.session.as_deref(), Some("z"));
        assert_eq!(inbox.audit.risk, 1);
    });
    peer.fail.store(false, Ordering::Relaxed);
    inbox.update(cx, |inbox, cx| inbox.audit_control(5, cx));
    cx.run_until_parked();
    inbox.update(cx, |inbox, cx| {
        assert!(inbox.audit.error.is_none());
        assert_eq!(inbox.audit.session.as_deref(), Some("z"));
        inbox.audit.last_refresh = Instant::now() - Duration::from_secs(31);
        inbox.tick(cx);
        inbox.tick(cx);
    });
    cx.run_until_parked();
    assert_eq!(peer.audit_reads(), 4);
    assert!(
        peer.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.starts_with("GET /api/panel/approvals?status=all "))
            .all(|r| {
                r.to_lowercase().contains("authorization: bearer fixture") && !r.contains("scope=")
            })
    );
}

#[gpui::test]
fn approval_audit_direct_shortcuts_menus_and_navigation_are_safe(cx: &mut TestAppContext) {
    let peer = Peer::new();
    let (inbox, cx) =
        cx.add_window_view(|_, cx| Inbox::new(peer.client.clone(), String::new(), cx));
    cx.run_until_parked();
    inbox.update(cx, |inbox, cx| inbox.select_lane(LANE, cx));
    cx.run_until_parked();
    inbox.update_in(cx, |inbox, window, cx| {
        let down = |key| KeyDownEvent {
            keystroke: gpui::Keystroke::parse(key).unwrap(),
            is_held: false,
        };
        let card = Card::approval(&json!({"id":"pending","status":"pending"}));
        inbox.decide(card.clone(), true, window, cx);
        inbox.decide(card, false, window, cx);
        assert!(inbox.busy.is_none());
        for key in ["enter", "space", "up", "down", "tab"] {
            inbox.key_down(&down(key), window, cx);
            assert_eq!(inbox.lane, LANE);
        }
        inbox.audit.loading = true;
        inbox.audit.focus[2].focus(window);
        inbox.key_down(&down("tab"), window, cx);
        assert!(inbox.audit.focus[0].is_focused(window));
        inbox.audit.loading = false;
        inbox.audit_control(0, cx);
        inbox.key_down(&down("down"), window, cx);
        inbox.key_down(&down("enter"), window, cx);
        assert_eq!(inbox.audit.session.as_deref(), Some("a"));
        inbox.audit_control(2, cx);
        inbox.key_down(&down("down"), window, cx);
        inbox.key_down(&down("enter"), window, cx);
        assert_eq!(inbox.audit.range, 1);
        inbox.audit_control(3, cx);
        inbox.audit_control(1, cx);
        inbox.key_down(&down("down"), window, cx);
        inbox.key_down(&down("enter"), window, cx);
        assert_eq!(inbox.audit.risk, 1);
        assert!(inbox.audit.menu.is_none());
        inbox.audit_control(2, cx);
        inbox.key_down(&down("escape"), window, cx);
        assert!(inbox.audit.menu.is_none());
        assert_eq!(inbox.audit.range, 0);
        inbox.audit_control(2, cx);
        inbox.key_down(&down("up"), window, cx); // Cancel is last.
        inbox.key_down(&down("enter"), window, cx);
        assert!(inbox.audit.menu.is_none());
        assert_eq!(inbox.audit.range, 0);
        inbox.key_down(&down("right"), window, cx);
        assert_eq!(inbox.lane, 0);
        inbox.key_down(&down("left"), window, cx);
        assert_eq!(inbox.lane, LANE);
        inbox.key_down(&down("home"), window, cx);
        assert_eq!(inbox.lane, 0);
        inbox.key_down(&down("end"), window, cx);
        assert_eq!(inbox.lane, LANE);
    });
    cx.run_until_parked();
    assert!(
        peer.requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.starts_with("GET "))
    );
}

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
    let (inbox, cx) = cx.add_window_view(|_, cx| Inbox::new(peer.client.clone(), String::new(), cx));
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
    assert!(cx.debug_bounds("approval-audit-session").unwrap().size.width <= gpui::px(180.));
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
