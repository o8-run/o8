//! Real HTTP/socket readback lifecycle, including completed-session invalidations.
use crate::{
    client::Client,
    model::{History, Row},
    stream::Transcript,
    transport::{self, Incoming},
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
struct Host {
    client: Client,
    events: Arc<Mutex<Vec<Value>>>,
    key: Arc<Mutex<String>>,
    requests: Arc<Mutex<Vec<String>>>,
    wake: Arc<AtomicBool>,
    connected: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    server: Option<std::thread::JoinHandle<()>>,
}
fn initial() -> Vec<Value> {
    vec![
        json!({"seq":1,"type":"tool_call","tool":"exec_command","callId":"a","args":"{\"cmd\":\"printf first\"}"}),
    ]
}
fn completed() -> Vec<Value> {
    let mut events = initial();
    events.extend([
        json!({"seq":2,"type":"tool_result","tool":"exec_command","callId":"a","ok":true,"summary":"first"}),
        json!({"seq":3,"type":"assistant","text":"Review complete."}),json!({"seq":4,"type":"done","exitCode":0})]);
    events
}
impl Host {
    fn new(status: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let client =
            Client::authenticated(&format!("http://{}", listener.local_addr().unwrap()), None)
                .unwrap();
        let events = Arc::new(Mutex::new(initial()));
        let normalized = events.clone();
        let key = Arc::new(Mutex::new("codex-owned:reviewer".to_string()));
        let response_key = key.clone();
        let requests = Arc::new(Mutex::new(vec![]));
        let log = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let wake = Arc::new(AtomicBool::new(false));
        let waking = wake.clone();
        let connected = Arc::new(AtomicBool::new(false));
        let socket_ready = connected.clone();
        let server = std::thread::spawn(move || {
            let mut sockets = Vec::new();
            while !stopped.load(Ordering::Acquire) {
                let mut stream = match listener.accept() {
                    Ok((s, _)) => s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::park_timeout(Duration::from_millis(1));
                        continue;
                    }
                    Err(e) => panic!("fixture accept: {e}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut buf = [0; 8192];
                let n = stream.peek(&mut buf).unwrap();
                let request = String::from_utf8_lossy(&buf[..n]);
                log.lock()
                    .unwrap()
                    .push(request.lines().next().unwrap().to_owned());
                if request.starts_with("GET /ws?") {
                    let stop = stopped.clone();
                    let wake = waking.clone();
                    let ready = socket_ready.clone();
                    sockets.push(std::thread::spawn(move || {
                        let mut socket=tungstenite::accept(stream).unwrap();let _=socket.read().unwrap();
                        socket.get_mut().set_read_timeout(Some(Duration::from_millis(50))).unwrap();
                        let frame=json!({"channel":"history","event":"update","data":{"sessionKey":"codex-owned:reviewer","entries":[{"id":"live","role":"assistant","text":"Live legacy answer"}]}}).to_string();
                        socket.send(tungstenite::Message::Text(frame.clone().into())).unwrap();ready.store(true,Ordering::Release);
                        while !stop.load(Ordering::Acquire) {
                            if wake.swap(false,Ordering::AcqRel) && socket.send(tungstenite::Message::Text(frame.clone().into())).is_err(){break;}
                            match socket.read() {
                                Ok(tungstenite::Message::Close(_))=>break,
                                Err(tungstenite::Error::Io(e)) if matches!(e.kind(),std::io::ErrorKind::WouldBlock|std::io::ErrorKind::TimedOut)=>{},
                                Err(_)=>break,_=>{}
                            }
                        }
                    }));
                    continue;
                }
                let n = stream.read(&mut buf).unwrap();
                let request = String::from_utf8_lossy(&buf[..n]);
                let (code, body) = if request.contains("/api/panel/ws-info") {
                    (200, json!({"wsPort":port,"wsToken":"fixture-token"}))
                } else if request.contains("/api/mobile/history") {
                    (
                        200,
                        json!({"sessionKey":"codex-owned:reviewer","transcript":[{"id":"prompt","role":"user","text":"Review the patch."},{"id":"legacy","role":"assistant","text":"Saved legacy answer"}]}),
                    )
                } else {
                    assert!(request.contains("/api/orchestrator/packet-transcript"));
                    let cursor = request
                        .split("cursor=")
                        .nth(1)
                        .and_then(|s| s.split(['&', ' ']).next())
                        .unwrap()
                        .parse::<u64>()
                        .unwrap();
                    let page: Vec<_> = normalized
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|e| e["seq"].as_u64().unwrap() > cursor)
                        .take(200)
                        .cloned()
                        .collect();
                    (
                        status,
                        json!({"sessionKey":*response_key.lock().unwrap(),"nextCursor":page.last().map(|e|e["seq"].clone()),"events":page}),
                    )
                };
                let body = body.to_string();
                let reason = if code == 200 { "OK" } else { "Refused" };
                write!(stream,"HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
            for socket in sockets {
                socket.join().unwrap();
            }
        });
        Self {
            client,
            events,
            key,
            requests,
            wake,
            connected,
            stop,
            server: Some(server),
        }
    }
    fn history(&self) -> History {
        self.client.history("codex-owned:reviewer").unwrap()
    }
    fn reads(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.contains("/packet-transcript"))
            .cloned()
            .collect()
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let result = self.server.take().unwrap().join();
        if !std::thread::panicking() {
            result.unwrap();
        }
    }
}
fn next_frame(subscription: &transport::Subscription) -> Value {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        match subscription
            .receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("a live cursor update arrives")
        {
            Incoming::Frame(frame) => return frame,
            _ => {}
        }
    }
}
fn steps(t: &Transcript) -> Vec<crate::activity::Step> {
    t.rows
        .iter()
        .flat_map(|r| match r {
            Row::Activity { steps, .. } => steps.clone(),
            _ => vec![],
        })
        .collect()
}

#[test]
fn worker_subscription_uses_cursor_updates_and_stops_periodic_reads_on_done() {
    let host = Host::new(200);
    let history = host.history();
    *host.events.lock().unwrap() = completed();
    let subscription = transport::subscribe_history(host.client.clone(), &history);
    let mut t = Transcript::new(history);
    let frame = next_frame(&subscription);
    assert_eq!(frame["data"]["replace"], false);
    assert!(t.apply(&frame));
    let steps = steps(&t);
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].status, "ok");
    assert_eq!(steps[0].output.as_deref(), Some("first"));
    std::thread::sleep(Duration::from_millis(300));
    let before = host.reads().len();
    std::thread::sleep(Duration::from_millis(2100));
    assert_eq!(
        host.reads().len(),
        before,
        "completed sessions have no periodic HTTP reads"
    );
    assert!(host.reads().iter().skip(1).all(|r| !r.contains("cursor=0")));
    drop(subscription);
}
#[test]
fn a_finished_session_resumes_on_socket_invalidation_without_reopening() {
    let host = Host::new(200);
    *host.events.lock().unwrap() = completed();
    let history = host.history();
    let subscription = transport::subscribe_history(host.client.clone(), &history);
    let mut t = Transcript::new(history);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !host.connected.load(Ordering::Acquire) {
        assert!(
            Instant::now() < deadline,
            "completion keeps its invalidation socket"
        );
        std::thread::park_timeout(Duration::from_millis(5));
    }
    std::thread::sleep(Duration::from_millis(150));
    host.events.lock().unwrap().extend([
        json!({"seq":5,"type":"steer","text":"Review again"}),
        json!({"seq":6,"type":"tool_call","tool":"exec_command","callId":"a","args":"{\"cmd\":\"printf second\"}"}),
        json!({"seq":7,"type":"tool_result","tool":"exec_command","callId":"a","ok":true,"summary":"second"}),
        json!({"seq":8,"type":"assistant","text":"Second review complete."}),json!({"seq":9,"type":"done","exitCode":0})]);
    host.wake.store(true, Ordering::Release);
    let frame = next_frame(&subscription);
    assert!(t.apply(&frame));
    let calls = steps(&t);
    assert_eq!(calls.len(), 2);
    assert_ne!(calls[0].id, calls[1].id);
    assert_eq!(calls[1].output.as_deref(), Some("second"));
    assert!(
        t.entries
            .iter()
            .any(|e| e.role == "user" && e.text == "Review again")
    );
    assert!(
        t.entries.iter().all(|e| e.text != "Live legacy answer"),
        "socket paragraphs only invalidate normalized readback"
    );
    std::thread::sleep(Duration::from_millis(300));
    let before = host.reads().len();
    std::thread::sleep(Duration::from_millis(2100));
    assert_eq!(host.reads().len(), before);
    drop(subscription);
}
#[test]
fn unavailable_normalization_preserves_history_and_the_live_socket() {
    for status in [404, 501, 500] {
        let host = Host::new(status);
        let history = host.history();
        assert_eq!(history.transcript[1].text, "Saved legacy answer");
        if status == 500 {
            assert!(
                history
                    .transcript
                    .iter()
                    .any(|e| e.role == "system" && e.text.contains("HTTP 500")),
                "optional readback failures remain visible"
            );
        }
        let subscription = transport::subscribe_history(host.client.clone(), &history);
        let frame = next_frame(&subscription);
        assert_eq!(frame["data"]["entries"][0]["text"], "Live legacy answer");
        drop(subscription);
    }
}
#[test]
fn invalid_normalized_identity_and_authorization_are_not_silent_fallbacks() {
    let host = Host::new(200);
    *host.key.lock().unwrap() = "codex-owned:other".into();
    assert!(
        host.client
            .history("codex-owned:reviewer")
            .unwrap_err()
            .contains("different session")
    );
    let refused = Host::new(403);
    assert!(refused.client.history("codex-owned:reviewer").is_err());
}
#[test]
fn legacy_worker_history_keeps_its_existing_window_bound() {
    let entries:Vec<_>=(0..300).map(|i|json!({"id":format!("entry-{i}"),"role":"assistant","text":format!("line {i}"),"timestamp":i})).collect();
    let t = Transcript::new(
        serde_json::from_value(json!({"sessionKey":"legacy:worker","transcript":entries})).unwrap(),
    );
    assert_eq!(t.entries.len(), 200);
}
#[test]
fn initial_readback_limits_preserve_legacy_data_with_a_visible_reason() {
    let host = Host::new(200);
    *host.events.lock().unwrap() = (1..=100001)
        .map(|seq| json!({"seq":seq,"type":"noop"}))
        .collect();
    let h = host.history();
    assert!(h.transcript.iter().any(|e| e.text == "Saved legacy answer"));
    assert!(
        h.transcript
            .iter()
            .any(|e| e.role == "system" && e.text.contains("limit")),
        "a bounded fallback explains why structured work is unavailable"
    );
}

#[test]
fn cursor_only_updates_do_not_repaint_and_late_entries_keep_chronology() {
    let marker = |cursor| json!({"id":"state","role":"assistant","text":"","nativeWorkerActive":false,"nativeWorkerReadback":{"cursor":cursor}});
    let h = serde_json::from_value(json!({"sessionKey":"codex-owned:indexed","transcript":[
        {"id":"first","role":"assistant","text":"First answer","timestamp":1000},
        {"id":"last","role":"assistant","text":"Last answer","timestamp":3000},marker(1)
    ]}))
    .unwrap();
    let mut t = Transcript::new(h);
    let epoch = t.context_epoch();
    let frame = |entries: Vec<Value>| json!({"channel":"history","event":"update","data":{"sessionKey":"codex-owned:indexed","entries":entries,"replace":false}});
    assert!(
        !t.apply(&frame(vec![marker(2)])),
        "a cursor checkpoint alone does not invalidate the transcript"
    );
    assert_eq!(t.context_epoch(), epoch);
    assert!(t.apply(&frame(vec![
        json!({"id":"middle","role":"assistant","text":"Late readback","timestamp":2000}),
        json!({"id":"last","role":"assistant","text":"Updated last answer","timestamp":3000}),
        marker(3)
    ])));
    assert_eq!(
        t.entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        ["first", "middle", "last", "state"]
    );
    assert!(t.apply(&frame(vec![
        json!({"id":"last","role":"assistant","text":"Another update","timestamp":3000}),
        marker(4)
    ])));
    assert_eq!(
        t.entries[2].text, "Another update",
        "an insertion preserves the ID index for later results"
    );
}
