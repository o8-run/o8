mod support;
use std::{fs, net::TcpStream, time::Duration};
use support::*;

fn env(f: &Fixture, name: &str) -> serde_json::Value {
    serde_json::from_slice(&fs::read(f.root.join(name)).unwrap()).unwrap()
}

#[test]
fn front_door_puts_ws_on_the_public_port_and_next_on_a_private_one() {
    let mut f = Fixture::new();
    f.start_with(&[("O8_API_FRONT_DOOR", "1")]);
    f.ready();
    until(|| f.root.join("api-env").exists());
    let api = f.port("api-port");
    // WS answers the public port, and clients reading the WS port file go there.
    assert_eq!(f.port("ws-port"), api);
    // Both children start without waiting on each other, so their order of
    // arrival is not asserted.
    let ws = env(&f, "ws-env");
    let next = env(&f, "api-env");
    assert_eq!(ws["O8_API_FRONT_DOOR"], "1");
    assert_eq!(next["O8_API_FRONT_DOOR"], "1");
    assert_eq!(ws["O8_NEXT_OFF"], serde_json::Value::Null);
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
fn next_off_runs_with_ws_alone_and_stays_up() {
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
