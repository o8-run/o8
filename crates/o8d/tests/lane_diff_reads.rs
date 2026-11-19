#![cfg(all(target_os = "linux", feature = "experimental-session-reads"))]
use axum::{body::to_bytes, http::StatusCode};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Command,
};
struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn git(root: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .args([
            "-C",
            root.to_str().unwrap(),
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgSign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(result.status.success());
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}
fn identity(path: &Path) -> Value {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path).unwrap();
    json!({"path":path,"dev":m.dev().to_string(),"ino":m.ino().to_string()})
}
fn fixture() -> (Fixture, Value) {
    let root = std::env::temp_dir().join(format!("o8d-lane-diff-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    git(&root, &["init", "-q", "-b", "lane-test"]);
    std::fs::write(root.join("file.txt"), "base\n").unwrap();
    git(&root, &["add", "file.txt"]);
    git(&root, &["commit", "-qm", "Fixture base"]);
    let base = git(&root, &["rev-parse", "HEAD"]);
    std::fs::write(root.join("file.txt"), "base\nfresh\n").unwrap();
    let target = json!({"version":1,"requestId":"lane-test","laneId":"lane-test","packetId":"packet-test","kind":"materialized","cwd":root,"branch":"lane-test","repositoryUuid":null,"mergeAvailable":true,"base":"main","baseTarget":{"kind":"creation","ref":base},"home":root,"configHome":null,"worktree":identity(&root),"admin":identity(&root.join(".git")),"common":identity(&root.join(".git"))});
    (Fixture(root), target)
}
async fn read(f: &Fixture, target: Value, policy: bool) -> (StatusCode, Value) {
    let directory = f.0.clone();
    let response = tokio::task::spawn_blocking(move || {
        o8d::http::native_request_viewer(
            directory.clone(),
            directory.join("cortex-ide.db"),
            "/api/lanes/lane-test/diff",
            "",
            "GET",
            &[],
            Some(json!({"laneDiffTarget":target})),
            if policy {
                o8d::http::ViewerRedaction::from_grant(
                    &json!({"normalizedValues":[],"activeCredentialHashes":[]}),
                )
            } else {
                None
            },
        )
    })
    .await
    .unwrap();
    let status = response.status();
    let body = serde_json::from_slice(
        &to_bytes(response.into_body(), 16 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    (status, body)
}
#[tokio::test]
async fn reads_uncommitted_work_and_defers_missing_policy_scope_and_changed_directory_identity() {
    let (f, target) = fixture();
    let (status, body) = read(&f, target.clone(), true).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["diff"].as_str().unwrap().contains("+fresh"));
    assert_eq!(body["diffBase"]["mergeBase"], target["baseTarget"]["ref"]);
    assert_eq!(body["maxBytes"], 65536);
    assert_eq!(body["revision"].as_str().unwrap().len(), 64);
    assert_eq!(
        read(&f, target.clone(), false).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    for (field, value) in [
        ("requestId", json!("foreign")),
        ("cwd", json!("relative")),
        ("kind", json!("immutable_snapshot")),
        ("version", json!(2)),
        ("packetId", json!("@@ -1 +1 @@\n+unprojected")),
    ] {
        let mut invalid = target.clone();
        invalid[field] = value;
        assert_eq!(
            read(&f, invalid, true).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    let alias = f.0.join("root-alias");
    std::os::unix::fs::symlink(&f.0, &alias).unwrap();
    let mut linked = target.clone();
    linked["cwd"] = json!(alias);
    linked["worktree"]["path"] = json!(alias);
    assert_eq!(
        read(&f, linked, true).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let mut invalid = target.clone();
    invalid["admin"]["ino"] = json!("0");
    assert_eq!(
        read(&f, invalid, true).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let extra = f.0.join(".git/unexpected-state");
    let mut nested = extra.clone();
    for _ in 0..128 {
        nested.push("x");
    }
    std::fs::create_dir_all(&nested).unwrap();
    assert_eq!(
        read(&f, target.clone(), true).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    std::fs::remove_dir_all(extra).unwrap();
    std::fs::write(f.0.join(".git/HEAD"), "ref: refs/heads/missing\n").unwrap();
    assert_eq!(
        read(&f, target, true).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}
