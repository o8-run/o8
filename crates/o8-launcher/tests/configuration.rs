mod support;
use std::{fs, net::TcpListener};
use support::*;

#[test]
fn invalid_paths_and_conflicting_explicit_ports_fail_before_spawning() {
    for case in ["relative", "duplicate", "occupied"] {
        let mut f = Fixture::new();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let path = f.root.join("config.json");
        let mut config: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let reason = if case == "relative" {
            config["node"] = "relative-node".into();
            "Launch paths must be absolute"
        } else {
            config["api_port"] = port.into();
            if case == "duplicate" {
                config["ws_port"] = port.into();
            }
            "Server ports unavailable"
        };
        // Duplicate-port rejection must also hold when the shared port is free.
        if case == "duplicate" {
            drop(listener);
        }
        fs::write(path, config.to_string()).unwrap();
        f.start();
        let child = f.launcher.as_mut().unwrap();
        until(|| child.try_wait().unwrap().is_some());
        assert!(!child.wait().unwrap().success());
        f.launcher = None;
        assert!(fs::read_to_string(f.root.join("dialog-reached"))
            .unwrap()
            .contains(reason));
        assert!(!f.root.join("api-starts").exists());
        assert!(!f.root.join("ws-starts").exists());
    }
}

#[test]
fn failed_respawns_consume_the_same_bounded_restart_budget() {
    let mut f = Fixture::new();
    f.start();
    f.ready();
    fs::rename(f.root.join("node"), f.root.join("unavailable-node")).unwrap();
    unsafe {
        libc::kill(f.starts("ws-starts")[0] as i32, libc::SIGKILL);
    }
    let child = f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    assert!(!child.wait().unwrap().success());
    f.launcher = None;
    assert_eq!(f.starts("ws-starts").len(), 1);
    let log = fs::read_to_string(f.root.join("logs/ws-server.log")).unwrap();
    assert_eq!(log.matches("restart attempt").count(), 3);
    assert!(fs::read_to_string(f.root.join("dialog-reached"))
        .unwrap()
        .contains("restart budget"));
    for port in [f.port("api-port"), f.port("ws-port")] {
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
    }
}
