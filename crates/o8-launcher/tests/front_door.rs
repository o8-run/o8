mod support;
use std::{fs, net::TcpStream, time::Duration};
use support::*;

fn env(f: &Fixture, name: &str) -> serde_json::Value {
    serde_json::from_slice(&fs::read(f.root.join(name)).unwrap()).unwrap()
}

#[test]
fn front_door_keeps_o8d_on_the_public_port_and_producers_on_private_ports() {
    let mut f = Fixture::new();
    f.start_with(&[("O8_API_FRONT_DOOR", "1")]);
    f.ready();
    until(|| f.root.join("api-env").exists());
    let api = f.port("api-port");
    // o8d answers the public port, and clients reading the WS port file go there.
    assert_eq!(f.port("ws-port"), api);
    // Both children start without waiting on each other, so their order of
    // arrival is not asserted.
    let ws = env(&f, "ws-env");
    let next = env(&f, "api-env");
    let owner = env(&f, "launcher-o8d.json");
    let producer = env(&f, "launcher-ws.json");
    assert_ne!(owner["pid"], producer["pid"]);
    assert_eq!(owner["port"], api);
    assert_ne!(producer["port"], api);
    assert_eq!(
        ws["O8D_PRODUCER_UPSTREAM_PORT"],
        producer["port"].to_string()
    );
    assert_eq!(ws["O8_API_FRONT_DOOR"], "1");
    assert_eq!(next["O8_API_FRONT_DOOR"], "1");
    assert_eq!(ws["O8_NEXT_OFF"], serde_json::Value::Null);
    assert_eq!(ws["O8_NEXT_WINDOW_OWNER"], serde_json::Value::Null);
    assert_eq!(ws["O8_API_PORT"], api.to_string());
    assert_eq!(next["O8_API_PORT"], api.to_string());
    let private: u16 = next["PORT"].as_str().unwrap().parse().unwrap();
    assert_ne!(private, api);
    assert_ne!(private, f.port("ws-port"));
    assert_eq!(next["HOSTNAME"], "127.0.0.1");
    assert_eq!(ws["NEXT_ORIGIN"], format!("http://127.0.0.1:{private}"));
    // WS launches the native window from the public port.
    assert_eq!(
        ws["O8_NEXT_BIN"],
        f.root.join("window").to_string_lossy().as_ref()
    );
    assert!(TcpStream::connect(("127.0.0.1", private)).is_ok());
    f.stop();
    assert!(TcpStream::connect(("127.0.0.1", api)).is_err());
    assert!(TcpStream::connect(("127.0.0.1", private)).is_err());
}

#[test]
fn next_off_runs_with_native_owner_and_ws_and_stays_up() {
    let mut f = Fixture::new();
    f.start_with(&[("O8_API_FRONT_DOOR", "1"), ("O8_NEXT_OFF", "1")]);
    f.ready();
    std::thread::sleep(Duration::from_secs(2));
    assert!(f.running(), "the launcher must not exit without Next");
    assert!(!f.root.join("api-env").exists(), "Next was started");
    assert_eq!(f.log("start-order"), "ws\n");
    let ws = env(&f, "ws-env");
    // WS runs Next's startup work when Next is off.
    assert_eq!(ws["O8_NEXT_OFF"], "1");
    assert_eq!(ws["O8_NEXT_WINDOW_OWNER"], "ws");
    // The launcher owns the window (#6529); WS only attaches to its control.
    assert_eq!(ws["O8_NEXT_BIN"], serde_json::Value::Null);
    let socket = f.root.join("window-control.sock");
    assert_eq!(
        ws["O8_NEXT_WINDOW_CONTROL"],
        socket.to_string_lossy().as_ref()
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(&socket).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let origin = ws["NEXT_ORIGIN"].as_str().unwrap().to_owned();
    let private: u16 = origin.rsplit(':').next().unwrap().parse().unwrap();
    assert_ne!(private, f.port("api-port"));
    let api = f.port("api-port");
    f.stop();
    assert!(TcpStream::connect(("127.0.0.1", api)).is_err());
}

#[test]
fn next_off_without_the_front_door_still_starts_next() {
    let mut f = Fixture::new();
    f.start_with(&[("O8_NEXT_OFF", "1")]);
    f.ready();
    until(|| f.root.join("api-env").exists());
    assert_eq!(
        env(&f, "ws-env")["O8_API_FRONT_DOOR"],
        serde_json::Value::Null
    );
    assert!(f.root.join("ws-env").exists());
    f.stop();
}

#[test]
fn exhausted_producer_budget_presents_degraded_mode_and_keeps_owner_alive() {
    let mut f = Fixture::new();
    fs::write(f.root.join("crash-ws"), "fixture").unwrap();
    f.start_with(&[("O8_API_FRONT_DOOR", "1"), ("O8_NEXT_OFF", "1")]);
    f.ready();
    let owner = env(&f, "launcher-o8d.json")["pid"].as_u64().unwrap();
    until(|| {
        f.log("dialog-reached")
            .contains("Native features remain available")
    });
    assert!(f.running());
    assert_eq!(env(&f, "launcher-o8d.json")["pid"], owner);
    assert_eq!(f.starts("ws-starts").len(), 4);
    f.stop();
}

/// #6529: with Next off, the window outlives a WS restart, and each WS
/// generation reattaches to its browser control through the launcher.
#[test]
fn next_off_window_survives_a_ws_restart_and_keeps_browser_control() {
    let mut f = Fixture::new();
    f.start_with(&[("O8_API_FRONT_DOOR", "1"), ("O8_NEXT_OFF", "1")]);
    f.ready();
    until(|| f.log("browser-results").lines().count() == 1);
    let window = f.starts("window-starts");
    assert_eq!(window.len(), 1);
    let window = window[0];
    let first: serde_json::Value = serde_json::from_str(
        f.log("browser-results")
            .lines()
            .next()
            .unwrap()
            .strip_prefix("o8-next-browser-result:")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(first["result"]["window"], window);
    let ws = f.starts("ws-starts")[0];
    unsafe {
        libc::kill(ws as i32, libc::SIGKILL);
    }
    until(|| f.starts("ws-starts").len() == 2);
    until(|| f.log("browser-results").lines().count() == 2);
    let second: serde_json::Value = serde_json::from_str(
        f.log("browser-results")
            .lines()
            .nth(1)
            .unwrap()
            .strip_prefix("o8-next-browser-result:")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(second["id"], f.starts("ws-starts")[1].to_string());
    assert_eq!(second["result"]["window"], window);
    // Same window process, never relaunched.
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(f.starts("window-starts"), vec![window]);
    assert!(!gone(window));
    // The window reaches the public port with the operator credential and no
    // server environment.
    let env = env(&f, "window-env");
    assert_eq!(env["O8_NEXT_API_TOKEN"], "fixture-token");
    assert_eq!(env["O8_NEXT_PARENT_PIPE"], "1");
    assert_eq!(env["O8_DATA_DIR"], serde_json::Value::Null);
    let args: Vec<String> =
        serde_json::from_slice(&fs::read(f.root.join("window-args")).unwrap()).unwrap();
    let api = f.port("api-port");
    assert_eq!(
        args[..4],
        [
            "--enable-next",
            "--app-shell",
            "--server",
            &format!("http://127.0.0.1:{api}")
        ]
    );
    // Quit closes the lifeline and the window exits with the launcher.
    f.stop();
    until(|| gone(window));
}

/// A launcher-owned window is focused as the launcher's child, and a closed one
/// opens again on Show, as it did when the public server owned it.
#[test]
fn next_off_show_focuses_the_launcher_window_and_reopens_a_closed_one() {
    let mut f = Fixture::new();
    f.start_with(&[("O8_API_FRONT_DOOR", "1"), ("O8_NEXT_OFF", "1")]);
    f.ready();
    let launcher = f.launcher.as_ref().unwrap().id();
    let window = f.starts("window-starts")[0];
    assert_eq!(control(&f, serde_json::json!({"op": "show"}))["ok"], true);
    until(|| f.log("focus-shows").lines().count() == 1);
    assert_eq!(f.log("focus-shows").trim(), launcher.to_string());
    assert_eq!(f.starts("window-starts"), vec![window]);
    unsafe {
        libc::kill(window as i32, libc::SIGKILL);
    }
    until(|| gone(window));
    assert_eq!(control(&f, serde_json::json!({"op": "show"}))["ok"], true);
    until(|| f.starts("window-starts").len() == 2);
    // No server was asked to open a window.
    assert!(!f.root.join("shows").exists());
    let reopened = f.starts("window-starts")[1];
    f.stop();
    until(|| gone(reopened));
}
