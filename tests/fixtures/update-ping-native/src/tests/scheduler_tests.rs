//! Exercise the production scheduler, signed updater transport and state handoff without a window.
use super::{app, server};
use crate::launch_updater::scheduler::auto_apply::{commit_restart, Effects};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

pub(super) static SCHEDULER_ENV: Mutex<()> = Mutex::new(());

struct FixtureEffects {
    app: tauri::AppHandle<tauri::test::MockRuntime>,
    installs: Arc<AtomicUsize>,
}
impl Effects for FixtureEffects {
    async fn install(&self, version: &str, _attempt_id: &str) -> Result<bool, String> {
        let update = crate::update_ping::check(&self.app).await?.unwrap();
        assert_eq!(update.version, version);
        // The signed artifact installation is the only effect replaced by this fixture.
        self.installs.fetch_add(1, Ordering::SeqCst);
        Ok(true)
    }
    fn restart(&self) -> Result<(), String> {
        commit_restart(&self.app)
    }
}

struct Running(
    tauri::async_runtime::JoinHandle<()>,
    Option<std::ffi::OsString>,
    Arc<AtomicBool>,
);
impl Drop for Running {
    fn drop(&mut self) {
        self.0.abort();
        self.2.store(true, Ordering::Release);
        match &self.1 {
            Some(value) => std::env::set_var("O8_API_PORT", value),
            None => std::env::remove_var("O8_API_PORT"),
        }
    }
}

fn wait_for(read: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !read() {
        assert!(
            Instant::now() < deadline,
            "native state handoff did not finish"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn scheduler_checks_and_retries_state_without_a_webview_then_honors_fresh_requests() {
    let _serial = SCHEDULER_ENV.lock().unwrap_or_else(|error| error.into_inner());
    let primary = server("ok");
    let fallback = server("ok");
    let redirect_trap = server("ok");
    let redirect_url = redirect_trap.url.clone();
    let settings = tempfile::tempdir().unwrap();
    let app = app(
        &primary.url,
        &fallback.url,
        &settings.path().join("settings.json"),
    );
    assert!(app.get_webview_window("main").is_none());

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let state = Arc::new(Mutex::new(serde_json::json!({
        "state": { "check": { "checkedAt": null } }, "checkRequestedAt": null,
        "reports": [], "attempts": 0, "gets": 0,
        "autoEnabled": false, "restartChecks": 0
    })));
    let stop = Arc::new(AtomicBool::new(false));
    let done = stop.clone();
    let shared = state.clone();
    thread::spawn(move || {
        while !done.load(Ordering::Acquire) {
            let Ok((mut socket, _)) = listener.accept() else {
                thread::sleep(Duration::from_millis(5));
                continue;
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            let split = loop {
                let count = socket.read(&mut buffer).unwrap();
                if count == 0 {
                    break None;
                }
                request.extend_from_slice(&buffer[..count]);
                if let Some(index) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    break Some(index + 4);
                }
            };
            let Some(split) = split else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..split]).to_lowercase();
            assert!(headers.contains("authorization: bearer scheduler-fixture"));
            assert!(headers.contains("/api/panel/app/update-state"));
            let length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            while request.len() < split + length {
                let count = socket.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
            }
            let mut data = shared.lock().unwrap();
            let body: serde_json::Value = serde_json::from_slice(&request[split..split + length])
                .unwrap_or(serde_json::Value::Null);
            if body.get("autoApply").is_some() {
                let auto = &body["autoApply"];
                let allowed = if auto["action"] == "restart" {
                    data["restartChecks"] = (data["restartChecks"].as_u64().unwrap() + 1).into();
                    // Work starts during download, then finishes. Never download twice.
                    data["restartChecks"].as_u64().unwrap() > 1
                } else {
                    data["autoEnabled"].as_bool().unwrap()
                };
                let reply = serde_json::json!({ "allowed": allowed,
                    "attemptId": auto["attemptId"], "version": "0.2.0" })
                .to_string();
                let _ = write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
                continue;
            }
            let mut location = String::new();
            let status = if headers.starts_with("post ") {
                data["attempts"] = (data["attempts"].as_u64().unwrap() + 1).into();
                if data["attempts"] == 1 {
                    "503 Unavailable"
                } else {
                    let report: serde_json::Value =
                        serde_json::from_slice(&request[split..split + length]).unwrap();
                    data["state"]["check"]["checkedAt"] = report["checkedAt"].clone();
                    data["reports"].as_array_mut().unwrap().push(report);
                    "200 OK"
                }
            } else {
                data["gets"] = (data["gets"].as_u64().unwrap() + 1).into();
                if data["gets"] == 1 {
                    location = format!("Location: {redirect_url}/unexpected\r\n");
                    "302 Found"
                } else {
                    "200 OK"
                }
            };
            let body = data.to_string();
            let _ = write!(socket, "HTTP/1.1 {status}\r\n{location}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        }
    });
    let previous = std::env::var_os("O8_API_PORT");
    std::env::set_var("O8_API_PORT", port.to_string());
    let installs = Arc::new(AtomicUsize::new(0));
    let installed = installs.clone();
    let restarts = Arc::new(AtomicUsize::new(0));
    let restarted = restarts.clone();
    app.manage(o8_restart_safety::RestartSafety::new(
        settings.path().join("admission"),
        move || {
            restarted.fetch_add(1, Ordering::SeqCst);
        },
    ));
    let _running = Running(
        tauri::async_runtime::spawn(crate::launch_updater::scheduler::run_with_effects(
            app.handle().clone(),
            move |app, _, _, _| FixtureEffects {
                app,
                installs: installed.clone(),
            },
            Duration::from_millis(50),
        )),
        previous,
        stop,
    );
    wait_for(|| state.lock().unwrap()["reports"].as_array().unwrap().len() == 1);
    {
        let mut data = state.lock().unwrap();
        assert_eq!(data["attempts"], 2);
        assert_eq!(data["reports"][0]["checkOutcome"], "available");
        assert_eq!(data["reports"][0]["version"], "0.2.0");
        assert_eq!(
            primary.requests.try_iter().count(),
            1,
            "startup delivery retries must reuse the recorded check"
        );
        data["checkRequestedAt"] = chrono::Utc::now().to_rfc3339().into();
    }
    wait_for(|| state.lock().unwrap()["reports"].as_array().unwrap().len() == 2);
    let data = state.lock().unwrap();
    assert_eq!(
        primary.requests.try_iter().count(),
        1,
        "server freshness request must run a second updater check"
    );
    assert_eq!(
        redirect_trap.requests.try_iter().count(),
        0,
        "local operator transport must not follow redirects"
    );
    assert_ne!(
        data["reports"][0]["checkedAt"],
        data["reports"][1]["checkedAt"]
    );
    assert!(app.get_webview_window("main").is_none());
    drop(data);
    state.lock().unwrap()["autoEnabled"] = true.into();
    wait_for(|| restarts.load(Ordering::SeqCst) == 1);
    assert_eq!(
        installs.load(Ordering::SeqCst),
        1,
        "staged update must not download again while waiting"
    );
    assert_eq!(state.lock().unwrap()["restartChecks"], 2);
    assert!(
        app.get_webview_window("main").is_none(),
        "auto-apply cannot require a mounted component"
    );
}

#[test]
fn slow_local_state_transport_does_not_repeat_remote_checks_as_false_wakes() {
    let _serial = SCHEDULER_ENV.lock().unwrap_or_else(|error| error.into_inner());
    let primary = server("ok");
    let fallback = server("ok");
    let settings = tempfile::tempdir().unwrap();
    let app = app(
        &primary.url,
        &fallback.url,
        &settings.path().join("settings.json"),
    );
    assert!(app.get_webview_window("main").is_none());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let stop = Arc::new(AtomicBool::new(false));
    let done = stop.clone();
    thread::spawn(move || {
        while !done.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((socket, _)) => {
                    thread::spawn(move || {
                        thread::sleep(Duration::from_secs(3));
                        drop(socket);
                    });
                }
                Err(_) => thread::sleep(Duration::from_millis(5)),
            }
        }
    });
    let previous = std::env::var_os("O8_API_PORT");
    std::env::set_var("O8_API_PORT", port.to_string());
    let _running = Running(
        tauri::async_runtime::spawn(crate::launch_updater::scheduler::run_with_effects(
            app.handle().clone(),
            |app, _, _, _| FixtureEffects {
                app,
                installs: Arc::new(AtomicUsize::new(0)),
            },
            Duration::ZERO,
        )),
        previous,
        stop,
    );
    thread::sleep(Duration::from_secs(13));
    assert_eq!(
        primary.requests.try_iter().count(),
        1,
        "local timeouts must not trigger remote checks every five seconds"
    );
    assert!(fallback.requests.try_recv().is_err());
}
