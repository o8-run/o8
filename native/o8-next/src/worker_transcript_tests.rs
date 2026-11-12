//! Worker readback enters through the same Client::history used by Session and WorkerPane.
use crate::{
    client::Client,
    model::{History, Row},
    pane::Pane,
};
use gpui::{Context, IntoElement, Render, TestAppContext, Window, div, prelude::*, px};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

fn recorded() -> Value {
    serde_json::from_str(include_str!("../fixtures/reviewer.events.json")).unwrap()
}

fn readback(events: Value) -> History {
    readback_with_moving_history(events, false)
}

fn readback_with_moving_history(events: Value, moving: bool) -> History {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let server = std::thread::spawn(move || {
        // The legacy history has the prompt and flattened command echoes.
        while !stopped.load(Ordering::Acquire) {
            let mut stream = match listener.accept() {
                Ok((stream, _)) => stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::park_timeout(std::time::Duration::from_millis(1));
                    continue;
                }
                Err(e) => panic!("fixture accept: {e}"),
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = [0; 8192];
            let n = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..n]);
            let (status, body) = if request.contains("/api/mobile/history")
                && request.contains("before=")
            {
                ("409 Conflict", json!({"error":"history cursor changed"}))
            } else if request.contains("/api/mobile/history") {
                (
                    "200 OK",
                    json!({"sessionKey":"codex-owned:reviewer", "transcript":[
                    {"id":"prompt","role":"user","text":"Review the patch."},
                    {"id":"echo-1","role":"assistant","text":"Running /bin/zsh -lc 'git diff --stat'"},
                    {"id":"echo-2","role":"assistant","text":"Run /bin/zsh -lc 'git diff --stat'"}
                ], "page":{"hasMore":moving,"beforeCursor":if moving {Some("moving")} else {None}}}),
                )
            } else {
                assert!(request.contains("/api/orchestrator/packet-transcript"));
                let cursor = request
                    .split("cursor=")
                    .nth(1)
                    .and_then(|s| s.split(['&', ' ']).next())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0);
                let page: Vec<_> = events
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|e| e["seq"].as_u64().unwrap() > cursor)
                    .take(200)
                    .cloned()
                    .collect();
                let next = page.last().map(|e| e["seq"].clone());
                (
                    "200 OK",
                    json!({"sessionKey":"codex-owned:reviewer", "events":page, "nextCursor":next}),
                )
            };
            let body = body.to_string();
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        }
    });
    let history = Client::authenticated(&origin, None)
        .unwrap()
        .history("codex-owned:reviewer");
    stop.store(true, Ordering::Release);
    server.join().unwrap();
    history.unwrap()
}

struct Transcript(Pane);
impl Render for Transcript {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .w(px(700.))
            .h(px(600.))
            .flex()
            .flex_col()
            .child(self.0.content_for(cx.entity()))
    }
}

#[gpui::test]
fn reviewer_readback_groups_commands_and_ends_on_verdict(cx: &mut TestAppContext) {
    let history = readback_with_moving_history(recorded(), true);
    let mut pane = Pane::new(Some(history.session_key.clone()));
    pane.install(
        history,
        Client::authenticated("http://127.0.0.1:1", None).unwrap(),
    );
    let steps: Vec<_> = pane
        .rows
        .iter()
        .flat_map(|r| match &r.borrow().row {
            Row::Activity { steps, .. } => steps.clone(),
            _ => vec![],
        })
        .collect();
    assert_eq!(
        steps.len(),
        2,
        "one step per call, results update the original"
    );
    assert!(steps.iter().all(|s| s.status == "ok"));
    assert_eq!(
        pane.rows
            .iter()
            .filter(|r| matches!(r.borrow().row, Row::Activity { .. }))
            .count(),
        1
    );
    assert!(pane.rows.iter().all(|r| !matches!(&r.borrow().row,
        Row::Message { nodes, .. } if nodes.iter().flat_map(|n| &n.runs).any(|r| r.text.starts_with("Running ") || r.text.starts_with("Run ")))));
    assert!(pane.rows.iter().any(|r| matches!(&r.borrow().row,
        Row::Message { role, nodes, .. } if role == "assistant" && crate::transcript_actions::plain(nodes, false).starts_with("No concrete bugs found."))));
    let (_view, cx) = cx.add_window_view(|_, _| Transcript(pane));
    cx.run_until_parked();
    assert!(
        cx.debug_bounds("trace-header-1").is_some(),
        "the chat trace disclosure"
    );
    assert!(
        cx.debug_bounds("trace-line-1-0").is_none(),
        "saved work starts collapsed"
    );
    assert!(
        cx.debug_bounds("transcript-verdict-2").is_some(),
        "the final answer ends the turn"
    );
    assert!(
        cx.debug_bounds("message-play-2").is_some(),
        "the verdict can be read aloud"
    );
    let copy = cx
        .debug_bounds("message-copy-2")
        .expect("the verdict has the shared copy action");
    cx.simulate_click(copy.center(), gpui::Modifiers::default());
    assert!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()))
            .unwrap()
            .starts_with("No concrete bugs found.")
    );
    let header = cx.debug_bounds("trace-header-1").unwrap();
    cx.simulate_click(header.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    assert!(cx.debug_bounds("trace-line-1-0").is_some());
    // The shared trace already animates its disclosure. Let its hitboxes settle.
    std::thread::sleep(std::time::Duration::from_millis(350));
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    assert!(
        cx.debug_bounds("trace-line-1-1").is_some(),
        "a separate row for the second command"
    );
    assert!(
        cx.debug_bounds("trace-line-1-2").is_some(),
        "the shared turn summary"
    );
    assert!(
        cx.debug_bounds("trace-line-1-3").is_none(),
        "no duplicated command rows"
    );
    assert!(
        cx.debug_bounds("trace-result-1-0").is_none(),
        "the command result starts folded"
    );
    let toggle = cx
        .debug_bounds("trace-result-toggle-1-0")
        .expect("a result disclosure beside the command");
    cx.simulate_click(toggle.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    assert!(
        cx.debug_bounds("trace-result-1-0").is_some(),
        "the result opens in the trace"
    );
}

#[test]
fn reviewer_running_result_error_and_done_keep_the_same_command() {
    let waiting = crate::stream::Transcript::new(readback(json!([
        {"seq":1,"type":"assistant","text":"I will review the patch."}
    ])));
    assert!(
        matches!(waiting.rows.last(), Some(Row::Activity { steps, trace, .. }) if steps.is_empty() && trace.live),
        "commentary before a call is still a working turn, not the verdict"
    );
    let mut saved = recorded().as_array().unwrap().clone();
    saved.pop(); // Older recordings can have the verdict without a done marker.
    let saved = crate::stream::Transcript::new(readback(json!(saved)));
    assert!(
        !saved
            .rows
            .iter()
            .any(|r| matches!(r, Row::Activity { trace, .. } if trace.live))
    );
    let refused = crate::stream::Transcript::new(readback(json!([
        {"seq":1,"type":"done","exitCode":0},
        {"seq":2,"type":"steer","text":"Try again","failed":true,"note":"Delivery was refused"}
    ])));
    assert!(
        !refused
            .rows
            .iter()
            .any(|r| matches!(r, Row::Activity { trace, .. } if trace.live))
    );
    assert!(
        refused
            .rows
            .iter()
            .any(|r| matches!(r, Row::Message { nodes, .. }
        if crate::transcript_actions::plain(nodes, false).contains("Delivery was refused")))
    );
    let mut events = recorded().as_array().unwrap().clone();
    events.truncate(1);
    let mut live = crate::stream::Transcript::new(readback(json!(events)));
    assert!(live.rows.iter().any(
        |r| matches!(r, Row::Activity { steps, trace, .. } if steps.len() == 1 && trace.live)
    ));
    let failed = crate::stream::Transcript::new(readback(json!([
        events[0],
        {"seq":2,"type":"tool_result","callId":"review-diff","tool":"exec_command","ok":false,"summary":"Command failed"},
        {"seq":3,"type":"error","message":"Reviewer could not finish"},
        {"seq":4,"type":"done","exitCode":1}
    ])));
    assert!(failed.rows.iter().any(|r| matches!(r, Row::Activity { steps, trace, .. } if steps.len() == 1 && steps[0].status == "failed" && !trace.live)));
    let command_id = live
        .rows
        .iter()
        .find_map(|r| match r {
            Row::Activity { steps, .. } => Some(steps[0].id.clone()),
            _ => None,
        })
        .unwrap();
    let entries: Vec<Value> = failed
        .entries
        .iter()
        .map(|entry| {
            let mut wire =
                json!({"id":entry.id,"role":entry.role,"text":entry.text,"toolCalls":entry.tools});
            for (key, value) in &entry.extra {
                wire[key] = value.clone();
            }
            wire
        })
        .collect();
    assert!(
        live.apply(&json!({"channel":"history","event":"update","data":{
            "sessionKey":"codex-owned:reviewer", "entries":entries, "replace":true
        }}))
    );
    assert_eq!(
        live.rows
            .iter()
            .flat_map(|r| match r {
                Row::Activity { steps, .. } => steps.iter().map(|s| s.id.as_str()).collect(),
                _ => vec![],
            })
            .collect::<Vec<_>>(),
        vec![command_id.as_str()]
    );
    assert!(
        failed
            .rows
            .iter()
            .any(|r| matches!(r, Row::Message { role, .. } if role == "system"))
    );
}

#[test]
fn identical_commands_remain_separate_and_legacy_results_pair_in_order() {
    let history = readback(json!([
        {"seq":1,"type":"tool_call","tool":"exec_command","args":"{\"cmd\":\"git status --short\"}"},
        {"seq":2,"type":"tool_call","tool":"exec_command","args":"{\"cmd\":\"git status --short\"}"},
        {"seq":3,"type":"tool_result","tool":"exec_command","ok":true,"summary":"first"},
        {"seq":4,"type":"tool_result","tool":"exec_command","ok":false,"summary":"second"},
        {"seq":5,"type":"done","exitCode":1}
    ]));
    let transcript = crate::stream::Transcript::new(history);
    let steps: Vec<_> = transcript
        .rows
        .iter()
        .flat_map(|r| match r {
            Row::Activity { steps, .. } => steps.clone(),
            _ => vec![],
        })
        .collect();
    assert_eq!(steps.len(), 2);
    assert_eq!(
        (&steps[0].status, &steps[1].status),
        (&"ok".to_owned(), &"failed".to_owned())
    );
    assert_ne!(steps[0].id, steps[1].id);

    let mut events = Vec::new();
    for i in 0..101 {
        events.push(json!({"seq":i*2+1,"type":"tool_call","callId":format!("call-{i}"),"tool":"exec_command","args":"{\"cmd\":\"git status --short\"}"}));
        events.push(json!({"seq":i*2+2,"type":"tool_result","callId":format!("call-{i}"),"tool":"exec_command","ok":true,"summary":"ok"}));
    }
    events.push(
        json!({"seq":203,"type":"assistant","text":"Review complete after all event pages."}),
    );
    events.push(json!({"seq":204,"type":"done","exitCode":0}));
    let paged = crate::stream::Transcript::new(readback(json!(events)));
    assert_eq!(
        paged
            .rows
            .iter()
            .map(|r| match r {
                Row::Activity { steps, .. } => steps.len(),
                _ => 0,
            })
            .sum::<usize>(),
        101
    );
    assert!(paged.rows.iter().any(|r| matches!(r, Row::Message {role,nodes,..}
        if role == "assistant" && crate::transcript_actions::plain(nodes, false) == "Review complete after all event pages.")));
}

#[gpui::test]
fn chat_keeps_shell_grouping_without_retaining_result_disclosures(cx: &mut TestAppContext) {
    let result = "saved chat output".repeat(4000);
    let history = serde_json::from_value(json!({"sessionKey":"llm-chat:regression","transcript":[
        {"id":"prompt","role":"user","text":"Run both checks","timestamp":1000},
        {"id":"work","role":"assistant","text":"","timestamp":2000,"toolCalls":[
            {"id":"a","name":"exec_command","args":{"cmd":"printf first"},"status":"done","result":result,"startedAt":2000,"finishedAt":3000},
            {"id":"b","name":"exec_command","args":{"cmd":"printf second"},"status":"done","result":"second","startedAt":4000,"finishedAt":5000}]},
        {"id":"answer","role":"assistant","text":"Both passed.","timestamp":6000,"receipt":{"terminal":{"outcome":"completed","completedAt":6000}}}
    ]})).unwrap();
    let mut pane = Pane::new(None);
    pane.install_saved(history);
    for row in pane.rows.iter() {
        if let Row::Activity { steps, .. } = &row.borrow().row {
            assert_eq!(steps.len(), 2);
            assert!(
                steps.iter().all(|s| s.output.is_none()),
                "chat does not retain another result preview"
            );
        }
    }
    let (_, cx) = cx.add_window_view(|_, _| Transcript(pane));
    cx.run_until_parked();
    let header = cx.debug_bounds("trace-header-1").unwrap();
    cx.simulate_click(header.center(), gpui::Modifiers::default());
    std::thread::sleep(std::time::Duration::from_millis(350));
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    assert!(cx.debug_bounds("trace-line-1-0").is_some());
    assert!(
        cx.debug_bounds("trace-line-1-1").is_some(),
        "the existing turn summary"
    );
    assert!(
        cx.debug_bounds("trace-line-1-2").is_none(),
        "chat still combines consecutive shell calls"
    );
    assert!(
        cx.debug_bounds("trace-result-toggle-1-0").is_none(),
        "no new result disclosure in chat"
    );
}

#[test]
fn an_empty_steer_keeps_the_saved_prompt_and_terminal_state() {
    let history = readback(json!([
        {"seq":1,"type":"done","exitCode":0},
        {"seq":2,"type":"steer","text":"","ts":"2026-11-02T21:49:25.000Z"}
    ]));
    let prompts: Vec<_> = history
        .transcript
        .iter()
        .filter(|e| e.role == "user")
        .collect();
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0].text, "Review the patch.");
    assert_eq!(
        history.transcript.last().unwrap().extra["nativeWorkerActive"],
        false
    );
}

/// A real HTTP/socket host: the request log proves the selected transport and
/// cursor, rather than mocking either Client or the subscription.
struct Host {
    client: Client,
    requests: Arc<std::sync::Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    server: Option<std::thread::JoinHandle<()>>,
}
impl Host {
    fn new(normalized_status: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let client =
            Client::authenticated(&format!("http://{}", listener.local_addr().unwrap()), None)
                .unwrap();
        let requests = Arc::new(std::sync::Mutex::new(vec![]));
        let log = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let server = std::thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                let mut stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::park_timeout(std::time::Duration::from_millis(1));
                        continue;
                    }
                    Err(e) => panic!("fixture accept: {e}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut buf = [0; 8192];
                let n = stream.peek(&mut buf).unwrap();
                let request = String::from_utf8_lossy(&buf[..n]);
                log.lock()
                    .unwrap()
                    .push(request.lines().next().unwrap().to_owned());
                if request.to_ascii_lowercase().contains("upgrade: websocket") {
                    let mut socket = tungstenite::accept(stream).unwrap();
                    let _ = socket.read().unwrap();
                    socket.send(tungstenite::Message::Text(json!({"channel":"history","event":"update","data":{"sessionKey":"codex-owned:reviewer","entries":[{"id":"live","role":"assistant","text":"Live legacy answer"}]}}).to_string().into())).unwrap();
                    continue;
                }
                let n = stream.read(&mut buf).unwrap();
                let request = String::from_utf8_lossy(&buf[..n]);
                let (status, body) = if request.contains("/api/panel/ws-info") {
                    (200, json!({"wsPort":port,"wsToken":"fixture-token"}))
                } else if request.contains("/api/mobile/history") {
                    (
                        200,
                        json!({"sessionKey":"codex-owned:reviewer","transcript":[{"id":"prompt","role":"user","text":"Review the patch."},{"id":"legacy","role":"assistant","text":"Saved legacy answer"}]}),
                    )
                } else {
                    assert!(request.contains("/api/orchestrator/packet-transcript"));
                    let events = if request.contains("cursor=0") {
                        json!([{"seq":1,"type":"tool_call","tool":"exec_command","callId":"a","args":"{\"cmd\":\"printf first\"}"}])
                    } else {
                        assert!(request.contains("cursor=1"));
                        json!([{"seq":2,"type":"tool_result","tool":"exec_command","callId":"a","ok":true,"summary":"first"},{"seq":3,"type":"assistant","text":"Review complete."},{"seq":4,"type":"done","exitCode":0}])
                    };
                    (
                        normalized_status,
                        json!({"sessionKey":"codex-owned:reviewer","events":events,"nextCursor":if request.contains("cursor=0") {1} else {4}}),
                    )
                };
                let body = body.to_string();
                let reason = match status {
                    200 => "OK",
                    404 => "Not Found",
                    501 => "Not Implemented",
                    _ => "Internal Server Error",
                };
                write!(stream,"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        Self {
            client,
            requests,
            stop,
            server: Some(server),
        }
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

#[test]
fn worker_subscription_uses_cursor_updates_and_stops_on_done() {
    let host = Host::new(200);
    let history = host.client.history("codex-owned:reviewer").unwrap();
    let subscription = crate::transport::subscribe_history(host.client.clone(), &history);
    let mut transcript = crate::stream::Transcript::new(history);
    let crate::transport::Incoming::Frame(frame) = subscription
        .receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap()
    else {
        panic!("normalized update")
    };
    assert_eq!(frame["data"]["replace"], false);
    assert!(transcript.apply(&frame));
    let steps: Vec<_> = transcript
        .rows
        .iter()
        .flat_map(|r| match r {
            Row::Activity { steps, .. } => steps.clone(),
            _ => vec![],
        })
        .collect();
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].status, "ok");
    assert_eq!(steps[0].output.as_deref(), Some("first"));
    assert!(
        subscription
            .receiver
            .recv_timeout(std::time::Duration::from_millis(2300))
            .is_err()
    );
    std::thread::sleep(std::time::Duration::from_millis(2100));
    let requests = host.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        3,
        "initial mobile + initial normalized + one cursor poll; no request after done"
    );
    assert!(requests[2].contains("cursor=1"));
    drop(requests);
    drop(subscription);
}

#[test]
fn unavailable_normalization_preserves_history_and_the_live_socket() {
    for status in [404, 501, 500] {
        let host = Host::new(status);
        let history = host
            .client
            .history("codex-owned:reviewer")
            .expect("optional normalization cannot fail existing history");
        assert_eq!(history.transcript[1].text, "Saved legacy answer");
        let subscription = crate::transport::subscribe_history(host.client.clone(), &history);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match subscription
                .receiver
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .unwrap()
            {
                crate::transport::Incoming::Frame(frame) if frame["channel"] == "history" => {
                    assert_eq!(frame["data"]["entries"][0]["text"], "Live legacy answer");
                    break;
                }
                _ => {}
            }
        }
        assert!(
            host.requests
                .lock()
                .unwrap()
                .iter()
                .any(|r| !r.contains("/api/")),
            "legacy socket used for HTTP {status}"
        );
        drop(subscription);
    }
}
