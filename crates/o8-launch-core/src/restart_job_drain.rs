//! Release cloud leases only after native restart admission has committed.
use std::path::{Path, PathBuf};
use std::time::Duration;

fn finalize(data_dir: &Path, api_port: u16) -> Result<(), String> {
    let token = std::fs::read_to_string(data_dir.join("ws-token"))
        .map_err(|_| "Restart credential unavailable".to_string())?;
    if token.trim().is_empty() || api_port == 0 {
        return Err("Restart endpoint unavailable".into());
    }
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| "Restart drain client unavailable".to_string())?;
    let response = client
        .post(format!(
            "http://127.0.0.1:{api_port}/api/panel/cloud-jobs/drain"
        ))
        .bearer_auth(token.trim())
        .json(&serde_json::json!({"finalize": true}))
        .send()
        .map_err(|_| "Restart drain request unavailable".to_string())?;
    if !response.status().is_success() {
        return Err("Restart drain refused".into());
    }
    let payload: serde_json::Value = response
        .json()
        .map_err(|_| "Restart drain receipt unavailable".to_string())?;
    if payload.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("Restart drain was not confirmed".into());
    }
    Ok(())
}

fn inspect(data_dir: &Path, api_port: u16, id: &str, force: bool) -> Result<(), String> {
    let token = std::fs::read_to_string(data_dir.join("ws-token"))
        .map_err(|_| "Restart credential unavailable")?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(format!(
            "http://127.0.0.1:{api_port}/api/panel/app/update-state"
        ))
        .bearer_auth(token.trim())
        .json(&serde_json::json!({"autoApply": {
            "action": "inspect-restart", "reservationId": id, "force": force }}))
        .send()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err("Final restart work inspection unavailable".into());
    }
    let result: serde_json::Value = response.json().map_err(|e| e.to_string())?;
    if result["allowed"].as_bool() != Some(true) {
        return Err(format!(
            "Restart deferred by final work inspection: {}",
            result["idle"]
        ));
    }
    Ok(())
}

pub fn guard(
    data_dir: PathBuf,
    api_port: u16,
    cleanup: impl Fn() + Send + Sync + 'static,
) -> o8_restart_safety::RestartSafety {
    let inspecting = data_dir.clone();
    o8_restart_safety::RestartSafety::new(data_dir.clone(), move || {
        let directory = data_dir.clone();
        // MCP's native entry runs on Tokio; build/drop the blocking client on
        // its own thread. The committed admission remains held across the join.
        let drained = std::thread::Builder::new()
            .name("restart-cloud-drain".into())
            .spawn(move || finalize(&directory, api_port))
            .ok()
            .and_then(|task| task.join().ok())
            .is_some_and(|result| result.is_ok());
        if !drained {
            log::warn!(
                "[app-restart] cloud drain unavailable; lease expiry remains the recovery boundary"
            );
        }
        cleanup();
    })
    .with_work_inspection(move |id, force| {
        let directory = inspecting.clone();
        let id = id.to_string();
        std::thread::spawn(move || inspect(&directory, api_port, &id, force))
            .join()
            .map_err(|_| "Final restart work inspection stopped".to_string())?
            .map_err(|error| format!("cli_operation_blocked: {error}. No sessions were stopped."))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("o8-restart-drain-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("ws-token"), "restart-fixture-credential").unwrap();
        root
    }

    #[test]
    fn admitted_restart_drains_its_captured_server_before_cleanup() {
        let root = root();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let received = Arc::new(AtomicUsize::new(0));
        let observed = received.clone();
        let server = std::thread::spawn(move || {
            let (mut inspection, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            inspection
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let count = inspection.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..count])
                .starts_with("POST /api/panel/app/update-state"));
            inspection.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{\"allowed\":true}").unwrap();
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = String::new();
            let mut buffer = [0; 1024];
            while !request.ends_with("{\"finalize\":true}") {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.push_str(std::str::from_utf8(&buffer[..count]).unwrap());
            }
            assert!(request.starts_with("POST /api/panel/cloud-jobs/drain HTTP/1.1"));
            assert!(request
                .to_lowercase()
                .contains("authorization: bearer restart-fixture-credential"));
            observed.store(1, Ordering::SeqCst);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").unwrap();
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let recorded = calls.clone();
        let state = guard(root.clone(), port, move || {
            assert_eq!(received.load(Ordering::SeqCst), 1);
            recorded.fetch_add(1, Ordering::SeqCst);
        });
        let id = state.prepare().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        state.before_restart(Some(&id)).unwrap();
        server.join().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn held_restart_never_drains_or_cleans_up() {
        let root = root();
        std::fs::write(root.join("codex-cli-update.lock"), "held owner").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let recorded = calls.clone();
        let state = guard(
            root.clone(),
            listener.local_addr().unwrap().port(),
            move || {
                recorded.fetch_add(1, Ordering::SeqCst);
            },
        );
        assert!(state.before_restart(None).is_err());
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            std::fs::read_to_string(root.join("codex-cli-update.lock")).unwrap(),
            "held owner"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
