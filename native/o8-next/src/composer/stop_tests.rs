use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

/// After Stop, the server settles the stopped turn's queue row as applied
/// (#5193), so the client must leave the queue alone: a held row is a
/// message that never started, and removing it would lose it.
#[test]
fn stop_leaves_the_queue_to_the_server() {
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    let ws_port = socket.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let (stream, _) = socket.accept().unwrap();
        let mut ws = tungstenite::accept(stream).unwrap();
        let frame = ws.read().unwrap();
        assert!(frame.to_text().unwrap().contains("orchestrator-interrupt"));
        let ack = r#"{"channel":"orchestrator","event":"interrupt-ack","data":{"threadId":"stopped-chat","state":"accepted"}}"#;
        ws.send(tungstenite::Message::Text(ack.into())).unwrap();
        let _ = ws.read();
    });
    let http = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = http.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    std::thread::spawn(move || {
        for stream in http.incoming() {
            let mut stream = stream.unwrap();
            let mut buf = [0u8; 8192];
            let read = stream.read(&mut buf).unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..read]).to_string();
            let line = head.lines().next().unwrap_or("").to_owned();
            let mut parts = line.split(' ');
            let method = parts.next().unwrap_or("").to_owned();
            let path = parts
                .next()
                .unwrap_or("")
                .split('?')
                .next()
                .unwrap()
                .to_owned();
            let body = match path.as_str() {
                "/api/panel/ws-info" => format!(r#"{{"wsPort":{ws_port},"wsToken":"fixture"}}"#),
                "/api/orchestrator/composer-queue" => r#"{"items":[{"id":"next","status":"held","admittedAt":"2026-11-03T01:50:24Z"}]}"#.to_owned(),
                _ => "{}".to_owned(),
            };
            seen.lock().unwrap().push(format!("{method} {path}"));
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            );
        }
    });
    let client = crate::client::Client::new(&format!("http://127.0.0.1:{port}")).unwrap();
    let session: super::Session = serde_json::from_value(serde_json::json!({
        "id": "stopped-chat", "title": "t", "status": "running", "repoPath": "/repo"
    }))
    .unwrap();
    assert_eq!(
        super::stop_chat(&client, &session, "/repo", None).as_deref(),
        Ok("accepted")
    );
    assert_eq!(*requests.lock().unwrap(), ["GET /api/panel/ws-info"]);
}
