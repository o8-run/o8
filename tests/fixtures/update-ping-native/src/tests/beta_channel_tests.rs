use super::{app, build_app, headers, invoke, server};
use std::time::Duration;
use tauri::Manager;

#[test]
fn beta_selection_reaches_primary_and_survives_restart() {
    let primary = server("ok");
    let fallback = server("ok");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("update-ping.json");
    std::fs::write(
        &path,
        serde_json::json!({
            "installId": uuid::Uuid::new_v4().to_string(), "channel": "beta"
        })
        .to_string(),
    )
    .unwrap();
    for _ in 0..2 {
        let app = app(&primary.url, &fallback.url, &path);
        assert_eq!(invoke(&app)["version"], "0.2.0");
        let channels = (0..2).map(|_| {
            let request = primary.requests.recv_timeout(Duration::from_secs(3)).unwrap();
            headers(&request)["x-o8-channel"].clone()
        }).collect::<std::collections::BTreeSet<_>>();
        assert_eq!(channels, ["beta".to_owned(), "stable".to_owned()].into());
    }
    assert!(fallback.requests.try_recv().is_err());
}

#[test]
fn beta_fallback_reads_its_own_manifest_without_identity_headers() {
    let primary = server("failure");
    let fallback = server("ok");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("update-ping.json");
    std::fs::write(
        &path,
        serde_json::json!({
            "installId": uuid::Uuid::new_v4().to_string(), "channel": "beta"
        })
        .to_string(),
    )
    .unwrap();
    let app = app(&primary.url, &fallback.url, &path);
    assert_eq!(invoke(&app)["version"], "0.2.0");
    let mut paths = std::collections::BTreeSet::new();
    for _ in 0..2 {
        let request = fallback.requests.recv_timeout(Duration::from_secs(3)).unwrap();
        paths.insert(request.lines().next().unwrap().to_owned());
        assert!(!headers(&request).keys().any(|key| key.starts_with("x-o8-")));
    }
    assert_eq!(paths, ["GET /beta.json HTTP/1.1".to_owned(), "GET /latest.json HTTP/1.1".to_owned()].into());
}

#[test]
fn returning_to_stable_waits_until_stable_exceeds_installed_version() {
    for mode in ["ok", "failure"] {
        let primary = server(mode);
        let fallback = server("ok");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-ping.json");
        std::fs::write(
            &path,
            serde_json::json!({
                "installId": uuid::Uuid::new_v4().to_string(), "channel": "stable"
            })
            .to_string(),
        )
        .unwrap();
        let app = build_app(&primary.url, &fallback.url, "0.3.0");
        crate::update_ping::initialize_at(app.handle(), &path).unwrap();
        let checked =
            tauri::async_runtime::block_on(crate::update_ping::check(app.handle())).unwrap();
        assert!(checked.is_none(), "must never downgrade to 0.2.0");
    }
}

#[test]
fn launch_check_uses_the_same_beta_selection() {
    let primary = server("ok");
    let fallback = server("ok");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("update-ping.json");
    std::fs::write(
        &path,
        serde_json::json!({
            "installId": uuid::Uuid::new_v4().to_string(), "channel": "beta"
        })
        .to_string(),
    )
    .unwrap();
    let app = app(&primary.url, &fallback.url, &path);
    let report = tauri::async_runtime::block_on(crate::launch_updater::run_check(app.handle()));
    assert_eq!(report["checkOutcome"], "available");
    let channels = (0..2).map(|_| {
        let request = primary.requests.recv_timeout(Duration::from_secs(3)).unwrap();
        headers(&request)["x-o8-channel"].clone()
    }).collect::<std::collections::BTreeSet<_>>();
    assert_eq!(channels, ["beta".to_owned(), "stable".to_owned()].into());
}

#[test]
fn settings_commands_persist_beta_and_return_to_stable() {
    use tauri::test::{get_ipc_response, INVOKE_KEY};
    let primary = server("ok");
    let fallback = server("ok");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("update-ping.json");
    let app = app(&primary.url, &fallback.url, &path);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let command = |cmd: &str, body: serde_json::Value| {
        get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
    };
    assert_eq!(
        command("get_update_channel", serde_json::json!({}))
            .unwrap()
            .deserialize::<String>()
            .unwrap(),
        "stable"
    );
    for channel in ["beta", "stable"] {
        assert_eq!(
            command(
                "set_update_channel",
                serde_json::json!({ "channel": channel })
            )
            .unwrap()
            .deserialize::<String>()
            .unwrap(),
            channel
        );
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["channel"], channel);
    }
    assert!(command(
        "set_update_channel",
        serde_json::json!({ "channel": "other" })
    )
    .is_err());
    assert_eq!(
        command("get_update_channel", serde_json::json!({}))
            .unwrap()
            .deserialize::<String>()
            .unwrap(),
        "stable"
    );
}

#[test]
fn beta_ignores_a_primary_that_serves_stable_or_reports_stable_current() {
    for mode in ["stable", "current"] {
        let primary = server(mode);
        let fallback = server("ok");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-ping.json");
        std::fs::write(
            &path,
            serde_json::json!({
                "installId": uuid::Uuid::new_v4().to_string(), "channel": "beta"
            })
            .to_string(),
        )
        .unwrap();
        let app = app(&primary.url, &fallback.url, &path);
        assert_eq!(invoke(&app)["version"], "0.2.0");
        let request = fallback
            .requests
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
        assert_eq!(request.lines().next().unwrap(), "GET /beta.json HTTP/1.1");
    }
}

#[test]
fn beta_enrollment_takes_newer_stable_through_manual_ipc_and_mirrors() {
    for mode in ["stable-ahead", "failure"] {
        let primary = server(mode);
        let fallback = server("stable-ahead");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-ping.json");
        std::fs::write(&path, serde_json::json!({
            "installId": uuid::Uuid::new_v4().to_string(), "channel": "beta"
        }).to_string()).unwrap();
        let app = build_app(&primary.url, &fallback.url, "0.2.0");
        crate::update_ping::initialize_at(app.handle(), &path).unwrap();
        let result = invoke(&app);
        assert_eq!(result["version"], "0.3.0");
        assert_eq!(result["channel"], "beta");
    }
}

#[test]
fn beta_enrollment_keeps_beta_when_it_is_newer_than_stable() {
    let primary = server("beta-ahead");
    let fallback = server("beta-ahead");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("update-ping.json");
    std::fs::write(&path, serde_json::json!({
        "installId": uuid::Uuid::new_v4().to_string(), "channel": "beta"
    }).to_string()).unwrap();
    let app = build_app(&primary.url, &fallback.url, "0.2.0");
    crate::update_ping::initialize_at(app.handle(), &path).unwrap();
    assert_eq!(invoke(&app)["version"], "0.4.0");
}

#[test]
fn beta_launch_check_takes_newer_stable() {
    let primary = server("stable-ahead");
    let fallback = server("stable-ahead");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("update-ping.json");
    std::fs::write(&path, serde_json::json!({
        "installId": uuid::Uuid::new_v4().to_string(), "channel": "beta"
    }).to_string()).unwrap();
    let app = build_app(&primary.url, &fallback.url, "0.2.0");
    crate::update_ping::initialize_at(app.handle(), &path).unwrap();
    let report = tauri::async_runtime::block_on(crate::launch_updater::run_check(app.handle()));
    assert_eq!(report["checkOutcome"], "available");
    assert_eq!(report["version"], "0.3.0");
}
