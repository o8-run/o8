//! Direct Activity handlers on the headless platform; no simulated input.
use super::*;
use gpui::TestAppContext;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
struct Peer {
    origin: String,
    stop: Arc<AtomicBool>,
    mode: Arc<AtomicUsize>,
    posts: Arc<Mutex<Vec<(String, Value)>>>,
}
fn row() -> Row {
    Row {
        kind: "packet",
        id: "packet-merge".into(),
        repo: None,
        repo_identity: "local".into(),
        title: "Fixture packet".into(),
        date: String::new(),
        ci: vec![],
        data: json!({"id":"packet-merge","title":"Fixture packet","status":"awaiting_review",
            "workspaceTargetPath":"/fixture", "lane":{"laneId":"lane-merge"},
            "review":{"approved":true,"reviewedHeadSha":"a".repeat(40)}}),
    }
}
impl Peer {
    fn new(mode: usize) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let mode = Arc::new(AtomicUsize::new(mode));
        let state = mode.clone();
        let posts = Arc::new(Mutex::new(vec![]));
        let seen = posts.clone();
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                };
                let state = state.clone();
                let seen = seen.clone();
                // Refresh can fetch the feed while replaying a receipt. An idle
                // connection must not block the fixture's other requests.
                std::thread::spawn(move || {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut header = vec![];
                    while !header.ends_with(b"\r\n\r\n") {
                        let mut byte = [0];
                        if stream.read_exact(&mut byte).is_err() {
                            return;
                        }
                        header.push(byte[0]);
                    }
                    let header = String::from_utf8(header).unwrap();
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    let mut body = vec![0; length];
                    if stream.read_exact(&mut body).is_err() {
                        return;
                    }
                    let path = header
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .to_owned();
                    let (status, reply) = if header.starts_with("POST ") {
                        let body: Value = serde_json::from_slice(&body).unwrap();
                        let mut posts = seen.lock().unwrap();
                        posts.push((path.clone(), body));
                        if path != "/api/orchestrator/merge" {
                            (200, json!({"ok":true,"note":"Lane command dispatched."}))
                        } else {
                            match state.load(Ordering::SeqCst) {
                                0 => (
                                    200,
                                    json!({"ok":true,"result":{"merged":false,"note":"Fixture review is rejected."}}),
                                ),
                                1 => (
                                    200,
                                    json!({"ok":true,"result":{"merged":true,"note":"Fixture packet merged."}}),
                                ),
                                2 => (
                                    409,
                                    json!({"ok":false,"error":{"code":"outcome_unknown","message":"Fixture merge outcome is quarantined."}}),
                                ),
                                3 if posts.len() == 1 => (
                                    202,
                                    json!({"ok":true,"result":{"inProgress":true,"merged":false}}),
                                ),
                                3 => (
                                    200,
                                    json!({"ok":true,"result":{"merged":true,"note":"Fixture packet merged."}}),
                                ),
                                _ => (
                                    409,
                                    json!({"ok":false,"error":{"code":"head_sha_mismatch","message":"Fixture reviewed HEAD moved."}}),
                                ),
                            }
                        }
                    } else if path.starts_with("/api/orchestrator/state") {
                        (200, json!({"mission":{"packets":[row().data]}}))
                    } else {
                        (
                            200,
                            json!({"repos":[],"proposals":[],"dossiers":[],"directives":[]}),
                        )
                    };
                    let body = reply.to_string();
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                });
            }
        });
        Self {
            origin,
            stop,
            mode,
            posts,
        }
    }
    fn client(&self) -> Client {
        Client::authenticated(&self.origin, Some("fixture-operator".into())).unwrap()
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

#[gpui::test]
fn native_packet_merge_uses_canonical_route_and_preserves_refusal(cx: &mut TestAppContext) {
    let peer = Peer::new(0);
    let (view, cx) =
        cx.add_window_view(|_, cx| ActivityPane::new(peer.client(), "/fixture".into(), cx));
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        view.act(Action::Lane(row(), "merge"), cx);
        assert!(view.pending);
        view.act(Action::Lane(row(), "merge"), cx);
    });
    cx.run_until_parked();
    let posts = peer.posts.lock().unwrap();
    assert_eq!(posts.len(), 1, "busy blocks duplicate submissions");
    assert_eq!(posts[0].0, "/api/orchestrator/merge");
    assert_eq!(posts[0].1["packetId"], "packet-merge");
    assert_eq!(posts[0].1["expectedHeadSha"], "a".repeat(40));
    assert!(!posts[0].1["idempotencyKey"].as_str().unwrap().is_empty());
    view.read_with(cx, |view, _| {
        assert!(view.notice_error);
        assert_eq!(view.notice, "Fixture review is rejected.");
        assert!(!view.pending);
    });
}
#[gpui::test]
fn native_packet_merge_unsettled_refresh_reuses_exact_body(cx: &mut TestAppContext) {
    let peer = Peer::new(2);
    let (view, cx) =
        cx.add_window_view(|_, cx| ActivityPane::new(peer.client(), "/fixture".into(), cx));
    cx.run_until_parked();
    view.update(cx, |view, cx| view.act(Action::Lane(row(), "merge"), cx));
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(view.unsettled.is_some());
        assert!(
            view.notice
                .contains("Fixture merge outcome is quarantined.")
        );
    });
    peer.mode.store(1, Ordering::SeqCst);
    view.update(cx, |view, cx| view.act(Action::Refresh, cx));
    cx.run_until_parked();
    let posts = peer.posts.lock().unwrap();
    assert_eq!(posts.len(), 2);
    assert_eq!(
        posts[0], posts[1],
        "Refresh replays the exact saved packet merge"
    );
    view.read_with(cx, |view, _| {
        assert!(view.unsettled.is_none());
        assert!(!view.notice_error);
        assert_eq!(view.notice, "Fixture packet merged.");
    });
}
#[gpui::test]
fn native_packet_merge_polls_same_receipt_until_merged(cx: &mut TestAppContext) {
    let peer = Peer::new(3);
    let (view, cx) =
        cx.add_window_view(|_, cx| ActivityPane::new(peer.client(), "/fixture".into(), cx));
    cx.run_until_parked();
    view.update(cx, |view, cx| view.act(Action::Lane(row(), "merge"), cx));
    cx.run_until_parked();
    let posts = peer.posts.lock().unwrap();
    assert_eq!(posts.len(), 2);
    assert_eq!(posts[0], posts[1]);
    view.read_with(cx, |view, _| {
        assert_eq!(view.notice, "Fixture packet merged.")
    });
}
#[gpui::test]
fn native_packet_merge_keeps_unbound_lane_semantics(cx: &mut TestAppContext) {
    let peer = Peer::new(1);
    let (view, cx) =
        cx.add_window_view(|_, cx| ActivityPane::new(peer.client(), "/fixture".into(), cx));
    cx.run_until_parked();
    let mut lane = row();
    lane.kind = "lane";
    lane.data["id"] = Value::Null;
    view.update(cx, |view, cx| view.act(Action::Lane(lane, "merge"), cx));
    cx.run_until_parked();
    let posts = peer.posts.lock().unwrap();
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0].0, "/api/lanes");
    assert_eq!(posts[0].1["verb"], "merge");
}

#[gpui::test]
fn native_packet_merge_refusal_retry_gets_fresh_identity(cx: &mut TestAppContext) {
    let peer = Peer::new(0);
    let (view, cx) =
        cx.add_window_view(|_, cx| ActivityPane::new(peer.client(), "/fixture".into(), cx));
    cx.run_until_parked();
    view.update(cx, |view, cx| view.act(Action::Lane(row(), "merge"), cx));
    cx.run_until_parked();
    peer.mode.store(1, Ordering::SeqCst);
    view.update(cx, |view, cx| view.act(Action::Lane(row(), "merge"), cx));
    cx.run_until_parked();
    let posts = peer.posts.lock().unwrap();
    assert_eq!(posts.len(), 2);
    assert_ne!(posts[0].1["idempotencyKey"], posts[1].1["idempotencyKey"]);
    assert_eq!(posts[0].1["expectedHeadSha"], posts[1].1["expectedHeadSha"]);
    view.read_with(cx, |view, _| {
        assert_eq!(view.notice, "Fixture packet merged.")
    });
}
#[gpui::test]
fn native_packet_merge_replays_saved_head_before_reading_changed_row(cx: &mut TestAppContext) {
    let peer = Peer::new(2);
    let (view, cx) =
        cx.add_window_view(|_, cx| ActivityPane::new(peer.client(), "/fixture".into(), cx));
    cx.run_until_parked();
    view.update(cx, |view, cx| view.act(Action::Lane(row(), "merge"), cx));
    cx.run_until_parked();
    peer.mode.store(1, Ordering::SeqCst);
    let mut changed = row();
    changed.data["review"]["reviewedHeadSha"] = json!("b".repeat(40));
    view.update(cx, |view, cx| view.act(Action::Lane(changed, "merge"), cx));
    cx.run_until_parked();
    let posts = peer.posts.lock().unwrap();
    assert_eq!(posts.len(), 2);
    assert_eq!(posts[0], posts[1]);
    assert_eq!(posts[1].1["expectedHeadSha"], "a".repeat(40));
}
#[gpui::test]
fn native_packet_merge_invalid_saved_head_fails_closed(cx: &mut TestAppContext) {
    let peer = Peer::new(1);
    let (view, cx) =
        cx.add_window_view(|_, cx| ActivityPane::new(peer.client(), "/fixture".into(), cx));
    cx.run_until_parked();
    let mut invalid = row();
    invalid.data["review"]["reviewedHeadSha"] = json!("invalid");
    view.update(cx, |view, cx| view.act(Action::Lane(invalid, "merge"), cx));
    cx.run_until_parked();
    assert!(peer.posts.lock().unwrap().is_empty());
    view.read_with(cx, |view, _| {
        assert!(view.notice_error);
        assert!(!view.pending);
        assert_eq!(
            view.notice,
            "Saved review HEAD is invalid. Refresh the packet before merging."
        );
    });
}
#[gpui::test]
fn native_packet_merge_http_refusal_keeps_exact_message(cx: &mut TestAppContext) {
    let peer = Peer::new(4);
    let (view, cx) =
        cx.add_window_view(|_, cx| ActivityPane::new(peer.client(), "/fixture".into(), cx));
    cx.run_until_parked();
    view.update(cx, |view, cx| view.act(Action::Lane(row(), "merge"), cx));
    cx.run_until_parked();
    assert_eq!(peer.posts.lock().unwrap().len(), 1);
    view.read_with(cx, |view, _| {
        assert!(view.notice_error);
        assert!(view.unsettled.is_none());
        assert_eq!(view.notice, "Fixture reviewed HEAD moved.");
    });
}
