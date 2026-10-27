//! A real stalled artifact body must release the scheduler and native task owner.
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

#[test]
fn stalled_artifact_unwinds_ownership_and_scheduler_serves_a_freshness_request() {
    let _serial = super::scheduler_tests::SCHEDULER_ENV.lock().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let base = format!("http://127.0.0.1:{port}");
    let state = Arc::new(Mutex::new(
        serde_json::json!({"checkedAt":null, "requested":null, "reports":0,
        "admitted":false, "artifact":false, "failed":false}),
    ));
    let shared = state.clone();
    let origin = base.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let done = stop.clone();
    std::thread::spawn(move || {
        while !done.load(Ordering::Acquire) {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
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
            let path = headers
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            let mut data = shared.lock().unwrap();
            let reply = if path == "/artifact" {
            data["artifact"] = true.into(); data["requested"] = "fresh-after-stall".into();
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 999\r\nConnection: close\r\n\r\nx").unwrap();
            let end = done.clone();
            std::thread::spawn(move || { while !end.load(Ordering::Acquire) { std::thread::sleep(Duration::from_millis(10)); } drop(stream); });
            continue;
        } else if path.starts_with("/v1/") || path == "/latest.json" {
            serde_json::json!({"channel": "stable", "version":"0.2.0", "url": format!("{origin}/artifact"), "signature":"fixture"})
        } else if path.starts_with("/api/panel/release-health") {
            serde_json::json!({"pulled":false})
        } else if headers.starts_with("get ") {
            serde_json::json!({"state":{"check":{"checkedAt":data["checkedAt"]}}, "checkRequestedAt":data["requested"]})
        } else {
            let body: serde_json::Value = serde_json::from_slice(&request[split..split + length]).unwrap();
            if body.get("autoApply").is_some() {
                let action = &body["autoApply"]["action"];
                let allowed = action == "admit" && data["admitted"] == false;
                if allowed { data["admitted"] = true.into(); }
                if action == "failed" { data["failed"] = true.into(); }
                serde_json::json!({"allowed":allowed, "channel": "stable", "version":"0.2.0", "attemptId":body["autoApply"]["attemptId"]})
            } else {
                data["checkedAt"] = body["checkedAt"].clone();
                data["reports"] = (data["reports"].as_u64().unwrap() + 1).into();
                serde_json::json!({"ok":true})
            }
        }.to_string();
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
        }
    });
    let directory = tempfile::tempdir().unwrap();
    let app = super::app(&base, &base, &directory.path().join("identity.json"));
    app.manage(o8_restart_safety::RestartSafety::new(
        directory.path().to_path_buf(),
        || panic!("stalled artifact cannot restart"),
    ));
    let previous = std::env::var_os("O8_API_PORT");
    std::env::set_var("O8_API_PORT", port.to_string());
    let task = tauri::async_runtime::spawn(crate::launch_updater::scheduler::run_with_effects(
        app.handle().clone(),
        |app, client, base, token| crate::launch_updater::scheduler::auto_apply::NativeEffects {
            app,
            client,
            base,
            token,
        },
        Duration::ZERO,
    ));
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        let data = state.lock().unwrap();
        if data["failed"] == true && data["reports"].as_u64().unwrap() >= 2 {
            break;
        }
        drop(data);
        std::thread::sleep(Duration::from_millis(10));
    }
    // Inspect before aborting: abort itself must not be what releases ownership.
    let data = state.lock().unwrap().clone();
    let receipts: Vec<serde_json::Value> =
        std::fs::read_dir(directory.path().join("native-update-tasks"))
            .unwrap()
            .map(|entry| {
                serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap()
            })
            .collect();
    task.abort();
    let _ = tauri::async_runtime::block_on(task);
    stop.store(true, Ordering::Release);
    match previous {
        Some(value) => std::env::set_var("O8_API_PORT", value),
        None => std::env::remove_var("O8_API_PORT"),
    };
    assert_eq!(data["artifact"], true);
    assert_eq!(
        data["failed"], true,
        "artifact timeout must finish the attempt"
    );
    assert!(
        data["reports"].as_u64().unwrap() >= 2,
        "scheduler must serve freshness after the timeout"
    );
    assert!(
        receipts
            .iter()
            .any(|receipt| receipt["status"] == "stopped"),
        "download timeout must drop ownership"
    );
}
