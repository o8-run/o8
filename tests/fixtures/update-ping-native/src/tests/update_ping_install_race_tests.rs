//! Real check/download/IPC and automatic admission, with only installer effects
//! stubbed. Pauses are outside the installer so a saved channel must win.
use crate::{
    install_race_edge::Hooks, launch_updater::scheduler::auto_apply::NativeEffects, update_ping,
};
use base64::Engine;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
    Manager, WebviewWindow, WebviewWindowBuilder,
};

struct Service {
    base: String,
    stop: Arc<AtomicBool>,
    artifact_pause: Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>,
}
impl Drop for Service {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}
fn service() -> Service {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let origin = base.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let done = stop.clone();
    let pause: Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>> = Arc::new(Mutex::new(None));
    let paused = pause.clone();
    std::thread::spawn(move || {
        while !done.load(Ordering::SeqCst) {
            let Ok((mut socket, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            let split = loop {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
                if let Some(index) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..split]).to_lowercase();
            let length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(0);
            while request.len() < split + length {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            let path = headers
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            let reply = if path == "/artifact" {
                base64::engine::general_purpose::STANDARD
                    .decode(include_str!("../../artifacts/valid.artifact.b64").trim())
                    .unwrap()
            } else if path.starts_with("/v1/") || path.ends_with(".json") {
                let beta = headers.contains("x-o8-channel: beta") || path.ends_with("beta.json");
                serde_json::json!({"channel":if beta {"beta"} else {"stable"},"version":if beta {"0.3.0"} else {"0.2.0"},
                "url":format!("{origin}/artifact"),"signature":include_str!("../../artifacts/valid.signature.b64").trim()}).to_string().into_bytes()
            } else if path.starts_with("/api/panel/release-health") {
                b"{\"pulled\":false}".to_vec()
            } else {
                b"{\"allowed\":true}".to_vec()
            };
            if write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                reply.len()
            )
            .is_err()
            {
                continue;
            }
            if path == "/artifact" {
                let action = paused.lock().unwrap().take();
                if let Some(action) = action {
                    action();
                }
            }
            let _ = socket.write_all(&reply);
        }
    });
    Service {
        base,
        stop,
        artifact_pause: pause,
    }
}
fn fixture(
    service: &Service,
    directory: &std::path::Path,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    WebviewWindow<tauri::test::MockRuntime>,
) {
    let mut context = mock_context(noop_assets());
    context.package_info_mut().version = "0.1.0".parse().unwrap();
    context.config_mut().plugins.0.insert("updater".into(),serde_json::json!({"endpoints":[format!("{}/v1/update/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}",service.base),format!("{}/latest.json",service.base)],
        "pubkey":include_str!("../../artifacts/public-key.b64").trim(),"dangerousInsecureTransportProtocol":true}));
    let app = mock_builder()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            update_ping::begin_update_check,
            update_ping::read_update_check_ticket,
            update_ping::check_app_update,
            update_ping::read_update_channel,
            update_ping::set_update_channel,
            update_ping::download_app_update,
            update_ping::install_app_update
        ])
        .build(context)
        .unwrap();
    update_ping::initialize_at(app.handle(), &directory.join("settings.json")).unwrap();
    app.manage(o8_restart_safety::RestartSafety::new(
        directory.to_path_buf(),
        || {},
    ));
    app.manage(Hooks::default());
    let view = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    command(
        &view,
        "set_update_channel",
        serde_json::json!({"channel":"beta"}),
    )
    .unwrap();
    (app, view)
}
fn command(
    view: &WebviewWindow<tauri::test::MockRuntime>,
    name: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    get_ipc_response(
        view,
        tauri::webview::InvokeRequest {
            cmd: name.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map(|value| value.deserialize().unwrap())
}
fn downloaded(view: &WebviewWindow<tauri::test::MockRuntime>) -> serde_json::Value {
    let checked = command(view, "check_app_update", serde_json::json!({})).unwrap();
    command(
        view,
        "download_app_update",
        serde_json::json!({"rid":checked["rid"],"onEvent":"__CHANNEL__:9"}),
    )
    .unwrap()
}
fn effects(
    app: &tauri::App<tauri::test::MockRuntime>,
    service: &Service,
) -> NativeEffects<tauri::test::MockRuntime> {
    NativeEffects {
        app: app.handle().clone(),
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
        base: service.base.clone(),
        token: "fixture".into(),
    }
}
fn pause() -> (
    Box<dyn FnOnce() + Send>,
    mpsc::Receiver<()>,
    mpsc::Sender<()>,
) {
    let (ready, entered) = mpsc::channel();
    let (release, resume) = mpsc::channel();
    (
        Box::new(move || {
            ready.send(()).unwrap();
            resume.recv_timeout(Duration::from_secs(5)).unwrap();
        }),
        entered,
        release,
    )
}

#[test]
fn update_ping_channel_change_cancels_pending_install_after_epoch_guard() {
    let mut results = Vec::new();
    for automatic in [false, true] {
        let service = service();
        let directory = tempfile::tempdir().unwrap();
        let (app, view) = fixture(&service, directory.path());
        let (before, entered, resume) = pause();
        *app.state::<Hooks>().before.lock().unwrap() = Some(before);
        let pending = if automatic {
            let native = effects(&app, &service);
            let update = tauri::async_runtime::block_on(update_ping::check(app.handle()))
                .unwrap()
                .unwrap();
            std::thread::spawn(move || {
                tauri::async_runtime::block_on(native.install_candidate(update, "cancelled-beta"))
                    .map(|_| ())
            })
        } else {
            let rid = downloaded(&view);
            let view = view.clone();
            std::thread::spawn(move || {
                command(&view, "install_app_update", serde_json::json!({"rid":rid}))
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
        };
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        let saved = command(
            &view,
            "set_update_channel",
            serde_json::json!({"channel":"stable"}),
        );
        resume.send(()).unwrap();
        let result = pending.join().unwrap();
        results.push((
            automatic,
            saved == Ok(serde_json::json!("stable")),
            result
                .as_ref()
                .err()
                .is_some_and(|error| error.contains("Update channel changed")),
            app.state::<Hooks>().calls.load(Ordering::SeqCst),
            directory
                .path()
                .join("automatic-install-attempts/0.3.0.json")
                .exists(),
            update_ping::read_update_channel(app.handle().clone()),
        ));
    }
    assert_eq!(results,vec![(false,true,true,0,false,"stable".into()),(true,true,true,0,false,"stable".into())],"saving Stable must invalidate both pending installer paths before any platform effect or journal marker");
}

#[test]
fn update_ping_channel_change_invalidates_in_flight_download() {
    let service = service();
    let directory = tempfile::tempdir().unwrap();
    let (app, view) = fixture(&service, directory.path());
    let checked = command(&view, "check_app_update", serde_json::json!({})).unwrap();
    let (before, entered, resume) = pause();
    *service.artifact_pause.lock().unwrap() = Some(before);
    let other = view.clone();
    let transfer = std::thread::spawn(move || {
        command(
            &other,
            "download_app_update",
            serde_json::json!({"rid":checked["rid"],"onEvent":"__CHANNEL__:9"}),
        )
    });
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    command(
        &view,
        "set_update_channel",
        serde_json::json!({"channel":"stable"}),
    )
    .unwrap();
    resume.send(()).unwrap();
    let result = transfer.join().unwrap();
    assert!(
        result
            .as_ref()
            .err()
            .and_then(|error| error.as_str())
            .is_some_and(|error| error.contains("Update channel changed")),
        "changed-channel download must report invalidated enrollment: {result:?}"
    );
    assert!(!view
        .resources_table()
        .names()
        .any(|(_, name)| name.ends_with("DownloadedUpdate")));
    assert_eq!(app.state::<Hooks>().calls.load(Ordering::SeqCst), 0);
}

#[test]
fn update_ping_install_start_serializes_channel_changes_without_blocking_callbacks() {
    for automatic in [false, true] {
        let service = service();
        let directory = tempfile::tempdir().unwrap();
        let (app, view) = fixture(&service, directory.path());
        let (inside, entered, resume) = pause();
        let handle = app.handle().clone();
        let callback_results = Arc::new(Mutex::new(None));
        let observed = callback_results.clone();
        *app.state::<Hooks>().installer.lock().unwrap() = Some(Box::new(move || {
            let before = update_ping::read_update_check_ticket(handle.clone()).unwrap();
            let result = update_ping::set_update_channel(handle.clone(), "stable".into());
            let after = update_ping::read_update_check_ticket(handle.clone()).unwrap();
            *observed.lock().unwrap() =
                Some((result.is_err(), before.generation == after.generation));
            inside();
            Ok(())
        }));
        let pending = if automatic {
            let native = effects(&app, &service);
            let update = tauri::async_runtime::block_on(update_ping::check(app.handle()))
                .unwrap()
                .unwrap();
            std::thread::spawn(move || {
                tauri::async_runtime::block_on(native.install_candidate(update, "active-beta"))
                    .map(|_| ())
            })
        } else {
            let rid = downloaded(&view);
            let view = view.clone();
            std::thread::spawn(move || {
                command(&view, "install_app_update", serde_json::json!({"rid":rid}))
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
        };
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        let changed = command(
            &view,
            "set_update_channel",
            serde_json::json!({"channel":"stable"}),
        );
        let channel = update_ping::read_update_channel(app.handle().clone());
        resume.send(()).unwrap();
        assert!(pending.join().unwrap().is_ok());
        assert_eq!(*callback_results.lock().unwrap(),Some((true,true)),"same-thread setter must refuse without changing epoch; clock callbacks must not deadlock");
        assert!(changed.is_err());
        assert_eq!(channel, "beta");
        assert_eq!(app.state::<Hooks>().calls.load(Ordering::SeqCst), 1);
        command(
            &view,
            "set_update_channel",
            serde_json::json!({"channel":"stable"}),
        )
        .unwrap();
    }
}

#[test]
fn update_ping_installer_refusal_does_not_poison_channel_gate() {
    for automatic in [false, true] {
        let service = service();
        let directory = tempfile::tempdir().unwrap();
        let (app, view) = fixture(&service, directory.path());
        *app.state::<Hooks>().installer.lock().unwrap() = Some(Box::new(|| {
            std::panic::panic_any(update_ping::RestartRefused(
                "fixture restart refused".into(),
            ))
        }));
        if automatic {
            let native = effects(&app, &service);
            let update = tauri::async_runtime::block_on(update_ping::check(app.handle()))
                .unwrap()
                .unwrap();
            assert_eq!(
                tauri::async_runtime::block_on(native.install_candidate(update, "refused-beta")),
                Ok(false)
            );
        } else {
            let rid = downloaded(&view);
            assert!(command(&view, "install_app_update", serde_json::json!({"rid":rid})).is_err());
        }
        assert_eq!(app.state::<Hooks>().calls.load(Ordering::SeqCst), 1);
        command(
            &view,
            "set_update_channel",
            serde_json::json!({"channel":"stable"}),
        )
        .unwrap();
    }
}
