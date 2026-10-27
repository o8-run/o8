//! Real signed download, kill switch, post-download admission, platform replacement,
//! native reservation and final inspection. Only process relaunch is replaced.
#![cfg(target_os = "macos")]
use crate::launch_updater::scheduler::auto_apply::{Effects, NativeEffects};
use base64::Engine;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

struct Service {
    base: String,
    events: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    admission: Arc<AtomicBool>,
}
impl Drop for Service {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}
fn service(valid: bool, pulled: bool, admission: bool) -> Service {
    let admission = Arc::new(AtomicBool::new(admission));
    let allowed_install = admission.clone();
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    socket.set_nonblocking(true).unwrap();
    let base = format!("http://{}", socket.local_addr().unwrap());
    let origin = base.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let done = stop.clone();
    let events = Arc::new(Mutex::new(Vec::new()));
    let observed = events.clone();
    std::thread::spawn(move || {
        while !done.load(Ordering::SeqCst) {
            let Ok((mut stream, _)) = socket.accept() else {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0; 4096];
            let split = loop {
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(i) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let headers = String::from_utf8_lossy(&bytes[..split]).to_lowercase();
            let length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .and_then(|n| n.parse::<usize>().ok())
                .unwrap_or(0);
            while bytes.len() < split + length {
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
            }
            let path = headers
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap()
                .to_string();
            observed.lock().unwrap().push(path.clone());
            let reply = if path == "/manifest" || path.ends_with("/latest.json") {
                serde_json::json!({"channel":"stable", "version":"0.2.0", "url": format!("{origin}/artifact"), "signature":
                    if valid { include_str!("../../artifacts/valid.signature.b64").trim() }
                    else { include_str!("../../artifacts/invalid.signature.b64").trim() }}).to_string().into_bytes()
            } else if path == "/artifact" {
                base64::engine::general_purpose::STANDARD
                    .decode(if valid {
                        include_str!("../../artifacts/valid.artifact.b64").trim()
                    } else {
                        include_str!("../../artifacts/invalid.artifact.b64").trim()
                    })
                    .unwrap()
            } else if path.starts_with("/api/panel/release-health") {
                serde_json::json!({"pulled":pulled})
                    .to_string()
                    .into_bytes()
            } else if path == "/api/panel/cloud-jobs/drain" {
                b"{\"ok\":true}".to_vec()
            } else {
                let body: serde_json::Value = serde_json::from_slice(&bytes[split..]).unwrap();
                let allowed = if body["autoApply"]["action"] == "inspect-restart" {
                    true
                } else {
                    allowed_install.load(Ordering::SeqCst)
                };
                serde_json::json!({"allowed": allowed})
                    .to_string()
                    .into_bytes()
            };
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.len()).unwrap();
            stream.write_all(&reply).unwrap();
        }
    });
    Service {
        base,
        events,
        stop,
        admission,
    }
}

#[test]
fn production_install_boundary_uses_signed_artifact_health_admission_and_restart_guard() {
    for (valid, pulled, admission) in [
        (true, false, true),
        (false, false, true),
        (true, true, true),
        (true, false, false),
    ] {
        let service = service(valid, pulled, admission);
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("Fixture.app/Contents/MacOS/fixture");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, "old fixture").unwrap();
        let app = super::build_app(&service.base, &service.base, "0.1.0");
        std::fs::write(directory.path().join("ws-token"), "scheduler-fixture").unwrap();
        let cleanup = Arc::new(Mutex::new(0));
        let calls = cleanup.clone();
        let port = reqwest::Url::parse(&service.base).unwrap().port().unwrap();
        app.manage(crate::restart_job_drain::guard(
            directory.path().to_path_buf(),
            port,
            move || *calls.lock().unwrap() += 1,
        ));
        let effects = NativeEffects {
            app: app.handle().clone(),
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            base: service.base.clone(),
            token: "scheduler-fixture".into(),
        };
        let outcome = tauri::async_runtime::block_on(async {
            let update = app
                .updater_builder()
                .endpoints(vec![format!("{}/manifest", service.base).parse().unwrap()])
                .unwrap()
                .pubkey(include_str!("../../artifacts/public-key.b64").trim())
                .executable_path(&executable)
                .build()
                .unwrap()
                .check()
                .await
                .unwrap()
                .unwrap();
            effects.install_candidate(update, "fixture-attempt").await
        });
        assert_eq!(outcome == Ok(true), valid && !pulled && admission);
        assert_eq!(
            *cleanup.lock().unwrap(),
            0,
            "installation alone must not clean up on macOS"
        );
        let mut relaunches = 0;
        if outcome == Ok(true) {
            assert_eq!(
                std::fs::read_to_string(&executable).unwrap(),
                "isolated updater fixture installed\n"
            );
            effects
                .restart_with(|| {
                    relaunches += 1;
                    Ok(())
                })
                .unwrap();
            assert_eq!(*cleanup.lock().unwrap(), 1);
            assert_eq!(relaunches, 1);
            assert!(service
                .events
                .lock()
                .unwrap()
                .contains(&"/api/panel/app/update-state".into()));
        } else {
            assert_eq!(std::fs::read_to_string(&executable).unwrap(), "old fixture");
            assert_eq!(relaunches, 0);
        }
        if valid && !pulled && !admission {
            assert_eq!(
                outcome,
                Ok(false),
                "temporary work is a wait, not an install failure"
            );
            assert!(!directory
                .path()
                .join("automatic-install-attempts/0.2.0.json")
                .exists());
            service.admission.store(true, Ordering::SeqCst);
            let resumed = tauri::async_runtime::block_on(async {
                let update = app
                    .updater_builder()
                    .endpoints(vec![format!("{}/manifest", service.base).parse().unwrap()])
                    .unwrap()
                    .pubkey(include_str!("../../artifacts/public-key.b64").trim())
                    .executable_path(&executable)
                    .build()
                    .unwrap()
                    .check()
                    .await
                    .unwrap()
                    .unwrap();
                effects.install_candidate(update, "retry-after-work").await
            });
            assert_eq!(resumed, Ok(true));
            assert_eq!(
                std::fs::read_to_string(&executable).unwrap(),
                "isolated updater fixture installed\n"
            );
        }
        if !valid {
            // The durable marker survives a replacement scheduler or application launch.
            let journal =
                crate::launch_updater::scheduler::auto_apply::install_journal::InstallJournal::new(
                    directory.path().to_path_buf(),
                );
            assert!(journal.check("0.2.0").is_err());
            let relaunched = super::build_app(&service.base, &service.base, "0.1.0");
            relaunched.manage(o8_restart_safety::RestartSafety::new(
                directory.path().to_path_buf(),
                || panic!("failed version must not clean up"),
            ));
            let next = NativeEffects {
                app: relaunched.handle().clone(),
                client: effects.client.clone(),
                base: service.base.clone(),
                token: "scheduler-fixture".into(),
            };
            let before = service.events.lock().unwrap().len();
            assert!(
                tauri::async_runtime::block_on(next.install("0.2.0", "replacement-task")).is_err()
            );
            assert_eq!(
                service.events.lock().unwrap().len(),
                before,
                "a failed version must not check or download again on launch"
            );
        }
        let events = service.events.lock().unwrap();
        assert!(events
            .iter()
            .any(|path| path.starts_with("/api/panel/release-health")));
        assert_eq!(events.iter().any(|p| p == "/artifact"), !pulled);
        assert_eq!(effects.data_directory().unwrap().unwrap(), directory.path());
    }
}

#[test]
fn native_auto_apply_waits_for_task_ownership_storage_before_admission() {
    let service = service(true, false, true);
    let app = super::build_app(&service.base, &service.base, "0.1.0");
    let effects = NativeEffects {
        app: app.handle().clone(),
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
        base: service.base.clone(),
        token: "scheduler-fixture".into(),
    };
    let mut automatic =
        crate::launch_updater::scheduler::auto_apply::AutoApply::new(Duration::ZERO);
    tauri::async_runtime::block_on(automatic.tick(
        &effects.client,
        &format!("{}/api/panel/app/update-state", service.base),
        "scheduler-fixture",
        &effects,
    ));
    assert!(service.events.lock().unwrap().is_empty());
}

#[test]
fn webview_ipc_download_and_install_stage_signed_bytes_without_restarting() {
    use tauri::{
        test::{get_ipc_response, INVOKE_KEY},
        WebviewWindowBuilder,
    };
    let service = service(true, false, true);
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("Fixture.app/Contents/MacOS/fixture");
    std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
    std::fs::write(&executable, "old fixture").unwrap();
    let app = super::build_app(&service.base, &service.base, "0.1.0");
    let view = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let invoke = |command: &str, body: serde_json::Value| {
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
    };
    let metadata = invoke("check_app_update", serde_json::json!({}))
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();
    assert_eq!(metadata["installExits"], false);
    let mut checked = view
        .resources_table()
        .take::<crate::update_ping::CheckedUpdate>(metadata["rid"].as_u64().unwrap() as u32)
        .unwrap();
    // Redirect only the macOS replacement path into the fixture bundle. The
    // production commands still own download, signature validation and install.
    Arc::get_mut(&mut checked).unwrap().update = tauri::async_runtime::block_on(async {
        app.updater_builder()
            .endpoints(vec![format!("{}/manifest", service.base).parse().unwrap()])
            .unwrap()
            .pubkey(include_str!("../../artifacts/public-key.b64").trim())
            .executable_path(&executable)
            .build()
            .unwrap()
            .check()
            .await
            .unwrap()
            .unwrap()
    });
    let rid = view.resources_table().add_arc(checked);
    let downloaded = invoke(
        "download_app_update",
        serde_json::json!({"rid":rid,"onEvent":"__CHANNEL__:9"}),
    )
    .unwrap()
    .deserialize::<u32>()
    .unwrap();
    assert_eq!(std::fs::read_to_string(&executable).unwrap(), "old fixture");
    invoke(
        "install_app_update",
        serde_json::json!({"rid":downloaded,"force":false}),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(&executable).unwrap(),
        "isolated updater fixture installed\n"
    );
    assert!(invoke(
        "install_app_update",
        serde_json::json!({"rid":downloaded,"force":false})
    )
    .is_err());
}
