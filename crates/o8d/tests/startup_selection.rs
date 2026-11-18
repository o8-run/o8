#![cfg(feature = "experimental-session-reads")]
use axum::http::StatusCode;
use serde_json::Value;
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
};
struct Fixture {
    directory: PathBuf,
    child: Option<Child>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
#[tokio::test]
async fn app_ws_info_never_uses_the_standalone_saved_port_reader() {
    let directory =
        std::env::temp_dir().join(format!("o8d-startup-selection-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let mut fixture = Fixture {
        directory: directory.canonicalize().unwrap(),
        child: None,
    };
    std::fs::write(fixture.directory.join("ws-port"), "12345").unwrap();
    std::fs::write(
        fixture.directory.join("ws-token"),
        "startup-selection-fixture-credential",
    )
    .unwrap();
    // This integration test is its own process. An admitted read without the
    // launch resolver snapshot must defer, even when saved port/token exist.
    std::env::remove_var("O8D_STARTUP_PORT_INFO");
    std::env::remove_var("O8D_NATIVE_SESSION_READS");
    let native = o8d::http::native_request(
        fixture.directory.clone(),
        fixture.directory.join("cortex-ide.db"),
        "/api/panel/ws-info",
        "",
        "GET",
        &[],
        None,
    );
    assert_eq!(native.status(), StatusCode::SERVICE_UNAVAILABLE);
    let mut child = Command::new(env!("CARGO_BIN_EXE_o8d"))
        .args([
            "--experimental-http",
            "--listen",
            "127.0.0.1:0",
            "--data-dir",
        ])
        .arg(&fixture.directory)
        .env_remove("O8D_STARTUP_PORT_INFO")
        .env_remove("O8D_NATIVE_SESSION_READS")
        .env_remove("O8D_NATIVE_OWNED")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let output = child.stdout.take().unwrap();
    fixture.child = Some(child);
    let ready: Value =
        serde_json::from_str(&BufReader::new(output).lines().next().unwrap().unwrap()).unwrap();
    let url = format!(
        "http://{}/api/panel/ws-info",
        ready["listening"].as_str().unwrap()
    );
    let client = reqwest::Client::new();
    assert_eq!(
        client.get(&url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let response = client
        .get(&url)
        .bearer_auth("startup-selection-fixture-credential")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["wsPort"], 12345);
    // Compare as a boolean so credential bytes cannot appear in a failure dump.
    assert!(body["wsToken"] == "startup-selection-fixture-credential");
}
