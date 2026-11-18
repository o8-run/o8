#![cfg(all(feature = "experimental-session-reads", target_os = "linux"))]
use axum::{body::to_bytes, http::StatusCode};
use o8d::http::native_request;
use serde_json::{json, Value};
use std::path::Path;
async fn read(root: &Path, scope: Value) -> (StatusCode, Value) {
    let response = native_request(
        root.to_owned(),
        root.join("missing.db"),
        "/api/cortex/directives",
        "",
        "GET",
        &[],
        Some(json!({"directivesScope":scope})),
    );
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn fresh_file_reads_require_bounded_scope_and_refuse_symlinks() {
    let root = std::env::temp_dir().join(format!(
        "o8d-directives-rust-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let scope = json!({"version":1,"directoryExists":true,"projectIds":["project"],"projectSlugs":["project"],"repoInActiveProject":false});
    assert_eq!(
        read(&root, json!({"version":1,"directoryExists":false})).await,
        (StatusCode::OK, json!({"directives":[]}))
    );
    let dir = root.join("directives");
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("plain.md");
    std::fs::write(&file, "---\ntitle: plain\nscope: global\n---\nfirst\n").unwrap();
    let (status, body) = read(&root, scope.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["directives"][0]["body"], "first");
    std::fs::write(&file, "---\ntitle: plain\nscope: global\n---\nfresh\n").unwrap();
    assert_eq!(
        read(&root, scope.clone()).await.1["directives"][0]["body"],
        "fresh"
    );
    for bad in [
        Value::Null,
        json!({"version":2}),
        json!({"version":1,"directoryExists":false}),
        json!({"version":1,"directoryExists":true,"projectIds":vec!["id";129],"projectSlugs":[],"repoInActiveProject":false}),
    ] {
        assert_eq!(read(&root, bad).await.0, StatusCode::SERVICE_UNAVAILABLE);
    }
    std::os::unix::fs::symlink(&file, dir.join("linked.md")).unwrap();
    assert_eq!(
        read(&root, scope.clone()).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    std::fs::remove_file(dir.join("linked.md")).unwrap();
    std::fs::write(&file, "malformed").unwrap();
    assert_eq!(read(&root, scope).await.0, StatusCode::SERVICE_UNAVAILABLE);
    std::fs::remove_dir_all(root).unwrap();
}
