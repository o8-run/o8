#![cfg(feature = "experimental-session-reads")]
use axum::{body::to_bytes, http::StatusCode};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::PathBuf;
struct Fixture {
    directory: PathBuf,
    database: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("o8d-prompts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        Self {
            database: directory.join("cortex-ide.db"),
            directory,
        }
    }
    fn schema(&self) -> Connection {
        let db = Connection::open(&self.database).unwrap();
        db.execute_batch("CREATE TABLE prompt_library (id TEXT PRIMARY KEY,title TEXT,body TEXT,body_fingerprint TEXT,tags_json TEXT,scope TEXT,repo_path TEXT,source_kind TEXT,source_id TEXT,created_at INTEGER,updated_at INTEGER,last_used_at INTEGER,use_count INTEGER);
            INSERT INTO prompt_library VALUES ('a','café','text','fingerprint','[\"keep\",2,null,\" keep \"]','global',NULL,'manual',NULL,10,20,NULL,0);").unwrap();
        db
    }
    async fn get(&self, query: &str) -> (StatusCode, Value) {
        let response = o8d::http::native_request(
            self.directory.clone(),
            self.database.clone(),
            "/api/prompt-library",
            query,
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
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
#[tokio::test]
async fn maps_tags_and_nulls_and_observes_committed_wal_writes() {
    let fixture = Fixture::new();
    let db = fixture.schema();
    db.pragma_update(None, "journal_mode", "WAL").unwrap();
    let (status, body) = fixture.get("query=CAF%C3%89&limit=2.5").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["schema"], "o8/prompt-library.list/v1");
    assert_eq!(
        body["prompts"][0],
        json!({"id":"a","title":"café","body":"text","tags":["keep"," keep "],"scope":"global","repoPath":null,"sourceKind":"manual","sourceId":null,"createdAt":10,"updatedAt":20,"lastUsedAt":null,"useCount":0})
    );
    db.execute("UPDATE prompt_library SET body = 'fresh'", [])
        .unwrap();
    assert_eq!(fixture.get("").await.1["prompts"][0]["body"], "fresh");
    for (query, code) in [
        ("scope=bad", "invalid_scope_filter"),
        ("limit=0", "invalid_limit"),
        ("scope=repo", "repo_path_required"),
    ] {
        let (status, body) = fixture.get(query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], code);
    }
    assert_eq!(
        fixture.get(&format!("query={}", "a".repeat(201))).await.1["error"]["code"],
        "query_too_long"
    );
}
#[tokio::test]
async fn refuses_missing_database_schema_and_malformed_tags_without_partial_lists() {
    let missing = Fixture::new();
    assert_eq!(missing.get("").await.0, StatusCode::SERVICE_UNAVAILABLE);
    assert!(!missing.database.exists());
    assert_eq!(
        missing.get("limit=bad").await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let empty = Fixture::new();
    let _db = Connection::open(&empty.database).unwrap();
    assert_eq!(empty.get("").await.0, StatusCode::SERVICE_UNAVAILABLE);
    let fixture = Fixture::new();
    let db = fixture.schema();
    db.execute("UPDATE prompt_library SET tags_json = '{broken'", [])
        .unwrap();
    let (status, body) = fixture.get("").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.get("prompts").is_none());
    db.execute("UPDATE prompt_library SET tags_json = '[]'", [])
        .unwrap();
    db.execute(
        "ALTER TABLE prompt_library RENAME COLUMN body_fingerprint TO unavailable_fingerprint",
        [],
    )
    .unwrap();
    assert_eq!(fixture.get("").await.0, StatusCode::SERVICE_UNAVAILABLE);
    db.execute(
        "ALTER TABLE prompt_library RENAME COLUMN unavailable_fingerprint TO body_fingerprint",
        [],
    )
    .unwrap();
    db.execute(
        "ALTER TABLE prompt_library RENAME COLUMN title TO TITLE",
        [],
    )
    .unwrap();
    assert_eq!(fixture.get("").await.0, StatusCode::SERVICE_UNAVAILABLE);
}
