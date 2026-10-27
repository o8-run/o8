// Compile the production command without starting the desktop app or sidecars.
include!(concat!(env!("OUT_DIR"), "/native_modules.rs"));
mod channel_save_edge;
mod install_race_edge;
#[path = "../../../../src-tauri/src/restart_job_drain.rs"]
mod restart_job_drain;

fn resolve_ws_token() -> String {
    "scheduler-fixture".into()
}

#[cfg(test)]
mod tests {
    mod auto_apply_failure_tests;
    mod download_timeout_tests;
    mod install_journal_tests;
    mod production_install_tests;
    mod scheduler_tests;
    #[path = "channel_boundary_tests.rs"]
    mod update_ping_channel_boundary_tests;
    mod update_ping_install_race_tests;
    mod windows_install_tests;
    use super::update_ping;
    use std::{
        collections::BTreeMap,
        io::{Read, Write},
        net::TcpListener,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        },
        thread,
        time::{Duration, Instant},
    };
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::{Manager, WebviewWindowBuilder};

    const MANIFEST: &str = r#"{"channel":"stable","version":"0.2.0","notes":"fixture","pub_date":"2026-09-30T12:00:00Z","url":"https://updates.invalid/v0.2.0/o8.app.tar.gz","signature":"fixture-signature"}"#;

    struct Server {
        url: String,
        requests: mpsc::Receiver<String>,
        stop: Arc<AtomicBool>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
        }
    }
    fn server(mode: &'static str) -> Server {
        server_redirecting_to(mode, "http://127.0.0.1:1/leak")
    }
    fn server_redirecting_to(mode: &'static str, redirect: &str) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, requests) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let redirect = redirect.to_owned();
        thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                let Ok((mut socket, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                // Windows sockets inherit the listener's non-blocking mode.
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.ends_with(b"\r\n\r\n") {
                    let count = socket.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..count]);
                }
                let request = String::from_utf8(request).unwrap();
                let beta = request.to_lowercase().contains("x-o8-channel: beta")
                    || request
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .ends_with("/beta.json");
                let preview = request.to_lowercase().contains("x-o8-channel: preview")
                    || request.starts_with("GET /preview.json ");
                tx.send(request).unwrap();
                let response = match mode {
                    "channels" => {
                        let body = if beta {
                            MANIFEST
                                .replace("\"stable\"", "\"beta\"")
                                .replace("0.2.0", "0.3.0")
                        } else {
                            MANIFEST.to_owned()
                        };
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                            body.len(),
                            body
                        )
                    }
                    "stable-newer" | "wrong-beta-only" | "missing-beta" => {
                        let body = if beta {
                            match mode {
                                "stable-newer" => MANIFEST
                                    .replace("\"stable\"", "\"beta\"")
                                    .replace("0.2.0", "0.3.0"),
                                "wrong-beta-only" => MANIFEST.replace("0.2.0", "0.4.0"),
                                _ => MANIFEST
                                    .replace("\"channel\":\"stable\",", "")
                                    .replace("0.2.0", "0.4.0"),
                            }
                        } else if mode == "stable-newer" {
                            MANIFEST.replace("0.2.0", "0.4.0")
                        } else {
                            MANIFEST.to_owned()
                        };
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                            body.len(),
                            body
                        )
                    }
                    "beta" => {
                        let body =
                            MANIFEST.replace("\"channel\":\"stable\"", "\"channel\":\"beta\"");
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                            body.len(),
                            body
                        )
                    }
                    "failure" => "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n".into(),
                    "redirect" => format!(
                        "HTTP/1.1 302 Found\r\nLocation: {redirect}\r\nContent-Length: 0\r\n\r\n"
                    ),
                    "malformed" => "HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n{".into(),
                    "slow" => {
                        // Stall AFTER headers to prove response parsing is bounded too.
                        socket
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n")
                            .unwrap();
                        thread::sleep(Duration::from_secs(5));
                        continue;
                    }
                    _ => {
                        let body = if preview {
                            MANIFEST.replace("\"stable\"", "\"preview\"")
                        } else {
                            MANIFEST.to_owned()
                        };
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                            body.len(),
                            body
                        )
                    }
                };
                let _ = socket.write_all(response.as_bytes());
            }
        });
        Server {
            url,
            requests,
            stop,
        }
    }

    fn app(
        primary: &str,
        fallback: &str,
        settings: &std::path::Path,
    ) -> tauri::App<tauri::test::MockRuntime> {
        let app = build_app(primary, fallback, "0.1.0");
        update_ping::initialize_at(app.handle(), settings).unwrap();
        app
    }

    fn build_app(
        primary: &str,
        fallback: &str,
        version: &str,
    ) -> tauri::App<tauri::test::MockRuntime> {
        let mut context = mock_context(noop_assets());
        context.package_info_mut().version = version.parse().unwrap();
        context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({
            "endpoints": [format!("{primary}/v1/update/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}"), format!("{fallback}/latest.json")],
            "pubkey": "fixture",
            "dangerousInsecureTransportProtocol": true,
        }));
        let app = mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .invoke_handler(tauri::generate_handler![
                update_ping::begin_update_check,
                update_ping::read_update_check_ticket,
                update_ping::check_app_update,
                update_ping::read_update_channel,
                update_ping::read_update_channel_status,
                update_ping::set_update_channel,
                update_ping::download_app_update,
                update_ping::install_app_update,
                update_ping::discard_app_update_download
            ])
            .build(context)
            .unwrap();
        app
    }

    fn invoke(app: &tauri::App<tauri::test::MockRuntime>) -> serde_json::Value {
        let webview = app.get_webview_window("main").unwrap_or_else(|| {
            WebviewWindowBuilder::new(app, "main", Default::default())
                .build()
                .unwrap()
        });
        let value = get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "check_app_update".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap();
        // This is the actual resource consumed by plugin:updater|download_and_install.
        let update = webview
            .resources_table()
            .get::<update_ping::CheckedUpdate>(value["rid"].as_u64().unwrap() as u32)
            .unwrap();
        assert!(
            update.update.headers.is_empty(),
            "ping ID must never accompany downloads"
        );
        assert_eq!(update.update.signature, "fixture-signature");
        assert_eq!(value["date"], "2026-09-30T12:00:00Z");
        value
    }

    fn headers(request: &str) -> BTreeMap<String, String> {
        request
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(": "))
            .map(|(key, value)| (key.to_lowercase(), value.to_owned()))
            .collect()
    }

    #[test]
    fn ipc_sends_exact_fields_and_reuses_device_identity_after_restart() {
        let service = server("ok");
        let fallback = server("ok");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-ping.json");
        let first = app(&service.url, &fallback.url, &path);
        assert_eq!(invoke(&first)["version"], "0.2.0");
        let request = service
            .requests
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
        let os = match std::env::consts::OS {
            "macos" => "darwin",
            other => other,
        };
        assert_eq!(
            request.lines().next().unwrap(),
            format!(
                "GET /v1/update/{os}/{}/0.1.0 HTTP/1.1",
                std::env::consts::ARCH
            )
        );
        let mut fields = headers(&request);
        let id = fields.remove("x-o8-install-id").unwrap();
        assert_eq!(uuid::Uuid::parse_str(&id).unwrap().get_version_num(), 4);
        assert_eq!(fields.remove("x-o8-channel").unwrap(), "stable");
        #[cfg(target_os = "macos")]
        assert_eq!(
            fields.remove("x-o8-macos-version").unwrap(),
            String::from_utf8(
                std::process::Command::new("/usr/bin/sw_vers")
                    .arg("-productVersion")
                    .output()
                    .unwrap()
                    .stdout
            )
            .unwrap()
            .trim()
        );
        assert_eq!(
            fields.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["accept", "host", "user-agent"]
        );
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved, serde_json::json!({ "installId": id }));
        drop(first);
        let restarted = app(&service.url, &fallback.url, &path);
        invoke(&restarted);
        let next = service
            .requests
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
        assert_eq!(headers(&next)["x-o8-install-id"], id);
        assert!(fallback.requests.try_recv().is_err());
    }

    #[test]
    fn ipc_falls_back_on_unreachable_service() {
        let reserved = TcpListener::bind("127.0.0.1:0").unwrap();
        let unreachable = format!("http://{}", reserved.local_addr().unwrap());
        drop(reserved);
        let fallback = server("ok");
        let dir = tempfile::tempdir().unwrap();
        let app = app(
            &unreachable,
            &fallback.url,
            &dir.path().join("update-ping.json"),
        );
        assert_eq!(invoke(&app)["version"], "0.2.0");
        let request = fallback
            .requests
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
        assert_eq!(request.lines().next().unwrap(), "GET /latest.json HTTP/1.1");
        assert_eq!(
            headers(&request)
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["accept", "host", "user-agent"]
        );
    }

    #[test]
    fn ipc_falls_back_on_errors_redirects_and_stalled_response_body() {
        for mode in ["failure", "malformed", "slow"] {
            let service = server(mode);
            let fallback = server("ok");
            let dir = tempfile::tempdir().unwrap();
            let app = app(
                &service.url,
                &fallback.url,
                &dir.path().join("update-ping.json"),
            );
            let started = Instant::now();
            assert_eq!(invoke(&app)["version"], "0.2.0", "{mode}");
            assert!(
                started.elapsed() < Duration::from_millis(3500),
                "{mode} exceeded timeout"
            );
            let request = fallback
                .requests
                .recv_timeout(Duration::from_secs(3))
                .unwrap();
            assert!(!headers(&request).keys().any(|key| key.starts_with("x-o8-")));
        }
    }

    #[test]
    fn ipc_never_forwards_identity_to_redirect_destination() {
        let destination = server("ok");
        let service = server_redirecting_to("redirect", &destination.url);
        let fallback = server("ok");
        let dir = tempfile::tempdir().unwrap();
        let app = app(
            &service.url,
            &fallback.url,
            &dir.path().join("update-ping.json"),
        );
        assert_eq!(invoke(&app)["version"], "0.2.0");
        assert!(fallback
            .requests
            .recv_timeout(Duration::from_secs(3))
            .is_ok());
        assert!(destination
            .requests
            .recv_timeout(Duration::from_millis(100))
            .is_err());
    }

    #[test]
    fn ipc_reports_preview_channel_from_running_app_version() {
        let service = server("ok");
        let fallback = server("ok");
        let dir = tempfile::tempdir().unwrap();
        let app = build_app(&service.url, &fallback.url, "0.1.0-preview.1");
        update_ping::initialize_at(app.handle(), &dir.path().join("update-ping.json")).unwrap();
        invoke(&app);
        let request = service
            .requests
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
        assert!(request
            .lines()
            .next()
            .unwrap()
            .ends_with("/0.1.0-preview.1 HTTP/1.1"));
        assert_eq!(headers(&request)["x-o8-channel"], "preview");
    }

    #[test]
    fn ipc_keeps_updates_working_when_identity_settings_are_invalid() {
        let service = server("ok");
        let fallback = server("ok");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-ping.json");
        std::fs::write(&path, r#"{"installId":"not-a-device-uuid"}"#).unwrap();
        let app = build_app(&service.url, &fallback.url, "0.1.0");
        assert!(update_ping::initialize_at(app.handle(), &path).is_err());
        invoke(&app);
        assert!(fallback
            .requests
            .recv_timeout(Duration::from_secs(3))
            .is_ok());
        assert!(service.requests.try_recv().is_err());
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            r#"{"installId":"not-a-device-uuid"}"#
        );
    }
}
