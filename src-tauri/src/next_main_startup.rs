//! The shell observes the server-owned GPUI launch through its existing API.
//! No credentials or raw server responses belong in the native error dialog.
use std::path::Path;

pub(crate) fn request_window(port: u16, token: &str) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "Could not create the GPUI launch client.".to_string())?;
    let response = client
        .post(format!(
            "http://127.0.0.1:{port}/api/panel/operator-defaults"
        ))
        .bearer_auth(token)
        .json(&serde_json::json!({ "experimentalNext": true }))
        .send()
        .map_err(|_| "The local server did not answer the GPUI launch request.".to_string())?;
    let status = response.status();
    let body: serde_json::Value = response
        .json()
        .map_err(|_| "The local server returned an invalid GPUI launch receipt.".to_string())?;
    if !status.is_success() {
        return Err(match body["code"].as_str() {
            Some("NEXT_STARTUP_TIMEOUT") => "o8 next (GPUI) did not become ready within 15 seconds.",
            Some("NEXT_STARTUP_FAILED") => "o8 next (GPUI) crashed or exited before its first window was ready.",
            _ => "o8 next (GPUI) could not start. The binary may be missing or unavailable to the server.",
        }.to_string());
    }
    if !body["nextWindowError"].is_null() {
        return Err("The local server reported an o8 next (GPUI) startup failure.".into());
    }
    Ok(())
}

pub(crate) fn report_failure(
    binary: &Path,
    log_path: &Path,
    reason: &str,
    present: impl FnOnce(String),
) {
    use std::io::Write;
    let details = format!("{reason}\nGPUI binary: {}", binary.display());
    let saved = log_path
        .parent()
        .and_then(|parent| {
            std::fs::create_dir_all(parent).ok()?;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_path)
                .ok()?;
            writeln!(file, "{:?}: {details}", std::time::SystemTime::now()).ok()
        })
        .is_some();
    log::error!("[next-main] {details}");
    let log_hint = if saved {
        format!("Startup log: {}", log_path.display())
    } else {
        format!(
            "Could not write the startup log at {}. Details are also in the shell's o8.log.",
            log_path.display()
        )
    };
    present(format!("{details}\n\n{log_hint}\n\nReinstall o8 or check the GPUI binary, then use Show o8 to retry. Voice and the menu bar remain available."));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::process::Command;

    // Drives the shell's actual HTTP launch request and reporting path. The
    // existing o8-next-app-real-path suite verifies these server receipts with
    // the real route and missing, crashing and unresponsive GPUI executables.
    fn failed_launch(binary: &Path, expected_code: &str) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let binary = binary.to_path_buf();
        let fixture_binary = binary.clone();
        let code = expected_code.to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            loop {
                let n = stream.read(&mut buffer).unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buffer[..n]);
                if request.windows(4).any(|w| w == b"\r\n\r\n") && request.ends_with(b"}") {
                    break;
                }
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("POST /api/panel/operator-defaults "));
            assert!(request
                .to_lowercase()
                .contains("authorization: bearer fixture-token"));
            assert!(request.contains("\"experimentalNext\":true"));
            assert!(!Command::new(&fixture_binary)
                .status()
                .is_ok_and(|s| s.success()));
            let body =
                serde_json::json!({"code": code, "error": "private fixture-token diagnostic"})
                    .to_string();
            write!(stream, "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let error = request_window(port, "fixture-token").unwrap_err();
        server.join().unwrap();
        let log_path = binary.parent().unwrap().join("logs/gpui-startup.log");
        let mut shown = false;
        report_failure(&binary, &log_path, &error, |message| {
            shown = true;
            assert!(message.contains("GPUI"));
            assert!(message.contains(log_path.to_str().unwrap()));
            assert!(std::fs::read_to_string(&log_path).unwrap().contains(&error));
            assert!(!message.contains("fixture-token"));
        });
        assert!(shown, "a failed launch must reach the native presenter");
    }

    #[test]
    fn missing_gpui_binary_reaches_native_error_with_a_written_log() {
        let root = std::env::temp_dir().join(format!("o8-gpui-missing-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        failed_launch(&root.join("missing-o8-next"), "UNAVAILABLE");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn crashing_gpui_binary_reaches_native_error_with_a_written_log() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("o8-gpui-crash-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let binary = root.join("o8-next");
        std::fs::write(&binary, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        failed_launch(&binary, "NEXT_STARTUP_FAILED");
        std::fs::remove_dir_all(root).unwrap();
    }
}
