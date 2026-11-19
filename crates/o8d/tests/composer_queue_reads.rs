#![cfg(feature = "experimental-session-reads")]
use axum::{body::to_bytes, http::StatusCode};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("o8d-queue-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        fs::create_dir(directory.join("chat-history")).unwrap();
        fs::write(directory.join("chat-history/thoughts-queue.json"),serde_json::to_vec(&json!({"messages":[{"id":"composer-steer-item","content":"delivered text","steerAnchor":{"messageId":"anchor"}}]})).unwrap()).unwrap();
        let db = Connection::open(directory.join("cortex-ide.db")).unwrap();
        db.execute_batch("CREATE TABLE composer_send_queue(sequence INTEGER PRIMARY KEY,id TEXT,repo_path TEXT,thread_id TEXT,intent TEXT,payload_json TEXT,status TEXT,reason TEXT,created_at INTEGER,updated_at INTEGER,admitted_at INTEGER); CREATE TABLE bot_network_threads(thread_id TEXT); INSERT INTO composer_send_queue VALUES (1,'item','/fixture','thoughts-queue','steer-now','{\"text\":\"old\",\"routing\":{\"backend\":\"pi\",\"mode\":\"single\",\"collide\":true},\"deliveredMedia\":[{\"path\":\"/media\"}]}','applied',NULL,1,2,2);").unwrap();
        Self(directory)
    }
    fn context(&self) -> Value {
        json!({"composerQueue":{"target":{"repoPath":"/fixture","threadId":"thoughts-queue"},"request":{"repoPath":"/fixture","threadId":"thoughts-queue","backend":"pi"},"capabilities":serde_json::from_str::<Vec<String>>(include_str!("../orchestrator-backend-ids.json")).unwrap().iter().map(|id| json!({"id":id,"liveSteer":id == "pi"})).collect::<Vec<_>>()}})
    }
    fn db(&self) -> Connection {
        Connection::open(self.0.join("cortex-ide.db")).unwrap()
    }
    async fn get(&self, context: Option<Value>) -> (StatusCode, Value) {
        let response = o8d::http::native_request(
            self.0.clone(),
            self.0.join("cortex-ide.db"),
            "/api/orchestrator/composer-queue",
            "repoPath=/fixture&threadId=thoughts-queue&backend=pi",
            "GET",
            &[],
            context,
        );
        let status = response.status();
        if status == StatusCode::OK {
            assert_eq!(response.headers()["cache-control"], "no-store");
        }
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
async fn maps_applied_receipts_and_uses_only_granted_routing_capabilities() {
    let f = Fixture::new();
    let (status, body) = f.get(Some(f.context())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["canSteer"], true);
    assert_eq!(body["steerableIds"], json!(["item"]));
    assert_eq!(body["items"][0]["payload"]["text"], "delivered text");
    assert_eq!(
        body["items"][0]["payload"]["images"],
        json!([{"name":"Image","dataUri":"/media"}])
    );
    assert_eq!(
        body["items"][0]["steerAnchor"],
        json!({"messageId":"anchor"})
    );
    f.db().execute("UPDATE composer_send_queue SET payload_json=json_set(payload_json,'$.routing.mode','fleet')",[]).unwrap();
    assert_eq!(f.get(Some(f.context())).await.1["steerableIds"], json!([]));
    let mut context = f.context();
    context["composerQueue"]["capabilities"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|row| row["id"] == "pi")
        .unwrap()["liveSteer"] = json!(false);
    assert_eq!(f.get(Some(context)).await.1["canSteer"], false);
}
#[tokio::test]
async fn defers_missing_scope_malformed_grants_states_and_json() {
    let f = Fixture::new();
    // native_request is the app admission transport, even when its supplied
    // context is absent/empty. It must never enter the standalone read mode.
    assert_eq!(f.get(None).await.0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        f.get(Some(json!({}))).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let mut context = f.context();
    context["composerQueue"]["request"]["repoPath"] = json!("/other");
    assert_eq!(
        f.get(Some(context)).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let mut context = f.context();
    context["composerQueue"]["capabilities"] = json!([{ "id":"pi","liveSteer":"yes" }]);
    assert_eq!(
        f.get(Some(context)).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let db = f.db();
    db.execute("UPDATE composer_send_queue SET payload_json=json_set(payload_json,'$.routing.backend','unknown')",[]).unwrap();
    let (status, body) = f.get(Some(f.context())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["steerableIds"], json!([]));
    for (field, value) in [
        ("backend", "12"),
        ("mode", "false"),
        ("collide", "\"true\""),
    ] {
        db.execute(&format!("UPDATE composer_send_queue SET payload_json=json_set(payload_json, '$.routing.{field}', json(?))"), [value]).unwrap();
        assert_eq!(
            f.get(Some(f.context())).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        db.execute("UPDATE composer_send_queue SET payload_json='{\"routing\":{\"backend\":\"unknown\",\"mode\":\"single\",\"collide\":false}}'", []).unwrap();
    }
    db.execute("UPDATE composer_send_queue SET status='unknown'", [])
        .unwrap();
    assert_eq!(
        f.get(Some(f.context())).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    db.execute(
        "UPDATE composer_send_queue SET status='queued',payload_json='{bad'",
        [],
    )
    .unwrap();
    assert_eq!(
        f.get(Some(f.context())).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    db.execute(
        "ALTER TABLE composer_send_queue RENAME COLUMN payload_json TO bad_column",
        [],
    )
    .unwrap();
    assert_eq!(
        f.get(Some(f.context())).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn standalone_http_reads_saved_queue_with_no_grant_and_all_capabilities_false() {
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
    };
    let f = Fixture::new();
    fs::write(f.0.join("ws-token"), "standalone-fixture-credential").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_o8d"))
        .args([
            "--experimental-http",
            "--listen",
            "127.0.0.1:0",
            "--data-dir",
        ])
        .arg(&f.0)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    struct Stop(std::process::Child);
    impl Drop for Stop {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let line = BufReader::new(child.stdout.take().unwrap())
        .lines()
        .next()
        .unwrap()
        .unwrap();
    let _stop = Stop(child);
    let ready: Value = serde_json::from_str(&line).unwrap();
    let url = format!("http://{}/api/orchestrator/composer-queue?repoPath=/fixture&threadId=thoughts-queue&backend=pi", ready["listening"].as_str().unwrap());
    let client = reqwest::Client::new();
    assert_eq!(
        client.get(&url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let response = client
        .get(&url)
        .bearer_auth("standalone-fixture-credential")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    assert_eq!(body["canSteer"], false);
    assert_eq!(body["steerableIds"], json!([]));
    assert_eq!(body["items"][0]["id"], "item");
    assert_eq!(body["items"][0]["payload"]["text"], "delivered text");
    f.db()
        .execute("UPDATE composer_send_queue SET payload_json='{bad'", [])
        .unwrap();
    assert_eq!(
        client
            .get(&url)
            .bearer_auth("standalone-fixture-credential")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}
