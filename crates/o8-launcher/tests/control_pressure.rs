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
