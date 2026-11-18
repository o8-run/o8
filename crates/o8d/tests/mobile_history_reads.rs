#![cfg(all(feature = "experimental-session-reads", unix))]
use axum::{body::to_bytes, http::StatusCode};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("o8d-phone-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        fs::create_dir(directory.join("chat-history")).unwrap();
        let db = Connection::open(directory.join("cortex-ide.db")).unwrap();
        db.execute_batch("CREATE TABLE lanes (session_key TEXT); CREATE TABLE bot_network_threads (thread_id TEXT);").unwrap();
        Self(directory)
    }
    fn db(&self) -> Connection {
        Connection::open(self.0.join("cortex-ide.db")).unwrap()
    }
    fn path(&self) -> PathBuf {
        self.0.join("chat-history/tab.json")
    }
    async fn get(&self, params: &str) -> (StatusCode, Value) {
        let response = o8d::http::native_request(
            self.0.clone(),
            self.0.join("cortex-ide.db"),
            "/api/mobile/history",
            params,
            "GET",
            &[],
            None,
        );
        assert_eq!(response.headers()["cache-control"], "no-store, max-age=0");
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
async fn refuses_lane_bound_runtime_network_malformed_and_unsupported_histories() {
    let f = Fixture::new();
    let query = "sessionKey=llm-chat:tab";
    assert_eq!(
        f.get(query).await.1,
        json!({"sessionKey":"llm-chat:tab","transcript":[]})
    );
    for bytes in [
        "{\"messages\":[",
        "null",
        "{}",
        "{\"messages\":[null]}",
        "{\"messages\":[{\"role\":\"assistant\",\"content\":\"\",\"toolCalls\":1}]}",
        "{\"messages\":[],\"source\":\"bot-network\"}",
        "{\"messages\":[{\"id\":\"constructor\",\"role\":\"assistant\",\"content\":\"\",\"receipt\":{}}],\"pendingTurnWorkers\":{\"ordinary\":[]}}",
    ] {
        fs::write(f.path(), bytes).unwrap();
        assert_eq!(
            f.get(query).await.0,
            StatusCode::SERVICE_UNAVAILABLE,
            "{bytes}"
        );
    }
    let file = fs::File::create(f.path()).unwrap();
    file.set_len(16 * 1024 * 1024 + 1).unwrap();
    drop(file);
    assert_eq!(f.get(query).await.0, StatusCode::SERVICE_UNAVAILABLE);
    fs::remove_file(f.path()).unwrap();
    fs::write(f.0.join("other.json"), "{\"messages\":[]}").unwrap();
    std::os::unix::fs::symlink(f.0.join("other.json"), f.path()).unwrap();
    assert_eq!(f.get(query).await.0, StatusCode::SERVICE_UNAVAILABLE);
    fs::remove_file(f.path()).unwrap();
    fs::write(f.path(), "{\"messages\":[]}").unwrap();
    let db = f.db();
    db.execute("INSERT INTO lanes VALUES ('llm-chat:tab')", [])
        .unwrap();
    assert_eq!(f.get(query).await.0, StatusCode::SERVICE_UNAVAILABLE);
    db.execute("DELETE FROM lanes", []).unwrap();
    db.execute("DROP TABLE lanes", []).unwrap();
    assert_eq!(f.get(query).await.0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        f.get("sessionKey=codex:tab").await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}
#[tokio::test]
async fn maps_pending_workers_before_partial_filter_and_pages_with_mobile_conflict_shape() {
    let f = Fixture::new();
    fs::write(f.path(),serde_json::to_vec(&json!({"messages":[
        {"id":"same","role":"assistant","content":"partial","isPartial":true,"receipt":{}},
        {"id":"same","role":"assistant","content":"final","receipt":{"workers":[{"packetId":"existing"}]}},
        {"role":"user","content":"legacy","mentions":[{"label":"file"}],"timestamp":0}],
        "pendingTurnWorkers":{"same":[{"packetId":"pending"}]}})).unwrap()).unwrap();
    let (_, plain) = f.get("sessionKey=llm-chat:tab").await;
    assert_eq!(plain["transcript"].as_array().unwrap().len(), 2);
    assert_eq!(
        plain["transcript"][0]["receipt"]["workers"],
        json!([{"packetId":"existing"}])
    );
    assert_eq!(
        plain["transcript"][1]["mentions"],
        json!([{"label":"file"}])
    );
    assert_eq!(plain["transcript"][1]["timestampLabel"], "");
    let (_, paged) = f.get("sessionKey=llm-chat:tab&page=1&limit=1").await;
    let cursor = paged["page"]["beforeCursor"].as_str().unwrap();
    assert!(paged["transcript"][0]["id"]
        .as_str()
        .unwrap()
        .starts_with("legacy-"));
    let (_, older) = f
        .get(&format!("sessionKey=llm-chat:tab&page=1&before={cursor}"))
        .await;
    assert_eq!(older["transcript"][0]["id"], "same");
    let (status, invalid) = f.get("sessionKey=llm-chat:tab&page=1&before=bad").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(invalid["ok"], false);
    assert_eq!(invalid["error"], "cursor_invalid");
    assert_eq!(invalid["currentRevision"], paged["page"]["revision"]);
}
