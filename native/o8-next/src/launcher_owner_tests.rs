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
