mod support;
use std::{
    fs,
    net::{TcpListener, TcpStream},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};
use support::*;
#[test]
fn cold_start_waits_for_health_and_shutdown_frees_both_ports() {
    let mut f = Fixture::new();
    fs::write(f.root.join("health-delay"), "0.25").unwrap();
    f.start();
    until(|| f.root.join("api-starts").exists());
    assert!(!f.root.join("window-ready").exists());
    f.ready();
    let api = f.port("api-port");
    let ws = f.port("ws-port");
    let window: i32 = fs::read_to_string(f.root.join("window-ready"))
        .unwrap()
        .parse()
        .unwrap();
    let args: serde_json::Value =
        serde_json::from_slice(&fs::read(f.root.join("window-args")).unwrap()).unwrap();
    assert_eq!(
        args,
        serde_json::json!([
            "--enable-next",
            "--app-shell",
            "--server",
            format!("http://127.0.0.1:{api}"),
            "--shell-state",
            f.root.join("next-shell.json")
        ])
    );
    f.stop();
    assert!(TcpListener::bind(("127.0.0.1", api)).is_ok());
    assert!(TcpListener::bind(("127.0.0.1", ws)).is_ok());
    assert!(!f.root.join("launcher-api.json").exists());
    assert_eq!(unsafe { libc::kill(window, 0) }, -1);
}
#[test]
fn second_instance_reuses_servers_and_requests_show() {
    let mut f = Fixture::new();
    f.start();
    f.ready();
    let window = fs::read_to_string(f.root.join("window-ready")).unwrap();
    assert!(f.launch().wait().unwrap().success());
    until(|| f.root.join("focus-shows").exists());
    assert_eq!(
        fs::read_to_string(f.root.join("window-ready")).unwrap(),
        window
    );
    assert_eq!(f.starts("api-starts").len(), 1);
    assert_eq!(f.starts("ws-starts").len(), 1);
}
#[test]
fn child_crash_restarts_and_shutdown_during_delay_does_not_respawn() {
    let mut f = Fixture::new();
    f.start();
    f.ready();
    let old = f.starts("ws-starts")[0];
    unsafe {
        libc::kill(old as i32, libc::SIGKILL);
    }
    until(|| f.starts("ws-starts").len() == 2);
    let latest = f.starts("ws-starts")[1];
    unsafe {
        libc::kill(latest as i32, libc::SIGKILL);
    }
    f.stop();
    assert_eq!(f.starts("ws-starts").len(), 2);
}
#[test]
fn start_failure_reaches_injected_dialog_and_cleans_children() {
    let mut f = Fixture::new();
    fs::write(f.root.join("fail-window"), "1").unwrap();
    f.start();
    until(|| f.root.join("dialog-reached").exists());
    assert!(
        f.launcher.as_mut().unwrap().try_wait().unwrap().is_none(),
        "GPUI failure must retain the background host for retry, as the shell does"
    );
    f.stop();
    let message = fs::read_to_string(f.root.join("dialog-reached")).unwrap();
    assert!(message.contains("GPUI"));
    assert!(!message.contains("fixture-token"));
    assert!(TcpListener::bind(("127.0.0.1", f.port("api-port"))).is_ok());
}
#[test]
fn crashed_parent_orphans_are_cleaned_without_touching_foreign_listener() {
    let foreign = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut f = Fixture::new();
    fs::write(f.root.join("minimal-path"), "1").unwrap();
    f.start();
    f.ready();
    let port = f.port("api-port");
    let child = f.launcher.as_mut().unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    f.launcher = None;
    fs::remove_file(f.root.join("window-ready")).unwrap();
    f.start();
    f.ready();
    assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
    assert!(TcpStream::connect(foreign.local_addr().unwrap()).is_ok());
}

#[test]
fn admitted_restart_inspects_and_drains_before_stopping_servers() {
    let mut f = Fixture::new();
    f.start();
    f.ready();
    let receipt = control(&f, serde_json::json!({"op":"prepare-restart"}));
    assert_eq!(receipt["ok"], true);
    let result = control(
        &f,
        serde_json::json!({"op":"restart","reservation":receipt["reservation"]}),
    );
    assert_eq!(result["admitted"], true);
    let child = f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    assert!(child.wait().unwrap().success());
    f.launcher = None;
    let events = fs::read_to_string(f.root.join("events")).unwrap();
    assert!(events.find("inspect").unwrap() < events.find("drain").unwrap());
    assert!(events.find("drain").unwrap() < events.find("api-stop").unwrap());
    assert!(events.find("api-stop").unwrap() < events.find("ws-stop").unwrap());
    for port in [f.port("api-port"), f.port("ws-port")] {
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
    }
}
#[test]
fn held_or_cancelled_restart_never_drains_or_stops_children() {
    let mut f = Fixture::new();
    f.start();
    f.ready();
    let pids = f.starts("api-starts");
    fs::write(f.root.join("codex-cli-update.lock"), "held owner").unwrap();
    assert_eq!(
        control(&f, serde_json::json!({"op":"prepare-restart"}))["ok"],
        false
    );
    fs::remove_file(f.root.join("codex-cli-update.lock")).unwrap();
    let receipt = control(&f, serde_json::json!({"op":"prepare-restart"}));
    assert_eq!(receipt["ok"], true);
    assert_eq!(
        control(
            &f,
            serde_json::json!({"op":"cancel-restart","reservation":receipt["reservation"]})
        )["ok"],
        true
    );
    assert_eq!(
        control(
            &f,
            serde_json::json!({"op":"restart","reservation":receipt["reservation"]})
        )["ok"],
        false
    );
    assert!(!f.root.join("events").exists());
    assert_eq!(f.starts("api-starts"), pids);
    assert!(f.launcher.as_mut().unwrap().try_wait().unwrap().is_none());
}
#[test]
fn actual_children_receive_the_shared_shell_environment() {
    let mut f = Fixture::new();
    fs::write(f.root.join("operator-mcp-server.mjs"), "fixture").unwrap();
    fs::write(f.root.join("memory-helper"), "fixture").unwrap();
    f.start();
    f.ready();
    for name in ["api-env", "ws-env"] {
        let env: serde_json::Value =
            serde_json::from_slice(&fs::read(f.root.join(name)).unwrap()).unwrap();
        for key in ["O8_DATA_DIR", "CORTEX_IDE_DATA_DIR"] {
            assert_eq!(env[key], f.root.to_string_lossy().as_ref());
        }
        assert_eq!(
            env["O8_NODE_BIN"],
            f.root.join("node").to_string_lossy().as_ref()
        );
        assert_eq!(
            env["NODE_COMPILE_CACHE"],
            f.root.join("compile-cache").to_string_lossy().as_ref()
        );
        assert_eq!(env["O8_BUNDLED_MCP_DIR"], f.root.to_string_lossy().as_ref());
        assert_eq!(
            env["O8_BUNDLED_MCP_PATH"],
            f.root
                .join("operator-mcp-server.mjs")
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(
            env["O8_BOOT_ID"],
            fs::read_to_string(f.root.join("boot-id")).unwrap()
        );
        assert_eq!(
            env["O8_INSTANCE_ID"],
            fs::read_to_string(f.root.join("instance-id")).unwrap()
        );
        assert_eq!(
            env["O8_SIDECAR_PID"],
            f.launcher.as_ref().unwrap().id().to_string()
        );
        assert_eq!(env["O8_PACKAGED_APP"], "1");
        assert_eq!(env["O8_NEXT_MAIN_WINDOW"], "1");
        assert_eq!(env["GEMINI_API_KEY"], "fixture-key");
        assert_eq!(env["WS_PORT"], f.port("ws-port").to_string());
        assert_eq!(env["O8_API_PORT"], f.port("api-port").to_string());
        assert_eq!(env["O8_WS_PORT"], f.port("ws-port").to_string());
        assert_eq!(env["CORTEX_IDE_API_PORT"], f.port("api-port").to_string());
        assert_eq!(env["CORTEX_IDE_WS_PORT"], f.port("ws-port").to_string());
        assert_eq!(
            env["O8_CODEBASE_MEMORY_BIN"],
            f.root.join("memory-helper").to_string_lossy().as_ref()
        );
        if name == "api-env" {
            assert_eq!(env["PORT"], f.port("api-port").to_string());
            assert_eq!(env["HOSTNAME"], "127.0.0.1");
            assert_eq!(env["NODE_ENV"], "production");
            assert_eq!(
                env["O8_NEXT_BIN"],
                f.root.join("window").to_string_lossy().as_ref()
            );
            assert!(env["NEXT_ORIGIN"].is_null());
        } else {
            assert_eq!(
                env["NEXT_ORIGIN"],
                format!("http://127.0.0.1:{}", f.port("api-port"))
            );
            assert_eq!(env["O8_APP_VERSION"], "fixture");
            assert!(env["O8_NEXT_BIN"].is_null());
        }
    }
    for name in [
        "ws-token",
        "launcher-api.json",
        "launcher-ws.json",
        "launcher.lock",
        "launcher.sock",
    ] {
        assert_eq!(
            fs::metadata(f.root.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
#[test]
fn mismatched_birth_identity_removes_receipt_and_starts_without_signalling() {
    let mut f = Fixture::new();
    f.start();
    f.ready();
    let port = f.port("api-port");
    let child = f.launcher.as_mut().unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    f.launcher = None;
    let path = f.root.join("launcher-api.json");
    let mut receipt: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    receipt["identity"] = "different-birth-cookie".into();
    let bytes = receipt.to_string();
    fs::write(&path, &bytes).unwrap();
    f.start();
    until(|| f.starts("api-starts").len() == 2);
    assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
    let next = fs::read_to_string(path).unwrap();
    assert_ne!(next, bytes);
}
#[test]
fn unproven_moved_install_removes_receipt_without_signalling() {
    let mut f = Fixture::new();
    f.start();
    f.ready();
    let port = f.port("api-port");
    let child = f.launcher.as_mut().unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    f.launcher = None;
    let path = f.root.join("launcher-api.json");
    let mut receipt: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    receipt["install"] = f
        .root
        .join("another-install")
        .to_string_lossy()
        .to_string()
        .into();
    // A token the held file does not carry proves nothing after a move.
    receipt["hold"]["token"] = "forged-token".into();
    fs::write(&path, receipt.to_string()).unwrap();
    f.start();
    until(|| f.starts("api-starts").len() == 2);
    assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
    assert_ne!(fs::read_to_string(path).unwrap(), receipt.to_string());
}
#[test]
fn receipt_symlink_is_refused_without_truncating_its_target() {
    let mut f = Fixture::new();
    fs::write(f.root.join("receipt-trap"), "1").unwrap();
    fs::write(f.root.join("trap-target"), "keep this file").unwrap();
    f.start();
    until(|| f.root.join("dialog-reached").exists());
    let child = f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    f.launcher = None;
    assert_eq!(
        fs::read_to_string(f.root.join("trap-target")).unwrap(),
        "keep this file"
    );
    assert!(TcpListener::bind(("127.0.0.1", f.port("api-port"))).is_ok());
}
#[test]
fn foreign_live_instance_socket_is_not_unlinked() {
    let mut f = Fixture::new();
    let path = f.root.join("launcher.sock");
    let foreign = std::os::unix::net::UnixListener::bind(&path).unwrap();
    f.start();
    until(|| f.root.join("dialog-reached").exists());
    let child = f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    f.launcher = None;
    assert!(path.exists());
    assert!(std::os::unix::net::UnixStream::connect(&path).is_ok());
    drop(foreign);
}
#[test]
fn api_crash_rewaits_for_health_and_restarts_the_window() {
    let mut f = Fixture::new();
    f.start();
    f.ready();
    let old_window = fs::read_to_string(f.root.join("window-ready")).unwrap();
    unsafe {
        libc::kill(f.starts("api-starts")[0] as i32, libc::SIGKILL);
    }
    until(|| f.starts("api-starts").len() == 2);
    until(|| fs::read_to_string(f.root.join("window-ready")).unwrap() != old_window);
    assert_eq!(f.starts("ws-starts").len(), 1);
}
#[test]
fn health_receipt_must_match_this_boot_before_requesting_a_window() {
    let mut f = Fixture::new();
    fs::write(f.root.join("wrong-boot"), "1").unwrap();
    f.start();
    until(|| f.root.join("api-env").exists());
    std::thread::sleep(Duration::from_millis(300));
    assert!(!f.root.join("window-ready").exists());
    fs::remove_file(f.root.join("wrong-boot")).unwrap();
    f.ready();
}
#[test]
fn malformed_or_oversized_control_input_does_not_stop_or_duplicate_servers() {
    use std::io::{Read, Write};
    let mut f = Fixture::new();
    f.start();
    f.ready();
    let stalled = std::os::unix::net::UnixStream::connect(f.root.join("launcher.sock")).unwrap();
    let mut oversized = br#"{"op":"show"}"#.to_vec();
    oversized.resize(4097, b' ');
    for bytes in [
        b"invalid".to_vec(),
        oversized,
        br#"{"op":"show","unexpected":true}"#.to_vec(),
    ] {
        let mut stream =
            std::os::unix::net::UnixStream::connect(f.root.join("launcher.sock")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream.write_all(&bytes).unwrap();
        stream.shutdown(std::net::Shutdown::Write).unwrap();
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
    }
    assert!(!f.root.join("focus-shows").exists());
    drop(stalled);
    assert_eq!(control(&f, serde_json::json!({"op":"show"}))["ok"], true);
    until(|| f.root.join("focus-shows").exists());
    assert_eq!(f.starts("api-starts").len(), 1);
}
#[test]
fn a_stubborn_grandchild_cannot_hold_a_port_after_shutdown() {
    let mut f = Fixture::new();
    fs::write(f.root.join("stubborn-child"), "1").unwrap();
    f.start();
    f.ready();
    until(|| f.root.join("held-pid").exists());
    let pid: i32 = fs::read_to_string(f.root.join("held-pid"))
        .unwrap()
        .parse()
        .unwrap();
    let ws = f.port("ws-port");
    f.stop();
    assert!(TcpListener::bind(("127.0.0.1", ws)).is_ok());
    until(|| unsafe { libc::kill(pid, 0) } != 0);
}
#[test]
fn repeated_crashes_exhaust_the_shells_three_restart_budget() {
    let mut f = Fixture::new();
    fs::write(f.root.join("crash-ws"), "1").unwrap();
    f.start();
    until(|| f.root.join("dialog-reached").exists());
    let child = f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    assert!(!child.wait().unwrap().success());
    f.launcher = None;
    assert_eq!(f.starts("ws-starts").len(), 4);
    assert!(fs::read_to_string(f.root.join("dialog-reached"))
        .unwrap()
        .contains("restart budget"));
    for port in [f.port("api-port"), f.port("ws-port")] {
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
    }
}
#[test]
fn an_actively_parented_process_is_never_reaped_as_an_orphan() {
    use std::os::unix::process::CommandExt;
    let mut f = Fixture::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let mut foreign = Command::new(f.root.join("node"))
        .arg(f.root.join("server.js"))
        .current_dir(&f.root)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("HOME", &f.root)
        .env("PORT", port.to_string())
        .env("O8_BOOT_ID", "fixture")
        .process_group(0)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    until(|| TcpStream::connect(("127.0.0.1", port)).is_ok());
    let receipt = o8_launcher::ownership::Receipt {
        pid: foreign.id(),
        identity: o8_launcher::ownership::identity(foreign.id()).unwrap(),
        directory: f.root.clone(),
        install: PathBuf::from(env!("CARGO_BIN_EXE_o8-launcher")),
        port,
        parent: std::process::id(),
        hold: None,
    };
    o8_launcher::ownership::private_write(
        &f.root.join("launcher-api.json"),
        &serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    f.start();
    until(|| f.root.join("dialog-reached").exists());
    let child = f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    f.launcher = None;
    assert!(foreign.try_wait().unwrap().is_none());
    assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
    foreign.kill().unwrap();
    foreign.wait().unwrap();
}
#[test]
fn receipt_hardlink_is_refused_before_truncation() {
    let mut f = Fixture::new();
    for name in ["receipt-trap", "hardlink-trap"] {
        fs::write(f.root.join(name), "1").unwrap();
    }
    fs::write(f.root.join("trap-target"), "keep this file").unwrap();
    f.start();
    until(|| f.root.join("dialog-reached").exists());
    let child = f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    f.launcher = None;
    assert_eq!(
        fs::read_to_string(f.root.join("trap-target")).unwrap(),
        "keep this file"
    );
}
#[test]
fn old_server_logs_rotate_once_per_boot() {
    let mut f = Fixture::new();
    fs::create_dir_all(f.root.join("logs")).unwrap();
    for name in ["next-server.log", "ws-server.log"] {
        fs::write(f.root.join("logs").join(name), "previous boot").unwrap();
    }
    f.start();
    f.ready();
    for name in ["next-server.log.prev", "ws-server.log.prev"] {
        assert_eq!(
            fs::read_to_string(f.root.join("logs").join(name)).unwrap(),
            "previous boot"
        );
    }
}
#[test]
fn saved_instance_identity_is_trimmed_and_preserved() {
    let mut f = Fixture::new();
    fs::write(f.root.join("instance-id"), " saved-instance\n").unwrap();
    f.start();
    f.ready();
    let env: serde_json::Value =
        serde_json::from_slice(&fs::read(f.root.join("api-env")).unwrap()).unwrap();
    assert_eq!(env["O8_INSTANCE_ID"], "saved-instance");
    assert_eq!(
        fs::read_to_string(f.root.join("instance-id")).unwrap(),
        " saved-instance\n"
    );
}
#[test]
fn unavailable_identity_file_refuses_start_before_any_server() {
    let mut f = Fixture::new();
    fs::create_dir(f.root.join("boot-id")).unwrap();
    f.start();
    until(|| f.root.join("dialog-reached").exists());
    let child = f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    f.launcher = None;
    assert!(f.starts("api-starts").is_empty());
    assert!(f.starts("ws-starts").is_empty());
}
#[test]
fn voice_only_boot_and_second_launch_never_request_or_focus_a_window() {
    let mut f = Fixture::new();
    fs::write(f.root.join("voice-only"), "1").unwrap();
    f.start();
    until(|| f.root.join("ws-env").exists() && f.root.join("api-env").exists());
    assert!(f.launch().wait().unwrap().success());
    let env: serde_json::Value =
        serde_json::from_slice(&fs::read(f.root.join("api-env")).unwrap()).unwrap();
    assert_eq!(env["O8_NEXT_BIN"], "");
    std::thread::sleep(Duration::from_millis(250));
    assert!(!f.root.join("window-ready").exists());
    assert!(!f.root.join("focus-shows").exists());
    assert!(!f.root.join("shows").exists());
}
#[test]
fn second_launch_queues_reopen_while_preflight_is_pending() {
    let mut f = Fixture::new();
    fs::write(f.root.join("hold-probe"), "1").unwrap();
    f.start();
    until(|| f.root.join("probe-entered").exists());
    let result = f.launch().wait().unwrap();
    fs::remove_file(f.root.join("hold-probe")).unwrap();
    assert!(result.success());
    f.ready();
    assert_eq!(f.starts("api-starts").len(), 1);
    assert_eq!(f.starts("ws-starts").len(), 1);
}
#[test]
fn shutdown_during_preflight_never_publishes_a_boot_or_starts_servers() {
    let mut f = Fixture::new();
    fs::write(f.root.join("hold-probe"), "1").unwrap();
    f.start();
    until(|| f.root.join("probe-entered").exists());
    unsafe {
        libc::kill(f.launcher.as_ref().unwrap().id() as i32, libc::SIGTERM);
    }
    fs::remove_file(f.root.join("hold-probe")).unwrap();
    let child = f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    assert!(child.wait().unwrap().success());
    f.launcher = None;
    assert!(!f.root.join("boot-id").exists());
    assert!(!f.root.join("logs/next-server.log").exists());
    assert!(f.starts("api-starts").is_empty());
    assert!(f.starts("ws-starts").is_empty());
}
