//! The displayed saved verdict wins over a cached author-availability read.
use super::*;
use gpui::TestAppContext;
use serde_json::json;
use std::{
    io::{Read, Write},
    net::TcpListener,
};

#[gpui::test]
fn diff_request_changes_follows_current_verdict(cx: &mut TestAppContext) {
    for verdict in ["approved", "unreviewed", "rejected"] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming().take(3) {
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let header = String::from_utf8(header).unwrap();
                let reply = if header.contains("worker-corrections") {
                    // Availability can complete before the operator's newer verdict.
                    json!({"reviewCorrection":{"available":true,"savedRejection":true}})
                } else if header.contains("/diff?") {
                    json!({"headSha":"1".repeat(40),"diff":"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"})
                } else {
                    json!({"orchestratorReview":{"verdict":verdict}})
                }.to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).unwrap();
            }
        });
        let client = Client::authenticated(&origin, Some("fixture".into())).unwrap();
        let (view, visual) = cx.add_window_view(|window, cx| {
            DiffSurface::new(client, Target::Packet("verdict".into()), window, cx)
        });
        visual.run_until_parked();
        view.read_with(visual, |view, _| assert!(view.ready));
        if verdict == "rejected" {
            assert!(visual.debug_bounds("request-changes-open").is_some(), "Review must retain Request changes after constructor extraction");
            continue;
        }
        assert!(
            visual.debug_bounds("request-changes-open").is_none(),
            "{verdict} must not offer Request changes"
        );
        assert!(visual.debug_bounds("request-changes").is_none());
    }
}
