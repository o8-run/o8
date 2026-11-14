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
#[test]
fn a_proven_server_under_the_old_install_is_stopped_after_a_move() {
    let mut f = Fixture::new();
    // Only built-in runtime modules run in this isolated server. No app loads.
    let node = std::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .current_dir(&f.root)
        .output()
        .unwrap();
    assert!(node.status.success());
    let node = fs::canonicalize(String::from_utf8(node.stdout).unwrap().trim()).unwrap();
    let server = r#"
const fs = require('node:fs');
const server = require('node:net').createServer();
const root = process.argv[1];
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(root + '/old-port.pending', String(server.address().port));
  fs.renameSync(root + '/old-port.pending', root + '/old-port');
});
"#;
    let helper = r#"
import os, subprocess, sys
child = subprocess.Popen([sys.argv[1], '-e', sys.argv[3], '--', sys.argv[2]],
    cwd=sys.argv[2], env={'O8_DATA_DIR':sys.argv[2]}, start_new_session=True,
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(child.pid, os.getpid())
"#;
    let output = std::process::Command::new("python3")
        .args(["-c", helper])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .current_dir(&f.root)
        .arg(&node)
        .arg(&f.root)
        .arg(server)
        .output()
        .unwrap();
    assert!(output.status.success());
    let ids = String::from_utf8(output.stdout)
        .unwrap()
        .split_whitespace()
        .map(|id| id.parse::<u32>().unwrap())
        .collect::<Vec<_>>();
    let (pid, prior_parent) = (ids[0], ids[1]);
    // Fixture drop owns emergency cleanup, even if an assertion fails.
    fs::write(f.root.join("api-starts"), format!("{pid}\n")).unwrap();
    until(|| f.root.join("old-port").exists());
    let receipt = o8_launcher::ownership::Receipt {
        pid,
        identity: o8_launcher::ownership::identity(pid).unwrap(),
        directory: f.root.clone(),
        install: node.with_file_name("o8-launcher"),
        port: f.port("old-port"),
        parent: prior_parent,
    };
    o8_launcher::ownership::private_write(
        &f.root.join("launcher-api.json"),
        &serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    fs::write(f.root.join("hold-probe"), "1").unwrap();
    f.start();
    until(|| f.root.join("probe-entered").exists());
    let released_port = std::net::TcpListener::bind(("127.0.0.1", f.port("old-port"))).unwrap();
    fs::remove_file(f.root.join("hold-probe")).unwrap();
    f.ready();
    drop(released_port);
    let status = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "stat="])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&status.stdout);
    assert!(
        state.trim().is_empty() || state.trim().starts_with('Z'),
        "old server still running: {state}"
    );
}

#[test]
fn failed_shutdown_logs_the_stop_error_and_releases_both_ports() {
    let mut f = Fixture::new();
    f.start();
    f.ready();
    fs::remove_file(f.root.join("launcher-api.json")).unwrap();
    let child = f.launcher.as_mut().unwrap();
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    until(|| child.try_wait().unwrap().is_some());
    assert!(!child.wait().unwrap().success());
    f.launcher = None;
    assert!(fs::read_to_string(f.root.join("launcher-stderr"))
        .unwrap()
        .contains("Server shutdown incomplete: ownership receipt unavailable"));
    for port in [f.port("api-port"), f.port("ws-port")] {
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
    }
}
