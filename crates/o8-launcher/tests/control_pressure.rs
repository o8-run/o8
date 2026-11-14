mod support;
use std::{fs, io::Write, os::unix::net::UnixStream};
use support::*;
#[test]
fn a_full_restart_queue_refuses_more_work_but_still_acknowledges_reopen() {
    let mut f = Fixture::new();
    fs::write(f.root.join("hold-probe"), "1").unwrap();
    f.start();
    until(|| f.root.join("probe-entered").exists());
    let mut pending = Vec::new();
    for _ in 0..16 {
        let mut peer = UnixStream::connect(f.root.join("launcher.sock")).unwrap();
        peer.write_all(b"{\"op\":\"prepare-restart\"}").unwrap();
        peer.shutdown(std::net::Shutdown::Write).unwrap();
        pending.push(peer);
    }
    let busy = control(&f, serde_json::json!({"op":"prepare-restart"}));
    assert_eq!(busy["ok"], false);
    let reopen = f.launch().wait().unwrap();
    fs::remove_file(f.root.join("hold-probe")).unwrap();
    drop(pending);
    assert!(reopen.success());
    f.ready();
    assert_eq!(f.starts("api-starts").len(), 1);
}
#[test]
fn descendant_pipe_drain_completes_before_group_escalation() {
    let mut f = Fixture::new();
    fs::write(f.root.join("graceful-child"), "1").unwrap();
    f.start();
    f.ready();
    f.stop();
    assert!(f.root.join("child-drained").exists());
    assert!(!f.root.join("drain-interrupted").exists());
}
#[test]
fn startup_error_stops_api_before_ws_and_releases_both_ports() {
    let mut f = Fixture::new();
    fs::write(f.root.join("wrong-boot"), "1").unwrap();
    f.start();
    until(|| f.root.join("ws-env").exists() && f.root.join("ws-token").exists());
    fs::remove_file(f.root.join("ws-token")).unwrap();
    fs::remove_file(f.root.join("wrong-boot")).unwrap();
    let child = f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    assert!(!child.wait().unwrap().success());
    f.launcher = None;
    let events = fs::read_to_string(f.root.join("events")).unwrap();
    assert!(events.find("api-stop").unwrap() < events.find("ws-stop").unwrap());
    for port in [f.port("api-port"), f.port("ws-port")] {
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
    }
    assert!(f.root.join("dialog-reached").exists());
}
#[test]
fn nonregular_ownership_receipt_is_refused_without_waiting_for_a_writer() {
    let mut f = Fixture::new();
    let receipt = f.root.join("launcher-api.json");
    let path = std::ffi::CString::new(receipt.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    f.start();
    let child = f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    assert!(!child.wait().unwrap().success());
    f.launcher = None;
    assert!(receipt.exists());
    assert!(!f.root.join("api-starts").exists());
}
#[test]
fn hardlinked_prior_receipt_is_preserved_and_refused_before_cleanup() {
    let mut f = Fixture::new();
    let target = f.root.join("prior-receipt");
    let receipt = o8_launcher::ownership::Receipt {
        pid: i32::MAX as u32,
        identity: "absent-fixture-process".into(),
        directory: f.root.clone(),
        install: env!("CARGO_BIN_EXE_o8-launcher").into(),
        port: 0,
        parent: 1,
    };
    let bytes = serde_json::to_vec(&receipt).unwrap();
    o8_launcher::ownership::private_write(&target, &bytes).unwrap();
    let link = f.root.join("launcher-api.json");
    fs::hard_link(&target, &link).unwrap();
    f.start();
    let child = f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    assert!(!child.wait().unwrap().success());
    f.launcher = None;
    assert!(link.exists());
    assert_eq!(fs::read(target).unwrap(), bytes);
    assert!(!f.root.join("api-starts").exists());
}

#[test]
fn slow_control_client_has_an_overall_deadline() {
    use std::time::{Duration, Instant};
    let mut f = Fixture::new();
    f.start();
    f.ready();
    let mut peer = UnixStream::connect(f.root.join("launcher.sock")).unwrap();
    let writer = std::thread::spawn(move || {
        for _ in 0..80 {
            if peer.write_all(b" ").is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    std::thread::sleep(Duration::from_millis(200));
    let start = Instant::now();
    let result = control(&f, serde_json::json!({"op":"show"}));
    let elapsed = start.elapsed();
    writer.join().unwrap();
    assert_eq!(result["ok"], true);
    assert!(
        elapsed < Duration::from_secs(2),
        "slow client held worker: {elapsed:?}"
    );
}
#[test]
fn hangup_stops_servers_and_releases_ports() {
    let mut f = Fixture::new();
    f.start();
    f.ready();
    unsafe {
        libc::kill(f.launcher.as_ref().unwrap().id() as i32, libc::SIGHUP);
    }
    let child = f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    assert!(child.wait().unwrap().success());
    f.launcher = None;
    for port in [f.port("api-port"), f.port("ws-port")] {
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
    }
}
#[test]
fn an_open_failure_dialog_does_not_block_control_or_shutdown() {
    let mut f = Fixture::new();
    fs::write(f.root.join("fail-window"), "1").unwrap();
    fs::write(f.root.join("hold-dialog"), "1").unwrap();
    f.start();
    until(|| f.root.join("dialog-reached").exists());
    assert_eq!(
        control(&f, serde_json::json!({"op":"prepare-restart"}))["ok"],
        true
    );
    f.stop();
    assert!(!f.root.join("dialog-exited").exists());
    fs::remove_file(f.root.join("hold-dialog")).unwrap();
}

#[test]
fn an_uninspectable_other_user_receipt_does_not_block_start() {
    let mut f = Fixture::new();
    // The system init process belongs to another UID on non-root test runners.
    assert!(o8_launcher::ownership::identity(1).is_none());
    let receipt = o8_launcher::ownership::Receipt {
        pid: 1,
        identity: "foreign-user".into(),
        directory: f.root.clone(),
        install: env!("CARGO_BIN_EXE_o8-launcher").into(),
        port: 0,
        parent: 1,
    };
    o8_launcher::ownership::private_write(
        &f.root.join("launcher-api.json"),
        &serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    f.start();
    f.ready();
    let receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(f.root.join("launcher-api.json")).unwrap()).unwrap();
    assert_ne!(receipt["pid"], 1);
}
// Copying platform-signed executables is not supported by the macOS fixture.
#[cfg(target_os = "linux")]
#[test]
fn a_proven_server_under_the_old_install_is_stopped_after_a_move() {
    let mut f = Fixture::new();
    let old = f.root.join("old-install");
    fs::create_dir(&old).unwrap();
    fs::copy("/bin/sleep", old.join("node")).unwrap();
    let output = std::process::Command::new("python3").args(["-c", "import subprocess,sys; p=subprocess.Popen([sys.argv[1],'60'],cwd=sys.argv[2],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print(p.pid)"])
        .arg(old.join("node")).arg(&f.root).output().unwrap();
    assert!(output.status.success());
    let pid: u32 = String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    // Fixture drop owns emergency cleanup, even if an assertion fails.
    fs::write(f.root.join("api-starts"), format!("{pid}\n")).unwrap();
    let receipt = o8_launcher::ownership::Receipt {
        pid,
        identity: o8_launcher::ownership::identity(pid).unwrap(),
        directory: f.root.clone(),
        install: old.join("o8-launcher"),
        port: 0,
        parent: 1,
    };
    o8_launcher::ownership::private_write(
        &f.root.join("launcher-api.json"),
        &serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    f.start();
    f.ready();
    let status = std::process::Command::new("ps").args(["-p", &pid.to_string(), "-o", "stat="]).output().unwrap();
    let state = String::from_utf8_lossy(&status.stdout);
    assert!(state.trim().is_empty() || state.trim().starts_with('Z'), "old server still running: {state}");
}
