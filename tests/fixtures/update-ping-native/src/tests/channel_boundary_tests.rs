use super::{app, build_app, server};
use tauri::{
    test::{get_ipc_response, INVOKE_KEY},
    Manager,
};
fn command(
    app: &tauri::App<tauri::test::MockRuntime>,
    cmd: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    let view = app.get_webview_window("main").unwrap_or_else(|| {
        tauri::WebviewWindowBuilder::new(app, "main", Default::default())
            .build()
            .unwrap()
    });
    get_ipc_response(
        &view,
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
    .map(|v| v.deserialize().unwrap())
}
#[test]
fn stable_refuses_beta_identity_on_primary_and_fallback() {
    let primary = server("beta");
    let fallback = server("beta");
    let dir = tempfile::tempdir().unwrap();
    let app = app(
        &primary.url,
        &fallback.url,
        &dir.path().join("settings.json"),
    );
    assert!(
        command(&app, "check_app_update", serde_json::json!({})).is_err(),
        "Stable must refuse a higher beta manifest"
    );
}
#[test]
fn enrollment_persists_and_returning_to_stable_never_downgrades() {
    let primary = server("ok");
    let fallback = server("ok");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    {
        let app = build_app(&primary.url, &fallback.url, "0.3.0");
        crate::update_ping::initialize_at(app.handle(), &path).unwrap();
        assert_eq!(
            command(
                &app,
                "set_update_channel",
                serde_json::json!({"channel":"beta"})
            )
            .unwrap(),
            "beta"
        );
    }
    let app = build_app(&primary.url, &fallback.url, "0.3.0");
    crate::update_ping::initialize_at(app.handle(), &path).unwrap();
    assert_eq!(
        command(&app, "read_update_channel", serde_json::json!({})).unwrap(),
        "beta"
    );
    assert_eq!(
        command(
            &app,
            "set_update_channel",
            serde_json::json!({"channel":"stable"})
        )
        .unwrap(),
        "stable"
    );
    assert!(command(&app, "check_app_update", serde_json::json!({}))
        .unwrap()
        .is_null());
    let report = tauri::async_runtime::block_on(crate::launch_updater::run_check(app.handle()));
    assert_eq!(report["checkOutcome"], "current");
}

#[test]
fn beta_current_from_an_older_primary_still_reads_its_mirror() {
    let primary = server("ok");
    let fallback = server("channels");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let app = build_app(&primary.url, &fallback.url, "0.2.0");
    crate::update_ping::initialize_at(app.handle(), &path).unwrap();
    command(
        &app,
        "set_update_channel",
        serde_json::json!({"channel":"beta"}),
    )
    .unwrap();
    let result = command(&app, "check_app_update", serde_json::json!({})).unwrap();
    assert_eq!(result["version"], "0.3.0");
    assert_eq!(result["channel"], "beta");
}

#[test]
fn superseded_beta_launch_failure_never_emits_a_clear_after_newer_stable_check() {
    use tauri::Listener;
    let primary = server("slow");
    let fallback = server("ok");
    let dir = tempfile::tempdir().unwrap();
    let app = build_app(&primary.url, &fallback.url, "0.3.0");
    crate::update_ping::initialize_at(app.handle(), &dir.path().join("settings.json")).unwrap();
    command(
        &app,
        "set_update_channel",
        serde_json::json!({"channel":"beta"}),
    )
    .unwrap();
    let (tx, events) = std::sync::mpsc::channel();
    app.listen("o8://update-clear", move |event| {
        tx.send(event.payload().to_owned()).unwrap();
    });
    let handle = app.handle().clone();
    let older =
        tauri::async_runtime::spawn(async move { crate::launch_updater::run_check(&handle).await });
    primary
        .requests
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    command(
        &app,
        "set_update_channel",
        serde_json::json!({"channel":"stable"}),
    )
    .unwrap();
    assert!(command(&app, "check_app_update", serde_json::json!({}))
        .unwrap()
        .is_null());
    let report = tauri::async_runtime::block_on(older).unwrap();
    assert!(
        events.try_recv().is_err(),
        "a superseded native failure must not emit update-clear: {report}"
    );
    assert!(
        report.is_null(),
        "superseded native checks must not be replayed to the server"
    );
}

#[test]
fn native_tickets_are_shared_by_launch_and_ipc_checks_even_without_a_channel_change() {
    use tauri::Listener;
    let primary = server("slow");
    let fallback = server("ok");
    let dir = tempfile::tempdir().unwrap();
    let app = app(
        &primary.url,
        &fallback.url,
        &dir.path().join("settings.json"),
    );
    let (tx, events) = std::sync::mpsc::channel();
    let available = tx.clone();
    app.listen("o8://update-available", move |_| {
        available.send(()).unwrap();
    });
    app.listen("o8://update-clear", move |_| {
        tx.send(()).unwrap();
    });
    let handle = app.handle().clone();
    let older =
        tauri::async_runtime::spawn(async move { crate::launch_updater::run_check(&handle).await });
    primary
        .requests
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    let ticket = command(&app, "begin_update_check", serde_json::json!({})).unwrap();
    let result = command(
        &app,
        "check_app_update",
        serde_json::json!({"ticket":ticket}),
    )
    .unwrap();
    assert_eq!(result["version"], "0.2.0");
    assert_eq!(result["checkSequence"], ticket["checkSequence"]);
    assert_eq!(result["checkSession"], ticket["checkSession"]);
    assert!(tauri::async_runtime::block_on(older).unwrap().is_null());
    assert!(
        events.try_recv().is_err(),
        "an earlier native check must not emit after a newer IPC check began"
    );
}

#[test]
fn ipc_rejects_superseded_or_altered_tickets_before_transport() {
    let primary = server("ok");
    let fallback = server("ok");
    let dir = tempfile::tempdir().unwrap();
    let app = app(
        &primary.url,
        &fallback.url,
        &dir.path().join("settings.json"),
    );
    let older = command(&app, "begin_update_check", serde_json::json!({})).unwrap();
    let latest = command(&app, "begin_update_check", serde_json::json!({})).unwrap();
    assert_eq!(
        command(&app, "read_update_check_ticket", serde_json::json!({})).unwrap(),
        latest
    );
    assert!(command(
        &app,
        "check_app_update",
        serde_json::json!({"ticket":older})
    )
    .is_err());
    let mut altered = latest.clone();
    altered["channel"] = serde_json::json!("beta");
    assert!(command(
        &app,
        "check_app_update",
        serde_json::json!({"ticket":altered})
    )
    .is_err());
    assert!(primary.requests.try_recv().is_err());
    assert!(fallback.requests.try_recv().is_err());
    assert_eq!(
        command(
            &app,
            "check_app_update",
            serde_json::json!({"ticket":latest})
        )
        .unwrap()["version"],
        "0.2.0"
    );
}

#[test]
fn beta_uses_the_newer_beta_or_stable_candidate() {
    for (mode, expected) in [("channels", "0.3.0"), ("stable-newer", "0.4.0")] {
        let primary = server(mode);
        let fallback = server("channels");
        let dir = tempfile::tempdir().unwrap();
        let app = app(
            &primary.url,
            &fallback.url,
            &dir.path().join("settings.json"),
        );
        command(
            &app,
            "set_update_channel",
            serde_json::json!({"channel":"beta"}),
        )
        .unwrap();
        assert_eq!(
            command(&app, "check_app_update", serde_json::json!({})).unwrap()["version"],
            expected
        );
    }
}

#[test]
fn beta_github_fallback_reads_its_prerelease_tag_and_stable_keeps_latest() {
    let primary = server("failure");
    let fallback = server("channels");
    let dir = tempfile::tempdir().unwrap();
    let app = app(
        &primary.url,
        &format!("{}/owner/repo/releases/latest/download", fallback.url),
        &dir.path().join("settings.json"),
    );
    command(
        &app,
        "set_update_channel",
        serde_json::json!({"channel":"beta"}),
    )
    .unwrap();
    assert_eq!(
        command(&app, "check_app_update", serde_json::json!({})).unwrap()["version"],
        "0.3.0"
    );
    let beta = fallback
        .requests
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    let stable = fallback
        .requests
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    assert_eq!(
        beta.lines().next().unwrap(),
        "GET /owner/repo/releases/download/beta/beta.json HTTP/1.1"
    );
    assert_eq!(
        stable.lines().next().unwrap(),
        "GET /owner/repo/releases/latest/download/latest.json HTTP/1.1"
    );
}

#[test]
fn beta_requires_its_own_identity_on_primary_and_mirror_before_considering_stable() {
    let primary = server("wrong-beta-only");
    let fallback = server("channels");
    let dir = tempfile::tempdir().unwrap();
    let app = app(
        &primary.url,
        &fallback.url,
        &dir.path().join("settings.json"),
    );
    command(
        &app,
        "set_update_channel",
        serde_json::json!({"channel":"beta"}),
    )
    .unwrap();
    assert_eq!(
        command(&app, "check_app_update", serde_json::json!({})).unwrap()["version"],
        "0.3.0",
        "the Beta route must reject a higher primary manifest claiming Stable"
    );

    let primary = server("failure");
    let fallback = server("missing-beta");
    let dir = tempfile::tempdir().unwrap();
    let app = super::app(
        &primary.url,
        &fallback.url,
        &dir.path().join("settings.json"),
    );
    command(
        &app,
        "set_update_channel",
        serde_json::json!({"channel":"beta"}),
    )
    .unwrap();
    assert_eq!(command(&app, "check_app_update", serde_json::json!({})).unwrap()["version"], "0.2.0",
        "the Beta mirror must reject an unlabelled higher manifest and allow its verified Stable alternative");
}
