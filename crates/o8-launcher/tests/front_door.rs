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
    // On macOS the window and o8d both start with the allocator that returns
    // freed pages, as the Node servers do.
    let space_efficient = if cfg!(target_os = "macos") {
        serde_json::json!("1")
    } else {
        serde_json::Value::Null
    };
    assert_eq!(env["MallocSpaceEfficient"], space_efficient);
    assert_eq!(
        self::env(&f, "o8d-env")["MallocSpaceEfficient"],
        space_efficient
    );
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

/// #6529 review: a file already at the window socket path is never removed.
/// The launcher refuses to start instead, and quitting leaves the file.
#[test]
fn next_off_keeps_a_foreign_file_at_the_window_socket_path() {
    let mut f = Fixture::new();
    let path = f.root.join("window-control.sock");
    fs::write(&path, b"preserve").unwrap();
    f.start_with(&[("O8_API_FRONT_DOOR", "1"), ("O8_NEXT_OFF", "1")]);
    until(|| f.log("dialog-reached").contains("Window control unavailable"));
    assert!(!f.root.join("ws-env").exists(), "WS started without window control");
    assert_eq!(fs::read(&path).unwrap(), b"preserve");
    until(|| !f.running());
    f.launcher = None;
    assert_eq!(fs::read(&path).unwrap(), b"preserve");
}

/// #6531 review: a window that stops reading its control pipe never holds up
/// Quit. Its writer is not waited for, it is killed after its one-second exit
/// bound, and o8d, WS, their ports and the private sockets are gone within the
/// shutdown deadline. Quit enters through TERM, the shared shutdown coordinator.
#[test]
fn next_off_quit_is_bounded_with_a_window_that_stops_reading() {
    let mut f = Fixture::new();
    fs::write(f.root.join("stall-window"), "1").unwrap();
    f.start_with(&[("O8_API_FRONT_DOOR", "1"), ("O8_NEXT_OFF", "1")]);
    f.ready();
    let window = f.starts("window-starts")[0];
    let o8d = env(&f, "launcher-o8d.json")["pid"].as_u64().unwrap() as u32;
    let ws = f.starts("ws-starts")[0];
    let (api, private) = (f.port("api-port"), env(&f, "launcher-ws.json")["port"].as_u64().unwrap() as u16);
    // WS floods the relay; dropped frames must not block its socket either.
    until(|| f.root.join("flooded").exists());
    std::thread::sleep(Duration::from_millis(300));
    let started = std::time::Instant::now();
    let launcher = f.launcher.as_mut().unwrap();
    unsafe {
        libc::kill(launcher.id() as i32, libc::SIGTERM);
    }
    until(|| launcher.try_wait().unwrap().is_some());
    let elapsed = started.elapsed();
    f.launcher = None;
    // Well inside the 10-second shutdown bound: one second for the window.
    assert!(elapsed < Duration::from_secs(5), "quit took {elapsed:?}");
    for pid in [window, o8d, ws] {
        assert!(gone(pid), "{pid} survived quit");
    }
    assert!(TcpStream::connect(("127.0.0.1", api)).is_err());
    assert!(TcpStream::connect(("127.0.0.1", private)).is_err());
    assert!(!f.root.join("window-control.sock").exists());
    assert!(!f.root.join("launcher.sock").exists());
}

/// #6532: ⌘Q or the app menu's Quit in a launcher-owned window quits o8 through
/// this launcher's own bounded shutdown, and leaves another instance running.
#[test]
fn next_off_window_quit_stops_this_launcher_and_no_other_instance() {
    let mut other = Fixture::new();
    other.start_with(&[("O8_API_FRONT_DOOR", "1"), ("O8_NEXT_OFF", "1")]);
    other.ready();
    until(|| !other.starts("window-starts").is_empty());
    let other_window = other.starts("window-starts")[0];
    let mut f = Fixture::new();
    f.start_with(&[("O8_API_FRONT_DOOR", "1"), ("O8_NEXT_OFF", "1")]);
    f.ready();
    until(|| !f.starts("window-starts").is_empty());
    let window = f.starts("window-starts")[0];
    let ws = f.starts("ws-starts")[0];
    let owner = env(&f, "launcher-o8d.json")["pid"].as_u64().unwrap() as u32;
    let api = f.port("api-port");
    assert_eq!(env(&f, "window-env")["O8_NEXT_QUIT_VIA_PARENT"], "1");
    // The window stays up and keeps its lifeline until the launcher answers.
    fs::write(f.root.join("press-quit"), "1").unwrap();
    let status = {
        let launcher = f.launcher.as_mut().unwrap();
        until(|| launcher.try_wait().unwrap().is_some());
        launcher.try_wait().unwrap().unwrap()
    };
    f.launcher = None;
    assert!(status.success(), "the launcher must exit cleanly: {status:?}");
    for pid in [window, ws, owner] {
        until(|| gone(pid));
    }
    assert!(TcpStream::connect(("127.0.0.1", api)).is_err());
    assert!(!f.root.join("launcher.sock").exists());
    assert!(!f.root.join("window-control.sock").exists());
    // Another instance, with its own launcher and window, is untouched.
    assert!(other.running());
    assert!(!gone(other_window));
    assert!(TcpStream::connect(("127.0.0.1", other.port("api-port"))).is_ok());
    other.stop();
    until(|| gone(other_window));
}

/// A populated profile can keep WS starting past the health window. The launcher
/// reports the slow start once and keeps probing at a slower rate, so the window
/// opens when WS becomes healthy without a second Show.
#[test]
fn next_off_window_opens_when_ws_becomes_healthy_after_the_health_window() {
    let mut f = Fixture::new();
    fs::write(f.root.join("wrong-boot"), "1").unwrap();
    f.start_with(&[
        ("O8_API_FRONT_DOOR", "1"),
        ("O8_NEXT_OFF", "1"),
        ("O8_LAUNCHER_HEALTH_WINDOW_MS", "500"),
    ]);
    until(|| f.root.join("dialog-reached").exists());
    let reported = f.log("dialog-reached");
    assert!(reported.contains("Server did not become healthy"));
    assert!(!f.root.join("window-ready").exists());
    // Past the window, a fast foreign-boot reply is probed about once a second,
    // not on every 25 ms supervisor tick.
    fs::write(f.root.join("count-identity"), "1").unwrap();
    std::thread::sleep(Duration::from_millis(2500));
    fs::remove_file(f.root.join("count-identity")).unwrap();
    let probes = f.log("identity-gets").lines().count();
    assert!((1..=4).contains(&probes), "{probes} identity probes in 2.5 s");
    fs::remove_file(f.root.join("wrong-boot")).unwrap();
    f.ready();
    assert_eq!(f.starts("window-starts").len(), 1, "one window");
    assert!(f.running());
    f.stop();
}

const PARKING: [(&str, &str); 3] = [
    ("O8_API_FRONT_DOOR", "1"),
    ("O8_NEXT_OFF", "1"),
    ("O8_PARK_NODE", "1"),
];
fn node_state(f: &Fixture) -> serde_json::Value {
    control(f, serde_json::json!({"op":"node-status"}))["state"].clone()
}

/// O8_PARK_NODE=1: Node stops on request without counting as a crash, stays
/// down, and starts again on request. Cycles past the three-restart budget
/// prove parking never charges it.
#[test]
fn parked_node_stops_cleanly_and_starts_on_request_without_restart_budget() {
    let mut f = Fixture::new();
    f.start_with(&PARKING);
    f.ready();
    assert_eq!(env(&f, "ws-env")["O8_PARK_NODE"], "1");
    assert_eq!(node_state(&f), "running");
    for cycle in 1..=4 {
        let node = *f.starts("ws-starts").last().unwrap();
        assert_eq!(
            control(&f, serde_json::json!({"op":"park-node"}))["state"],
            "parking"
        );
        until(|| gone(node));
        until(|| node_state(&f) == "parked");
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(
            f.starts("ws-starts").len(),
            cycle,
            "a parked Node is not restarted"
        );
        assert_eq!(
            control(&f, serde_json::json!({"op":"park-node"}))["error"],
            "Node is not running"
        );
        assert_eq!(
            control(&f, serde_json::json!({"op":"start-node"}))["state"],
            "starting"
        );
        until(|| f.starts("ws-starts").len() == cycle + 1);
        until(|| node_state(&f) == "running");
    }
    let log = fs::read_to_string(f.root.join("logs/ws-server.log")).unwrap_or_default();
    assert_eq!(log.matches("[o8-sidecar-supervisor] parked").count(), 4);
    assert!(!log.contains("restart attempt"), "parking is not a crash");
    assert!(f.running());
    f.stop();
}

/// A restart admitted while Node is parked has no Node work to inspect or drain.
#[test]
fn restart_while_node_is_parked_skips_the_node_drain() {
    let mut f = Fixture::new();
    f.start_with(&PARKING);
    f.ready();
    let node = f.starts("ws-starts")[0];
    control(&f, serde_json::json!({"op":"park-node"}));
    until(|| gone(node));
    let receipt = control(&f, serde_json::json!({"op":"prepare-restart"}));
    assert_eq!(receipt["ok"], true);
    let result = control(
        &f,
        serde_json::json!({"op":"restart","reservation":receipt["reservation"]}),
    );
    assert_eq!(result["admitted"], true);
    let child = f.launcher.as_mut().unwrap();
    until(|| child.try_wait().unwrap().is_some());
    f.launcher = None;
    let events = fs::read_to_string(f.root.join("events")).unwrap_or_default();
    assert!(
        !events.contains("inspect") && !events.contains("drain"),
        "{events}"
    );
}

/// Without the switch, nothing changes: Node is never parked.
#[test]
fn without_the_switch_node_refuses_to_park() {
    let mut f = Fixture::new();
    f.start_with(&[("O8_API_FRONT_DOOR", "1"), ("O8_NEXT_OFF", "1")]);
    f.ready();
    assert_eq!(env(&f, "ws-env")["O8_PARK_NODE"], serde_json::Value::Null);
    assert_eq!(
        control(&f, serde_json::json!({"op":"park-node"}))["error"],
        "Parking is off"
    );
    std::thread::sleep(Duration::from_millis(500));
    assert!(!gone(f.starts("ws-starts")[0]));
    f.stop();
}

/// The real o8d from this checkout. CI builds it, with all features, in the
/// step before these tests. O8D_TEST_BINARY or CARGO_TARGET_DIR point
/// elsewhere.
fn real_o8d() -> std::path::PathBuf {
    let path = std::env::var_os("O8D_TEST_BINARY")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("CARGO_TARGET_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../o8d/target")
                })
                .join("debug/o8d")
        });
    assert!(
        path.is_file(),
        "build o8d first: cargo build --manifest-path crates/o8d/Cargo.toml --features experimental-session-reads --bin o8d ({})",
        path.display()
    );
    path
}

/// One HTTP/1.1 GET with extra header lines; returns the status and body.
fn get(port: u16, path: &str, headers: &str) -> (u16, String) {
    use std::io::{Read, Write};
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{headers}Connection: close\r\n\r\n"
    )
    .unwrap();
    let mut reply = String::new();
    let _ = stream.read_to_string(&mut reply);
    let status = reply
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let body = reply
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .unwrap_or_default();
    (status, body)
}

/// Through the real launcher and o8d: Node rests, parks and exits; the app's
/// own background read leaves it parked; a request the user made starts Node
/// and is answered by it, with no restart budget used.
#[test]
fn a_request_to_a_parked_node_starts_it_and_is_answered() {
    let mut f = Fixture::new();
    let o8d = real_o8d();
    let mut extra = PARKING.to_vec();
    extra.push(("O8D_BINARY", o8d.to_str().unwrap()));
    f.start_with(&extra);
    f.ready();
    let api = f.port("api-port");
    // A route o8d does not own reaches the fixture Node once it attaches.
    until(|| get(api, "/api/fixture-node", "").0 == 200);
    let node = f.starts("ws-starts")[0];
    assert_eq!(
        control(&f, serde_json::json!({"op":"park-node"}))["state"],
        "parking"
    );
    until(|| gone(node));
    until(|| node_state(&f) == "parked");

    // Background traffic keeps today's answer and does not wake Node.
    let (status, _) = get(api, "/api/fixture-node", "x-o8-foreground: 0\r\n");
    assert_eq!(status, 503);
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(node_state(&f), "parked");
    assert_eq!(f.starts("ws-starts").len(), 1);

    let started = std::time::Instant::now();
    let (status, body) = get(api, "/api/fixture-node", "");
    let elapsed = started.elapsed();
    eprintln!(
        "a parked Node answered a request in {} ms",
        elapsed.as_millis()
    );
    assert_eq!(
        status,
        200,
        "{body}\no8d: {}\nws: {}\nlauncher: {}",
        f.log("logs/o8d.log"),
        f.log("logs/ws-server.log"),
        f.log("launcher-stderr")
    );
    assert!(body.contains("bootId"), "{body}");
    assert!(elapsed < Duration::from_secs(10));
    assert_eq!(f.starts("ws-starts").len(), 2);
    assert_eq!(node_state(&f), "running");
    let log = fs::read_to_string(f.root.join("logs/ws-server.log")).unwrap_or_default();
    assert_eq!(log.matches("[o8-sidecar-supervisor] parked").count(), 1);
    assert!(!log.contains("restart attempt"), "a wake is not a restart");
    f.stop();
}
