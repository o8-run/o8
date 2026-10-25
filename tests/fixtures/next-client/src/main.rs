//! Headless transport probe: compile the native client, models and request adapters without GPUI.
#![allow(dead_code)]
#[path = "../../../../native/o8-next/src/activity.rs"]
mod activity;
#[path = "../../../../native/o8-next/src/client.rs"]
mod client;
#[path = "../../../../native/o8-next/src/model.rs"]
mod model;
#[path = "../../../../native/o8-next/src/rich.rs"]
mod rich;
#[path = "../../../../native/o8-next/src/sidebar.rs"]
mod sidebar;
#[path = "../../../../native/o8-next/src/text.rs"]
mod text;
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    net::TcpStream,
};

// Compile the registered surfaces' production request adapters without GPUI.
#[path = "../../../../native/o8-next/src/surfaces/diff_requests.rs"]
mod diff_requests;
#[path = "../../../../native/o8-next/src/surfaces/session_requests.rs"]
mod session_requests;
mod shell {
    pub mod session {
        pub use crate::session_requests::{QueueError, Session};
    }
}

fn main() {
    let origin = std::env::args().nth(1).expect("fixture origin");
    let token = std::env::var("O8_NEXT_API_TOKEN").expect("fixture credential");
    let client = client::Client::authenticated(&origin, Some(token)).unwrap();
    // One JSON request per line. HTTP error bodies are tested by the TS replay harness.
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let result = match request["op"].as_str().unwrap() {
            "get" => {
                let path = request["path"].as_str().unwrap();
                let query: Vec<(&str, &str)> = request["query"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|pair| (pair[0].as_str().unwrap(), pair[1].as_str().unwrap()))
                    .collect();
                client
                    .get::<Value>(path, &query)
                    .unwrap_or_else(|error| panic!("native GET {path} failed: {error}"))
            }
            "exercise" => {
                let sessions = client.sessions().unwrap();
                let session = sessions.iter().find(|s| s.id == "thoughts-long").unwrap();
                let history = client.history_page(&session.id, None).unwrap();
                assert_eq!(history.transcript.len(), 100);
                assert!(client.context(session).unwrap().is_object());
                assert!(client.queue(session).unwrap()["items"].is_array());
                json!({"sessions": sessions.len(), "messages": history.transcript.len()})
            }
            "queue" => client
                .mutate_queue(request["method"].as_str().unwrap(), &request["body"])
                .unwrap_or_else(|error| panic!("queue failure: {:?}", error.status)),
            "review" => {
                let result = client.review(&request["body"]).unwrap();
                assert_eq!(result["result"]["recorded"], true);
                assert_eq!(
                    client
                        .review_state(request["body"]["packetId"].as_str().unwrap())
                        .unwrap()["orchestratorReview"]["verdict"],
                    "rejected"
                );
                result
            }
            "websocket" => {
                let (url, address) = client.websocket().unwrap();
                let tcp = TcpStream::connect_timeout(&address, std::time::Duration::from_secs(5))
                    .unwrap();
                tcp.set_read_timeout(Some(std::time::Duration::from_secs(10)))
                    .unwrap();
                let (mut socket, response) = tungstenite::client(url.as_str(), tcp).unwrap();
                assert_eq!(response.status(), 101);
                socket
                    .send(tungstenite::Message::Text(
                        json!({"type":"realtime-subscribe","subscriptions":[
                            {"stream":"global"},{"stream":"session:llm-chat:thoughts-long"}
                        ]})
                        .to_string()
                        .into(),
                    ))
                    .unwrap();
                socket
                    .send(tungstenite::Message::Text(
                        json!({"type":"ping"}).to_string().into(),
                    ))
                    .unwrap();
                let mut connected = false;
                let mut pong = false;
                let mut checkpoint = false;
                let mut history = false;
                let mut global_data = Value::Null;
                let mut history_data = Value::Null;
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
                loop {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "native checkpoint deadline: connected={connected} pong={pong} global={checkpoint} history={history}"
                    );
                    let frame = socket.read().unwrap();
                    if let Ok(body) = serde_json::from_slice::<Value>(&frame.into_data()) {
                        connected |= body["event"] == "connected";
                        pong |= body["channel"] == "pong";
                        if body["channel"] == "realtime"
                            && body["event"] == "batch"
                            && body["data"]["delivery"] == "bootstrap"
                        {
                            let events = json!(body["data"]["events"].as_array().unwrap().iter().map(|event|
                                json!({"channel": event["channel"], "event": event["event"], "data": event["data"]})
                            ).collect::<Vec<_>>());
                            if body["data"]["stream"] == "global" {
                                global_data = events.clone();
                            }
                            if body["data"]["stream"] == "session:llm-chat:thoughts-long" {
                                history_data = events;
                            }
                            checkpoint |= body["data"]["stream"] == "global";
                            history |= body["data"]["stream"] == "session:llm-chat:thoughts-long"
                                && body["data"]["events"].as_array().unwrap().iter().any(|e| {
                                    e["data"]["entries"]
                                        .as_array()
                                        .is_some_and(|e| !e.is_empty())
                                });
                        }
                        if connected && pong && checkpoint && history {
                            break;
                        }
                    }
                }
                assert!(connected);
                let session = client
                    .sessions()
                    .unwrap()
                    .into_iter()
                    .find(|s| s.id == "thoughts-long")
                    .unwrap();
                let target = json!({"repoPath": session.repo_path, "threadId": session.id, "id": "fixture-stream-send"});
                let mut queued = target.clone();
                queued["intent"] = json!("send-next");
                queued["payload"] = json!({"text":"Fixture live send","wireMessage":"Fixture live send","images":[],"routing":client.context(&session).unwrap()});
                client
                    .mutate_queue("POST", &queued)
                    .unwrap_or_else(|e| panic!("live queue status {:?}", e.status));
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
                let live_data;
                loop {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "native live mutation deadline"
                    );
                    let frame = socket.read().unwrap();
                    if let Ok(body) = serde_json::from_slice::<Value>(&frame.into_data()) {
                        if body["channel"] == "realtime"
                            && body["data"]["events"].as_array().is_some_and(|events| {
                                events.iter().any(|event| {
                                    event["data"]["mutation"]["mutationId"]
                                        .as_str()
                                        .is_some_and(|id| {
                                            id.starts_with("composer-queue-fixture-stream-send-")
                                        })
                                })
                            })
                        {
                            live_data = body["data"]["events"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .find_map(|event| {
                                    let mutation = &event["data"]["mutation"];
                                    mutation["mutationId"]
                                        .as_str()
                                        .filter(|id| {
                                            id.starts_with("composer-queue-fixture-stream-send-")
                                        })
                                        .map(|_| mutation.clone())
                                })
                                .unwrap();
                            break;
                        }
                    }
                }
                client
                    .mutate_queue("DELETE", &target)
                    .unwrap_or_else(|e| panic!("live cancel status {:?}", e.status));
                socket.close(None).unwrap();
                json!({"connected": true, "pong": true, "checkpoint": true, "history": true, "liveMutation": true,
                    "checkpoints": {"global": global_data, "history": history_data}, "live": live_data})
            }
            _ => panic!("unknown fixture operation"),
        };
        println!("{}", result);
    }
}
