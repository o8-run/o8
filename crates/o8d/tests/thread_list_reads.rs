#![cfg(feature = "experimental-session-reads")]
use axum::{body::to_bytes, http::StatusCode};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("o8d-thread-list-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("chat-history")).unwrap();
        let root = root.canonicalize().unwrap();
        let db = Connection::open(root.join("cortex-ide.db")).unwrap();
        db.execute_batch("CREATE TABLE app_state(key TEXT,value TEXT);CREATE TABLE bot_network_threads(thread_id TEXT);CREATE TABLE workspace_snapshots(state TEXT,repository_uuid TEXT,packet_id TEXT);CREATE TABLE conversation_pr_context(thread_id TEXT,repository_id INTEGER,pull_request_id INTEGER,number INTEGER,repository_name TEXT);CREATE TABLE github_pull_requests(repository_id INTEGER,pull_request_id INTEGER,number INTEGER,state TEXT,merged_at TEXT,head_ref_name TEXT);").unwrap();
        Self(root)
    }
    fn put(&self, id: &str, extra: Value) {
        let mut record = json!({"messages":[],"title":id,"savedAt":"2026-10-01T00:00:00.000Z","backend":"claude"});
        for (k, v) in extra.as_object().unwrap() {
            record[k] = v.clone();
        }
        fs::write(
            self.0.join("chat-history").join(format!("{id}.json")),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
    }
    async fn get(&self, query: &str, context: Option<Value>) -> (StatusCode, Value, bool) {
        let response = o8d::http::native_request(
            self.0.clone(),
            self.0.join("cortex-ide.db"),
            "/api/mobile/orchestrator/threads",
            query,
            "GET",
            &[],
            context,
        );
        let status = response.status();
        let pieces = response.headers().contains_key("x-o8d-thread-pieces");
        (
            status,
            serde_json::from_slice(
                &to_bytes(response.into_body(), 16 * 1024 * 1024)
                    .await
                    .unwrap(),
            )
            .unwrap(),
            pieces,
        )
    }
    fn context() -> Option<Value> {
        Some(json!({"threadList":{"machineDisplayName":"Fixture computer"}}))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[tokio::test]
async fn fresh_local_pieces_preserve_summary_pinning_ledger_and_parseint_paging() {
    let f = Fixture::new();
    f.put("thoughts-a", json!({"pinned":true}));
    f.put("thoughts-b",json!({"title":"Orchestrator session · not a generated date","messages":[{"role":"assistant","content":"Done","timestamp":1790812800000_i64}]}));
    fs::create_dir(f.0.join("orchestrator-turns")).unwrap();
    fs::write(f.0.join("orchestrator-turns/turn.json"),serde_json::to_vec(&json!({"id":"turn","stdoutPath":"/unused","threadId":"thoughts-a","startedAt":chrono::Utc::now().timestamp_millis(),"pid":std::process::id()})).unwrap()).unwrap();
    let (status, body, pieces) = f.get("limit=1tail&offset=0tail", Fixture::context()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(pieces);
    assert_eq!(body["pieces"].as_array().unwrap().len(), 1);
    assert_eq!(body["pieces"][0]["thread"]["id"], "thoughts-a");
    assert_eq!(body["pieces"][0]["thread"]["status"], "busy");
    assert_eq!(
        body["pieces"][0]["projection"]["pinnedAt"],
        "1970-01-01T00:00:00.000Z"
    );
    assert_eq!(body["machineDisplayName"], "Fixture computer");
    let (_, body, _) = f.get("offset=1&limit=-3", Fixture::context()).await;
    assert_eq!(
        body["pieces"][0]["thread"]["title"],
        "Orchestrator session · not a generated date"
    );
    f.put("thoughts-a", json!({"title":"Fresh rewrite"}));
    assert_eq!(
        f.get("limit=1", Fixture::context()).await.1["pieces"][0]["thread"]["title"],
        "Fresh rewrite"
    );
}
#[tokio::test]
async fn local_errors_defer_and_network_base_pieces_leave_runtime_health_to_node() {
    let f = Fixture::new();
    f.put("thoughts-a", json!({}));
    assert_eq!(f.get("", None).await.0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        f.get("", Some(json!({"threadList":{"machineDisplayName":12}})))
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        f.get("backend=invalid", Fixture::context()).await.1,
        json!({"threads":[]})
    );
    f.put("thoughts-archived", json!({"archivedAt":true}));
    let (status, body, pieces) = f.get("archived=1", Fixture::context()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!pieces);
    assert_eq!(body, json!({"archivedIds":["thoughts-archived"]}));
    f.put("thoughts-network", json!({"source":"bot-network"}));
    let (status, body, _) = f.get("", Fixture::context()).await;
    assert_eq!(status, StatusCode::OK);
    let network = body["pieces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["thread"]["id"] == "thoughts-network")
        .unwrap();
    assert_eq!(network["thread"]["source"], "bot-network");
    assert_eq!(network["thread"]["status"], "idle");
    assert!(network["thread"].get("networkProjectionError").is_none());
    assert_eq!(
        f.get("backend=claude", Fixture::context()).await.0,
        StatusCode::OK
    );
    fs::remove_file(f.0.join("chat-history/thoughts-network.json")).unwrap();
    Connection::open(f.0.join("cortex-ide.db"))
        .unwrap()
        .execute_batch("ALTER TABLE app_state RENAME COLUMN value TO bad_column;")
        .unwrap();
    assert_eq!(
        f.get("", Fixture::context()).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}
#[tokio::test]
async fn compose_pieces_over_eight_mib_defer_before_any_node_enrichment() {
    let f = Fixture::new();
    for n in 0..500 {
        f.put(
            &format!("thoughts-{n:04}"),
            json!({"projectId":"p".repeat(9000)}),
        );
    }
    assert_eq!(f.get("limit=1", Fixture::context()).await.0, StatusCode::OK);
    let (status, body, _) = f
        .get(&format!("limit={}", "9".repeat(400)), Fixture::context())
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["pieces"].as_array().unwrap().len(), 20);
    assert_eq!(
        f.get("limit=500", Fixture::context()).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}
