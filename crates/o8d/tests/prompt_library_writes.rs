#![cfg(feature = "experimental-session-reads")]
use axum::{body::to_bytes, http::StatusCode};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::PathBuf;
struct Fixture {
    directory: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("o8d-prompt-writer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let this = Self {
            directory: directory.canonicalize().unwrap(),
        };
        this.db()
            .execute_batch(include_str!("../src/http/prompt_library_v53.sql"))
            .unwrap();
        std::fs::write(
            this.directory.join(".db-migrated-v53"),
            r#"{"schemaVersion":53}"#,
        )
        .unwrap();
        this
    }
    fn db(&self) -> Connection {
        Connection::open(self.directory.join("cortex-ide.db")).unwrap()
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        query: &str,
        body: Value,
        grant: bool,
    ) -> (StatusCode, Value) {
        let response = o8d::http::native_request(
            self.directory.clone(),
            self.directory.join("cortex-ide.db"),
            path,
            query,
            method,
            &serde_json::to_vec(&body).unwrap(),
            grant.then(|| json!({"promptWriteAuthority":true})),
        );
        let status = response.status();
        let body = serde_json::from_slice(
            &to_bytes(response.into_body(), 16 * 1024 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        (status, body)
    }
    async fn create(&self, body: &str) -> Value {
        let (status, result) = self
            .request(
                "POST",
                "/api/prompt-library",
                "",
                json!({"title":" fixture ","body":body}),
                true,
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{result}");
        result["prompt"].clone()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
#[tokio::test]
async fn transactions_normalization_dedupe_revisions_use_and_delete() {
    let f = Fixture::new();
    let (status, scoped) = f
        .request(
            "POST",
            "/api/prompt-library",
            "",
            json!({"title":"repo", "body":"scoped", "scope":"repo", "repoPath":" /repo "}),
            true,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{scoped}");
    assert_eq!(scoped["prompt"]["repoPath"], "/repo");
    let first = f.create(" a  \r\nb\r").await;
    assert_eq!(first["title"], "fixture");
    assert_eq!(first["body"], "a  \nb");
    let (status, dup) = f
        .request(
            "POST",
            "/api/prompt-library",
            "",
            json!({"title":"duplicate","body":"a\nb"}),
            true,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(dup["created"], false);
    assert_eq!(dup["prompt"], first);
    let id = first["id"].as_str().unwrap();
    let path = format!("/api/prompt-library/{id}");
    // Make the next revision deterministic and ahead of wall time.
    let future = 8_000_000_000_000i64;
    f.db()
        .execute(
            "UPDATE prompt_library SET updated_at=? WHERE id=?",
            params![future, id],
        )
        .unwrap();
    let (status, patch) = f
        .request(
            "PATCH",
            &path,
            "",
            json!({"title":"edited","expectedUpdatedAt":future,"tags":[" A \t B ","a b","雪"]}),
            true,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(patch["prompt"]["updatedAt"], future + 1);
    assert_eq!(patch["prompt"]["tags"], json!(["A B", "雪"]));
    assert_eq!(
        f.request(
            "PATCH",
            &path,
            "",
            json!({"title":"stale","expectedUpdatedAt":future}),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, used) = f
        .request("POST", &(path.clone() + "/use"), "", json!({}), true)
        .await;
    assert_eq!(used["prompt"]["updatedAt"], future + 1);
    assert_eq!(used["prompt"]["useCount"], 1);
    assert!(used["prompt"]["lastUsedAt"].as_i64().unwrap() > 0);
    assert_eq!(
        f.request(
            "DELETE",
            &path,
            &format!("expectedUpdatedAt={future}"),
            Value::Null,
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.request(
            "DELETE",
            &path,
            &format!("expectedUpdatedAt={}", future + 1),
            Value::Null,
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        f.request("DELETE", &path, "", Value::Null, true).await.0,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn rejects_missing_authority_schema_marker_and_rolls_back_unmappable_answers() {
    let f = Fixture::new();
    assert_eq!(
        f.request(
            "POST",
            "/api/prompt-library",
            "",
            json!({"title":"x","body":"x"}),
            false
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        f.db()
            .query_row("SELECT count(*) FROM prompt_library", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    std::fs::write(
        f.directory.join(".db-migrated-v53"),
        r#"{"schemaVersion":52}"#,
    )
    .unwrap();
    assert_eq!(
        f.request(
            "POST",
            "/api/prompt-library",
            "",
            json!({"title":"x","body":"x"}),
            true
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    // Route and create normalization errors precede database/schema access.
    assert_eq!(
        f.request("POST", "/api/prompt-library", "", json!({}), true)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.request(
            "POST",
            "/api/prompt-library",
            "",
            json!({"title":"", "body":"x"}),
            true
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    std::fs::write(
        f.directory.join(".db-migrated-v53"),
        r#"{"schemaVersion":53}"#,
    )
    .unwrap();
    let first = f.create("existing").await;
    let id = first["id"].as_str().unwrap();
    f.db()
        .execute("UPDATE prompt_library SET tags_json='{' WHERE id=?", [id])
        .unwrap();
    // The SQL update ran, but the final response couldn't be mapped: rollback.
    assert_eq!(
        f.request(
            "POST",
            &format!("/api/prompt-library/{id}/use"),
            "",
            Value::Null,
            true
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        f.db()
            .query_row(
                "SELECT use_count FROM prompt_library WHERE id=?",
                [id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    f.db().execute_batch("CREATE TABLE unrelated (value TEXT); CREATE TRIGGER unexpected AFTER INSERT ON prompt_library BEGIN INSERT INTO unrelated VALUES ('no'); END;").unwrap();
    assert_eq!(
        f.request(
            "POST",
            "/api/prompt-library",
            "",
            json!({"title":"x","body":"x"}),
            true
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        f.db()
            .query_row("SELECT count(*) FROM unrelated", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[tokio::test]
async fn validation_order_and_duplicate_update_leave_existing_rows_unchanged() {
    let f = Fixture::new();
    let a = f.create("a").await;
    let b = f.create("b").await;
    let path = format!("/api/prompt-library/{}", b["id"].as_str().unwrap());
    let (status, body) = f
        .request("PATCH", &path, "", json!({"body":"a"}), true)
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "duplicate_prompt");
    assert_eq!(body["error"]["existing"], a);
    let (status, body) = f
        .request(
            "PATCH",
            "/api/prompt-library/absent",
            "",
            json!({"title":""}),
            true,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "prompt_not_found");
    for (input, code) in [
        (json!({}), "invalid_title"),
        (json!({"title":"","body":"x"}), "title_required"),
        (
            json!({"title":"x","body":"x","scope":"repo"}),
            "repo_path_required",
        ),
        (json!({"title":"𝒳".repeat(61),"body":"x"}), "title_too_long"),
    ] {
        let (status, body) = f
            .request("POST", "/api/prompt-library", "", input, true)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], code);
    }
}

#[tokio::test]
async fn concurrent_creates_have_one_commit_and_one_duplicate_answer() {
    let fixture = Fixture::new();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mut tasks = Vec::new();
    for _ in 0..2 {
        let root = fixture.directory.clone();
        let barrier = barrier.clone();
        tasks.push(tokio::task::spawn_blocking(move || {
            barrier.wait();
            o8d::http::native_request(
                root.clone(),
                root.join("cortex-ide.db"),
                "/api/prompt-library",
                "",
                "POST",
                br#"{"title":"concurrent","body":"one fingerprint"}"#,
                Some(json!({"promptWriteAuthority":true})),
            )
        }));
    }
    let mut statuses = Vec::new();
    let mut ids = Vec::new();
    for task in tasks {
        let response = task.await.unwrap();
        statuses.push(response.status().as_u16());
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
                .unwrap();
        ids.push(value["prompt"]["id"].clone());
    }
    statuses.sort();
    assert_eq!(statuses, vec![200, 201]);
    assert_eq!(ids[0], ids[1]);
    assert_eq!(
        fixture
            .db()
            .query_row("SELECT count(*) FROM prompt_library", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
