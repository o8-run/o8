#![cfg(all(feature = "experimental-session-reads", unix))]
use axum::{body::to_bytes, http::StatusCode};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("o8d-phone-overlays-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        fs::create_dir(directory.join("chat-history")).unwrap();
        fs::write(directory.join("chat-history/tab.json"),serde_json::to_vec(&json!({"messages":[{"id":"huddle-1","role":"user","content":"replaced","timestamp":0},{"id":"missing","role":"user","content":"no time"}]})).unwrap()).unwrap();
        let db = Connection::open(directory.join("cortex-ide.db")).unwrap();
        db.execute_batch("CREATE TABLE lanes(id TEXT,session_key TEXT,created_at TEXT); CREATE TABLE lane_events(id TEXT PRIMARY KEY,lane_id TEXT,verb TEXT,actor TEXT,payload_json TEXT,timestamp TEXT); CREATE INDEX lane_timestamp ON lane_events(lane_id,timestamp); CREATE TABLE bot_network_threads(thread_id TEXT); INSERT INTO lanes VALUES ('lane','llm-chat:tab','2026-01-01');").unwrap();
        Self(directory)
    }
    fn db(&self) -> Connection {
        Connection::open(self.0.join("cortex-ide.db")).unwrap()
    }
    fn event(&self, id: &str, verb: &str, payload: Value, ts: &str) {
        self.db()
            .execute(
                "INSERT INTO lane_events VALUES (?,'lane',?,'orchestrator',?,?)",
                rusqlite::params![id, verb, payload.to_string(), ts],
            )
            .unwrap();
    }
    async fn get(&self) -> (StatusCode, Value) {
        let response = o8d::http::native_request(
            self.0.clone(),
            self.0.join("cortex-ide.db"),
            "/api/mobile/history",
            "sessionKey=llm-chat:tab&page=1",
            "GET",
            &[],
            None,
        );
        let status = response.status();
        (
            status,
            serde_json::from_slice(
                &to_bytes(response.into_body(), 16 * 1024 * 1024)
                    .await
                    .unwrap(),
            )
            .unwrap(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[tokio::test]
async fn projects_huddles_failure_receipts_and_id_collisions_then_observes_wal_writes() {
    let f = Fixture::new();
    f.db().pragma_update(None, "journal_mode", "WAL").unwrap();
    f.event(
        "huddle",
        "agent_report",
        json!({"event":"huddle","message":" plan "}),
        "2026-01-01T00:00:00.000Z",
    );
    f.event(
        "steer",
        "steered_packet",
        json!({"message":"correct","deliveryState":"queued"}),
        "2026-01-01T01:00:00.000Z",
    );
    f.event(
        "receipt",
        "steer_delivery",
        json!({"steerEventId":"steer","state":"failed","note":"ARTIFACT admission"}),
        "2026-01-01T01:01:00.000Z",
    );
    let (status, body) = f.get().await;
    assert_eq!(status, StatusCode::OK);
    let entries = body["transcript"].as_array().unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0]["id"], "missing");
    assert_eq!(entries[1]["id"], "huddle-1");
    assert_eq!(entries[1]["text"], "Huddling — plan posted\n\nplan");
    assert!(entries[2]["text"]
        .as_str()
        .unwrap()
        .contains("Steer failed to start"));
    assert!(entries[2]["text"]
        .as_str()
        .unwrap()
        .contains("The worker could not start another turn."));
    let revision = body["page"]["revision"].clone();
    f.event(
        "new-steer",
        "steered_packet",
        json!({"text":"new","source":"Operator"}),
        "2026-01-01T02:00:00.000Z",
    );
    assert_ne!(f.get().await.1["page"]["revision"], revision);
}
#[tokio::test]
async fn refuses_ambiguous_lanes_unknown_events_payloads_receipts_and_schema_failures() {
    let f = Fixture::new();
    let db = f.db();
    db.execute(
        "INSERT INTO lanes VALUES ('other','llm-chat:tab','2026-01-01')",
        [],
    )
    .unwrap();
    assert_eq!(f.get().await.0, StatusCode::SERVICE_UNAVAILABLE);
    db.execute("DELETE FROM lanes WHERE id='other'", [])
        .unwrap();
    for (kind, payload, time) in [
        ("future_kind", "{}", "2026-01-01T00:00:00.000Z"),
        ("agent_report", "{bad", "2026-01-01T00:00:00.000Z"),
        (
            "steered_packet",
            "{\"message\":[]}",
            "2026-01-01T00:00:00.000Z",
        ),
        ("agent_report", "{\"event\":\"huddle\"}", "not-a-date"),
    ] {
        db.execute(
            "INSERT INTO lane_events VALUES ('bad','lane',?,'system',?,?)",
            [kind, payload, time],
        )
        .unwrap();
        assert_eq!(f.get().await.0, StatusCode::SERVICE_UNAVAILABLE);
        db.execute("DELETE FROM lane_events", []).unwrap();
    }
    f.event(
        "steer",
        "steered_packet",
        json!({"deliveryState":"queued","message":"correct"}),
        "2026-01-01T00:00:00.000Z",
    );
    db.execute("INSERT INTO lane_events VALUES ('receipt','lane','steer_delivery','system','{bad','2026-01-01T01:00:00.000Z')",[]).unwrap();
    assert_eq!(f.get().await.0, StatusCode::SERVICE_UNAVAILABLE);
    db.execute(
        "ALTER TABLE lane_events RENAME COLUMN payload_json TO bad_column",
        [],
    )
    .unwrap();
    assert_eq!(f.get().await.0, StatusCode::SERVICE_UNAVAILABLE);
}
