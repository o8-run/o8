//! Driven by the isolated launcher fixture; this is the window's real client/socket.
use crate::{
    client::Client,
    transport::{self, Incoming},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

#[test]
#[ignore = "requires the isolated launcher product-transport fixture"]
fn producer_gap_reconnects() {
    let root = PathBuf::from(std::env::var_os("O8_LAUNCHER_CLIENT_DATA").expect("fixture data"));
    assert_eq!(
        fs::read_to_string(root.join("fixture-owner")).unwrap(),
        "o8d-native-read/v1"
    );
    let token = fs::read_to_string(root.join("ws-token")).unwrap();
    let client = Client::authenticated(
        &std::env::var("O8_LAUNCHER_CLIENT_ORIGIN").unwrap(),
        Some(token.trim().to_owned()),
    )
    .unwrap();
    let subscription = transport::subscribe_global(client);
    let mut first: Option<(u64, Value)> = None;
    let mut reconnected = false;
    let mut second = false;
    let deadline = Instant::now() + Duration::from_secs(180);
    while !root.join("transport-stop").exists() {
        assert!(
            Instant::now() < deadline,
            "producer reconnect fixture deadline"
        );
        let Ok(incoming) = subscription
            .receiver
            .recv_timeout(Duration::from_millis(100))
        else {
            continue;
        };
        match incoming {
            Incoming::Status(text) if text.starts_with("Reconnecting") && first.is_some() => {
                reconnected = true;
                fs::write(root.join("transport-reconnecting.json"), "true").unwrap();
            }
            Incoming::Frame(frame) => {
                let Some(events) = frame["data"]["events"].as_array() else {
                    continue;
                };
                for event in events {
                    let mutation = &event["data"]["mutation"];
                    if event["channel"] != "mutation" || mutation["action"] != "launcher-fixture" {
                        continue;
                    }
                    let pid = mutation["surfaceId"]
                        .as_str()
                        .unwrap()
                        .parse::<u64>()
                        .unwrap();
                    let epoch = event
                        .get("epoch")
                        .or_else(|| frame["data"].get("epoch"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    assert!(!epoch.is_null(), "real producer epoch is required");
                    if let Some((old_pid, old_epoch)) = &first {
                        if pid != *old_pid {
                            assert!(reconnected);
                            assert_ne!(
                                &epoch, old_epoch,
                                "new producer requires a fresh epoch/checkpoint"
                            );
                            fs::write(
                                root.join("transport-second.json"),
                                json!({"pid":pid,"epoch":epoch}).to_string(),
                            )
                            .unwrap();
                            second = true;
                        }
                    } else {
                        fs::write(
                            root.join("transport-first.json"),
                            json!({"pid":pid,"epoch":epoch}).to_string(),
                        )
                        .unwrap();
                        first = Some((pid, epoch));
                    }
                }
            }
            _ => {}
        }
    }
    drop(subscription);
    assert!(
        first.is_some() && reconnected && second,
        "same window subscription must reconnect to the replacement producer"
    );
}

/// Captures real committed mutation notifications without publishing test
/// events into the daemon. The launcher fixture drives the HTTP writes.
#[test]
#[ignore = "requires the isolated launcher commit-notification fixture"]
fn native_commits_and_handback() {
    use std::io::Write;
    let root = PathBuf::from(std::env::var_os("O8_LAUNCHER_CLIENT_DATA").expect("fixture data"));
    assert_eq!(
        fs::read_to_string(root.join("fixture-owner")).unwrap(),
        "o8d-native-read/v1"
    );
    let token = fs::read_to_string(root.join("ws-token")).unwrap();
    let client = Client::authenticated(
        &std::env::var("O8_LAUNCHER_CLIENT_ORIGIN").unwrap(),
        Some(token.trim().to_owned()),
    )
    .unwrap();
    let subscription = transport::subscribe_global(client);
    let deadline = Instant::now() + Duration::from_secs(180);
    let mut native = false;
    let mut reconnecting = false;
    let mut handback = false;
    let mut received = Vec::new();
    let mut output = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("commit-client-events.jsonl"))
        .unwrap();
    while !root.join("transport-stop").exists() {
        assert!(
            Instant::now() < deadline,
            "commit notification fixture deadline"
        );
        let Ok(incoming) = subscription
            .receiver
            .recv_timeout(Duration::from_millis(50))
        else {
            continue;
        };
        match incoming {
            Incoming::Status(text) if text.starts_with("Reconnecting") && native => {
                reconnecting = true;
            }
            Incoming::Frame(frame) => {
                if frame["channel"] != "realtime" || frame["event"] != "batch" {
                    continue;
                }
                let epoch = frame["data"]["epoch"].as_str().unwrap();
                if epoch.starts_with("o8d-native:") && frame["data"]["delivery"] == "bootstrap" {
                    native = true;
                    fs::write(root.join("commit-client-ready"), "ready").unwrap();
                }
                for event in frame["data"]["events"].as_array().unwrap() {
                    let mutation = &event["data"]["mutation"];
                    let action = mutation["action"].as_str().unwrap_or("");
                    if action == "launcher-fixture" && native && !epoch.starts_with("o8d-native:") {
                        assert!(
                            reconnecting,
                            "producer attach must reconnect the same Client"
                        );
                        handback = true;
                        fs::write(
                            root.join("commit-client-handback"),
                            mutation["surfaceId"].as_str().unwrap(),
                        )
                        .unwrap();
                    }
                    if !action.starts_with("session-rule.") {
                        continue;
                    }
                    assert_eq!(event["protocol"], 1);
                    assert_eq!(event["stream"], "global");
                    assert_eq!(event["channel"], "mutation");
                    assert_eq!(event["event"], "mutation.settled");
                    assert_eq!(mutation["status"], "completed");
                    let notice = json!({"event":event,"epoch":epoch});
                    writeln!(output, "{notice}").unwrap();
                    output.flush().unwrap();
                    received.push(notice);
                }
            }
            _ => {}
        }
    }
    drop(subscription);
    assert!(
        native && handback,
        "native bootstrap and producer handback are required"
    );
    let expected: Vec<Value> =
        serde_json::from_slice(&fs::read(root.join("commit-client-expected.json")).unwrap())
            .unwrap();
    assert!(expected.iter().any(|e| e["action"] == "session-rule.add"));
    assert_eq!(
        received.len(),
        expected.len(),
        "refusals and replays must stay silent"
    );
    for wanted in &expected {
        assert_eq!(
            received
                .iter()
                .filter(|row| {
                    let mutation = &row["event"]["data"]["mutation"];
                    mutation["action"] == wanted["action"]
                        && mutation["surfaceId"] == wanted["surfaceId"]
                        && row["epoch"].as_str().unwrap().starts_with("o8d-native:")
                            == wanted["native"].as_bool().unwrap()
                })
                .count(),
            1,
            "each committed operation must be delivered exactly once"
        );
    }
}
