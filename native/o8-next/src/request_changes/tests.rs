use super::*;
use gpui::TestAppContext;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    time::Duration,
};

#[gpui::test]
fn request_changes_note_does_not_trigger_diff_shortcuts(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming().take(3) {
            let mut stream = stream.unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0];
            while !bytes.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
            }
            let header = String::from_utf8(bytes).unwrap();
            let value = if header.contains("worker-corrections") {
                json!({"reviewCorrection":{"available":true}})
            } else if header.contains("/diff?") {
                json!({"headSha":"1111111111111111111111111111111111111111","diff":"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"})
            } else {
                json!({"orchestratorReview":{"verdict":"rejected"}})
            };
            let body = value.to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
    });
    let client = Client::authenticated(&origin, Some("fixture".into())).unwrap();
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::diff_ui::DiffSurface::new(
            client,
            crate::diff::Target::Packet("note-fixture".into()),
            window,
            cx,
        )
    });
    cx.run_until_parked();
    let approve = cx.debug_bounds("diff-approve").unwrap();
    let request = cx.debug_bounds("request-changes-open").unwrap();
    let reject = cx.debug_bounds("diff-reject").unwrap();
    assert_eq!(approve.top(), request.top());
    assert_eq!(request.top(), reject.top());
    assert!(approve.left() < request.left() && request.left() < reject.left());
    assert!(cx.debug_bounds("request-changes-refresh").is_none());
    let open = cx.debug_bounds("request-changes-open").unwrap();
    cx.simulate_click(open.center(), gpui::Modifiers::default());
    cx.simulate_input("Keep the public interface stable.");
    cx.simulate_keystrokes("u s r");
    view.read_with(cx, |s, _| {
        assert!(!s.split, "Typing a note must not switch the diff mode");
        assert!(s.ready, "Typing r must not refresh the diff");
    });
}

#[gpui::test]
fn request_changes_retains_note_and_retries_same_saved_review(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = bodies.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().take(3) {
            let mut stream = stream.unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0];
            while !bytes.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
            }
            let header = String::from_utf8(bytes).unwrap();
            let length = header
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|n| n.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            let mut body = vec![0; length];
            stream.read_exact(&mut body).unwrap();
            let (status, value) = if header.starts_with("GET ") {
                assert!(header.contains("packetId=packet-review"));
                (
                    200,
                    json!({"reviewCorrection":{"available":true,"repoPath":"/fixture","threadId":"parent","review":{"packetId":"packet-review","approvalId":"rejection","reviewedHeadSha":"1111111111111111111111111111111111111111","surfaceId":"author","runId":"run"}}}),
                )
            } else {
                let mut bodies = captured.lock().unwrap();
                bodies.push(serde_json::from_slice(&body).unwrap());
                if bodies.len() == 1 {
                    (503, json!({"error":"Temporary delivery failure"}))
                } else {
                    (
                        200,
                        json!({"receipt":{"deliveries":[{"status":"delivered","note":"Runtime accepted a new turn on the same worker."}]}}),
                    )
                }
            };
            let body = value.to_string();
            write!(stream, "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    });
    let client = Client::authenticated(&origin, Some("fixture".into())).unwrap();
    let (view, cx) =
        cx.add_window_view(|_, cx| RequestChanges::new(client, "packet-review".into(), cx));
    for _ in 0..100 {
        cx.run_until_parked();
        if !view.read_with(cx, |s, _| s.loading) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    cx.update(|window, cx| view.update(cx, |s, cx| s.open(window, cx)));
    view.update(cx, |s, cx| {
        s.input
            .update(cx, |input, cx| input.set_text("Keep the API stable", cx))
    });
    assert!(cx.debug_bounds("request-changes-send").is_some());
    view.update(cx, |s, cx| {
        s.send(cx);
        assert!(s.busy);
        s.send(cx); // Duplicate submission before the first task settles is inert.
    });
    for _ in 0..100 {
        cx.run_until_parked();
        if !view.read_with(cx, |s, _| s.busy) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    view.read_with(cx, |s, cx| {
        assert!(s.notice.contains("Temporary delivery failure"));
        assert_eq!(s.input.read(cx).text, "Keep the API stable");
        assert!(s.pending.is_some());
    });
    let send = cx.debug_bounds("request-changes-send").unwrap();
    let cancel = cx.debug_bounds("request-changes-cancel").unwrap();
    assert!(send.size.width < gpui::px(160.));
    assert_eq!(send.top(), cancel.top());
    assert!(cx.debug_bounds("request-changes-note-readonly").is_some());
    cx.simulate_click(cancel.center(), gpui::Modifiers::default());
    view.read_with(cx, |s, cx| {
        assert!(!s.open);
        assert_eq!(s.input.read(cx).text, "Keep the API stable");
        assert!(s.pending.is_some());
    });
    cx.update(|window, cx| view.update(cx, |s, cx| s.open(window, cx)));
    cx.simulate_keystrokes("escape");
    assert!(!view.read_with(cx, |s, _| s.open));
    cx.update(|window, cx| view.update(cx, |s, cx| s.open(window, cx)));
    cx.simulate_keystrokes("cmd-enter");
    for _ in 0..100 {
        cx.run_until_parked();
        if !view.read_with(cx, |s, _| s.busy) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0], bodies[1]);
    assert_eq!(bodies[0]["note"], "Keep the API stable");
    view.read_with(cx, |s, cx| {
        assert!(!s.open);
        assert!(s.input.read(cx).text.is_empty());
        assert_eq!(
            s.outcome(),
            "Runtime accepted a new turn on the same worker."
        );
        assert_eq!(s.availability["reason"], s.notice);
    });
    assert!(cx.debug_bounds("request-changes-notice").is_some());
}

#[gpui::test]
fn request_changes_enforces_remaining_note_room(cx: &mut TestAppContext) {
    let client = Client::authenticated("http://127.0.0.1:1", Some("fixture".into())).unwrap();
    let (view, cx) = cx.add_window_view(|_, cx| RequestChanges::new(client, "limit".into(), cx));
    cx.run_until_parked();
    view.update(cx, |s, cx| {
        s.availability = json!({"available":true,"maxNoteLength":3});
        s.loading = false;
        s.notice.clear();
        cx.notify();
    });
    cx.update(|window, cx| view.update(cx, |s, cx| s.open(window, cx)));
    cx.run_until_parked();
    assert!(cx.debug_bounds("request-changes-note-room-3").is_some());
    cx.simulate_input("🙂🙂");
    assert!(cx.debug_bounds("request-changes-note-over-1").is_some());
    cx.simulate_keystrokes("cmd-enter");
    view.read_with(cx, |s, _| {
        assert!(!s.busy);
        assert!(s.pending.is_none());
        assert!(s.notice.contains("1 character too long"));
    });
}
