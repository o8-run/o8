//! The actual Diff toolbar and note field in a headless GPUI window.
use crate::{client::Client, diff::Target, diff_ui::DiffSurface};
use gpui::{Modifiers, TestAppContext, px};
use serde_json::json;
use std::{
    io::{Read, Write},
    net::TcpListener,
};

#[gpui::test]
fn request_changes_toolbar_dismissal_regression(cx: &mut TestAppContext) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming().take(3) {
            let mut stream = stream.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                header.push(byte[0]);
            }
            let header = String::from_utf8(header).unwrap();
            let value = if header.contains("worker-corrections") {
                json!({"reviewCorrection":{"available":true,"maxNoteLength":80}})
            } else if header.contains("/diff?") {
                json!({"headSha":"1111111111111111111111111111111111111111", "diff":
                    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"})
            } else {
                json!({"orchestratorReview":{"verdict":"rejected"}})
            };
            let body = value.to_string();
            write!(
                stream,
                concat!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n",
                    "Content-Length: {}\r\nConnection: close\r\n\r\n{}"
                ),
                body.len(),
                body
            )
            .unwrap();
        }
    });
    let client = Client::authenticated(&origin, Some("fixture".into())).unwrap();
    let (_, cx) = cx.add_window_view(|window, cx| {
        DiffSurface::new(client, Target::Packet("layout-fixture".into()), window, cx)
    });
    cx.run_until_parked();
    let approve = cx.debug_bounds("diff-approve").unwrap();
    let trigger = cx.debug_bounds("request-changes-open").unwrap();
    let reject = cx.debug_bounds("diff-reject").unwrap();
    assert_eq!(
        trigger.top(),
        approve.top(),
        "Request changes belongs in the verdict row"
    );
    assert!(approve.left() < trigger.left() && trigger.left() < reject.left());
    assert!(cx.debug_bounds("request-changes-refresh").is_none());
    cx.simulate_click(trigger.center(), Modifiers::default());
    cx.simulate_input("Retain the public interface.");
    let send = cx.debug_bounds("request-changes-send").unwrap();
    let cancel = cx.debug_bounds("request-changes-cancel").unwrap();
    assert!(send.size.width < px(160.));
    assert_eq!(send.top(), cancel.top());
    cx.simulate_click(cancel.center(), Modifiers::default());
    assert!(cx.debug_bounds("request-changes-send").is_none());
    let trigger = cx.debug_bounds("request-changes-open").unwrap();
    cx.simulate_click(trigger.center(), Modifiers::default());
    cx.simulate_keystrokes("escape");
    assert!(cx.debug_bounds("request-changes-send").is_none());
    assert!(cx.debug_bounds("diff-approve").is_some());
}
