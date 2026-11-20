#![cfg(all(feature = "experimental-session-reads", unix))]
use axum::{body::to_bytes, http::StatusCode};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("o8d-window-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        fs::create_dir(directory.join("chat-history")).unwrap();
        Self(directory)
    }
    fn path(&self) -> PathBuf {
        self.0.join("chat-history/tab.json")
    }
    async fn get(&self, query: &str) -> (StatusCode, Value) {
        let response = o8d::http::native_request(
            self.0.clone(),
            self.0.join("unused.db"),
            "/api/v2/chat-history",
            query,
            "GET",
            &[],
            None,
        );
        if response.status() != StatusCode::SERVICE_UNAVAILABLE {
            assert!(response.headers().contains_key("server-timing"));
            assert!(!response.headers().contains_key("cache-control"));
        }
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
async fn distinguishes_missing_files_from_unsafe_unreadable_or_unsupported_records() {
    let f = Fixture::new();
    assert_eq!(f.get("tabId=tab").await.1["exists"], false);
    assert_eq!(f.get("").await.0, StatusCode::BAD_REQUEST);
    for bytes in [
        "{\"messages\":[",
        "null",
        "[]",
        "{}",
        "{\"messages\":null}",
        "{\"messages\":[1]}",
        "{\"messages\":[],\"source\":\"bot-network\"}",
        "{\"messages\":[{\"__proto__\":{}}]}",
        "{\"messages\":[{\"content\":\"\\ud800\"}]}",
    ] {
        fs::write(f.path(), bytes).unwrap();
        assert_eq!(
            f.get("tabId=tab").await.0,
            StatusCode::SERVICE_UNAVAILABLE,
            "{bytes}"
        );
    }
    let file = fs::File::create(f.path()).unwrap();
    file.set_len(16 * 1024 * 1024 + 1).unwrap();
    drop(file);
    assert_eq!(f.get("tabId=tab").await.0, StatusCode::SERVICE_UNAVAILABLE);
    fs::remove_file(f.path()).unwrap();
    fs::create_dir(f.path()).unwrap();
    assert_eq!(f.get("tabId=tab").await.0, StatusCode::SERVICE_UNAVAILABLE);
    fs::remove_dir(f.path()).unwrap();
    fs::write(f.0.join("other.json"), "{\"messages\":[]}").unwrap();
    std::os::unix::fs::symlink(f.0.join("other.json"), f.path()).unwrap();
    assert_eq!(f.get("tabId=tab").await.0, StatusCode::SERVICE_UNAVAILABLE);
}
#[tokio::test]
async fn keeps_ids_and_revisions_stable_across_saved_at_only_and_atomic_rewrites() {
    let f = Fixture::new();
    let mut record = json!({"messages":[{"content":"legacy","costUsd":0.000001},{"content":"legacy","costUsd":0.000001}],"savedAt":"first","projectId":"\u{feff} project \u{a0}"});
    fs::write(f.path(), serde_json::to_vec(&record).unwrap()).unwrap();
    let (status, first) = f.get("tabId=tab&limit=1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["projectId"], "project");
    assert_eq!(first["page"]["total"], 2);
    assert!(first["messages"][0]["id"].as_str().unwrap().ends_with("-2"));
    let cursor = first["page"]["beforeCursor"].as_str().unwrap();
    let (_, before) = f.get(&format!("tabId=tab&limit=1&before={cursor}")).await;
    assert_ne!(before["messages"][0]["id"], first["messages"][0]["id"]);
    record["savedAt"] = json!("second");
    let replacement = f.0.join("replacement");
    fs::write(&replacement, serde_json::to_vec(&record).unwrap()).unwrap();
    fs::rename(replacement, f.path()).unwrap();
    assert_eq!(
        f.get("tabId=tab&limit=1").await.1["page"]["revision"],
        first["page"]["revision"]
    );
    record["messages"][0]["content"] = json!("changed");
    fs::write(f.path(), serde_json::to_vec(&record).unwrap()).unwrap();
    let (status, stale) = f.get(&format!("tabId=tab&before={cursor}")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(stale["error"], "cursor_invalid");
    assert_ne!(stale["currentRevision"], first["page"]["revision"]);
}
