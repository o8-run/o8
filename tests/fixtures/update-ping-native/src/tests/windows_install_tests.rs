//! The real Windows plugin extracts an inert signed EXE, then must refuse its
//! exit when work appeared during download. A child isolates the plugin's exit(0).
#![cfg(target_os = "windows")]
use base64::Engine;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::{Manager, WebviewWindowBuilder};

#[test]
fn windows_webview_installer_guards_late_work_and_honors_recorded_force() {
    for scenario in [
        "terminal",
        "worker",
        "cli-force",
        "cli-force-identity-unavailable",
        "auto-worker",
    ] {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::windows_install_tests::windows_install_child",
                "--nocapture",
            ])
            .env("O8_WINDOWS_INSTALL_FIXTURE", scenario)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(
            String::from_utf8_lossy(&result.stdout).contains(
                if scenario.starts_with("cli-force") {
                    "native-force-recorded"
                } else {
                    "native-installer-refused"
                }
            ),
            "{scenario}: plugin exited before native admission returned: {}",
            String::from_utf8_lossy(&result.stdout)
        );
        if scenario == "cli-force-identity-unavailable" {
            assert!(String::from_utf8_lossy(&result.stdout)
                .contains("native-force-identity-unavailable-recorded"));
        }
    }
}

#[test]
fn windows_install_child() {
    let Ok(scenario) = std::env::var("O8_WINDOWS_INSTALL_FIXTURE") else {
        return;
    };
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_path_buf();
    let storage = root.clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let origin = base.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let done = stop.clone();
    let force = scenario.starts_with("cli-force");
    let unknown_identity = scenario == "cli-force-identity-unavailable";
    let automatic = scenario == "auto-worker";
    std::thread::spawn(move || {
        while !done.load(Ordering::Acquire) {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            let split = loop {
                let n = stream.read(&mut buffer).unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buffer[..n]);
                if let Some(i) = request.windows(4).position(|p| p == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..split]).to_lowercase();
            let length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .and_then(|n| n.parse::<usize>().ok())
                .unwrap_or(0);
            while request.len() < split + length {
                let n = stream.read(&mut buffer).unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buffer[..n]);
            }
            let artifact = headers.starts_with("get /artifact ");
            let admission = headers.starts_with("post /api/panel/app/update-state ");
            if (!automatic && artifact) || (automatic && admission) {
                let id = uuid::Uuid::new_v4().to_string();
                let (name, body) = if force {
                    (
                        "cli-operation-admission",
                        serde_json::json!({"version":1,"id":id,"kind":"installer", "pid":std::process::id(),
                    "runtime":"fixture","startedAt":"fixture","stage":"installing"}),
                    )
                } else {
                    (
                        "work-launches",
                        serde_json::json!({"id":id,"label":scenario,"ownerPid":std::process::id(),"pid":std::process::id()}),
                    )
                };
                std::fs::create_dir_all(storage.join(name)).unwrap();
                std::fs::write(
                    storage.join(name).join(format!("{id}.json")),
                    body.to_string(),
                )
                .unwrap();
            }
            let reply = if artifact {
                base64::engine::general_purpose::STANDARD
                    .decode(include_str!("../../artifacts/windows.artifact.b64").trim())
                    .unwrap()
            } else if admission {
                b"{\"allowed\":true}".to_vec()
            } else if headers.contains("/api/panel/release-health") {
                b"{\"pulled\":false}".to_vec()
            } else {
                serde_json::json!({"channel":"stable","version":"0.2.0","url":format!("{origin}/artifact"),
                "signature":include_str!("../../artifacts/windows.signature.b64").trim()})
                .to_string()
                .into_bytes()
            };
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                reply.len()
            )
            .unwrap();
            stream.write_all(&reply).unwrap();
        }
    });
    let mut context = mock_context(noop_assets());
    context.package_info_mut().version = "0.1.0".parse().unwrap();
    context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({
        "endpoints":[format!("{base}/primary"),format!("{base}/latest.json")],
        "pubkey":include_str!("../../artifacts/windows-public-key.b64").trim(), "dangerousInsecureTransportProtocol":true,
    }));
    let app = mock_builder()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            crate::update_ping::check_app_update,
            crate::update_ping::download_app_update,
            crate::update_ping::install_app_update
        ])
        .build(context)
        .unwrap();
    // Exercise both identified primary and unidentified fallback check builders.
    if !force {
        crate::update_ping::initialize_at(app.handle(), &root.join("identity.json")).unwrap();
    }
    let cleaned = Arc::new(AtomicUsize::new(0));
    let calls = cleaned.clone();
    let receipt_root = root.clone();
    app.manage(o8_restart_safety::RestartSafety::new(
        root.clone(),
        move || {
            if force {
                let receipts: Vec<_> = std::fs::read_dir(receipt_root.join("forced-restarts"))
                    .unwrap()
                    .flatten()
                    .collect();
                assert!(!receipts.is_empty());
                assert!(receipts
                    .iter()
                    .any(|entry| std::fs::read_to_string(entry.path())
                        .unwrap_or_default()
                        .contains("fixture")));
                if unknown_identity {
                    assert!(receipts
                        .iter()
                        .any(|entry| std::fs::read_to_string(entry.path())
                            .unwrap_or_default()
                            .contains("identity unavailable")));
                    println!("native-force-identity-unavailable-recorded");
                }
                println!("native-force-recorded");
                std::io::stdout().flush().unwrap();
            }
            calls.fetch_add(1, Ordering::SeqCst);
        },
    ));
    let view = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let invoke = |cmd: &str, body: serde_json::Value| {
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
    };
    let metadata = invoke("check_app_update", serde_json::json!({"force":force}))
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();
    if automatic {
        let update = view
            .resources_table()
            .get::<crate::update_ping::CheckedUpdate>(metadata["rid"].as_u64().unwrap() as u32)
            .unwrap();
        let effects = crate::launch_updater::scheduler::auto_apply::NativeEffects {
            app: app.handle().clone(),
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            base: base.clone(),
            token: "fixture".into(),
        };
        for attempt in ["late-admission", "retry-admission"] {
            assert_eq!(
                tauri::async_runtime::block_on(
                    effects.install_candidate(update.update.clone(), attempt)
                ),
                Ok(false)
            );
            crate::launch_updater::scheduler::auto_apply::install_journal::InstallJournal::new(
                root.clone(),
            )
            .check("0.2.0")
            .unwrap();
        }
    } else {
        let bytes = invoke(
            "download_app_update",
            serde_json::json!({"rid":metadata["rid"],"onEvent":"__CHANNEL__:9"}),
        )
        .unwrap()
        .deserialize::<u32>()
        .unwrap();
        if unknown_identity {
            // Remove only this child fixture's process-query executable lookup.
            std::env::set_var("PATH", root.join("no-process-tools"));
            assert!(std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-Command", "exit 0"])
                .status()
                .is_err());
        }
        let error = invoke(
            "install_app_update",
            serde_json::json!({"rid":bytes,"force":force}),
        )
        .unwrap_err();
        if force {
            assert!(
                !error.to_string().contains("cli_operation_blocked"),
                "{error}"
            );
        } else {
            assert!(
                error.to_string().contains("cli_operation_blocked"),
                "{error}"
            );
        }
    }
    stop.store(true, Ordering::Release);
    assert_eq!(cleaned.load(Ordering::SeqCst), usize::from(force));
    println!("native-installer-refused");
}
