//! Black-box tests enter through the existing shell Devices surface. This same
//! module compiles on the pre-port shell, where every case fails at that entry.
use super::super::*;
use crate::{
    client::Client,
    shell::test_support::{draw, open},
    shell_state::State,
};
use gpui::{TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
struct Fixture {
    client: Client,
    state: Arc<Mutex<Value>>,
    requests: Arc<Mutex<Vec<Value>>>,
    hold: Arc<AtomicBool>,
    fail: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(
            json!({"phase":"idle", "tools":{"hub":{"installed":false},"agent":{"installed":false}}, "platforms":{"ios":{"available":true,"detail":"Xcode simulator available"},"android":{"available":false,"detail":"Android SDK not found"}},"devices":[],"controllers":[],"controllerRevision":0}),
        ));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let hold = Arc::new(AtomicBool::new(false));
        let fail = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (s, r, h, f, done) = (
            state.clone(),
            requests.clone(),
            hold.clone(),
            fail.clone(),
            stop.clone(),
        );
        std::thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        let (s, r, h, f, done) =
                            (s.clone(), r.clone(), h.clone(), f.clone(), done.clone());
                        std::thread::spawn(move || serve(socket, s, r, h, f, done));
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(2)),
                }
            }
        });
        let root = std::env::temp_dir().join(format!(
            "o8-device-test-{}-{}",
            std::process::id(),
            origin.rsplit(':').next().unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self {
            client: Client::authenticated(&origin, Some("fixture-device-operator".into())).unwrap(),
            state,
            requests,
            hold,
            fail,
            stop,
            root,
        }
    }
    fn logs(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }
    fn running(&self) {
        let mut state = self.state.lock().unwrap();
        state["phase"] = json!("running");
        state["tools"]["hub"]["installed"] = json!(true);
        state["embedUrl"] = json!("http://127.0.0.1:1/?token=fixture");
        state["devices"] =
            json!([{"id":"sim-1","name":"iPhone fixture","platform":"ios","state":"running"}]);
        state["controllers"] = json!([{"deviceId":"sim-1","active":null,"busy":false,"waiting":[{"session":"worker-1","label":"Waiting worker","kind":"worker"}]}]);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn serve(
    mut socket: TcpStream,
    state: Arc<Mutex<Value>>,
    requests: Arc<Mutex<Vec<Value>>>,
    hold: Arc<AtomicBool>,
    fail: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) {
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut chunk = [0; 4096];
    let boundary = loop {
        let Ok(n) = socket.read(&mut chunk) else {
            return;
        };
        if n == 0 {
            return;
        }
        bytes.extend_from_slice(&chunk[..n]);
        if let Some(i) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let header = String::from_utf8_lossy(&bytes[..boundary]).to_string();
    let path = header
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap_or("");
    let len = header
        .lines()
        .find_map(|line| {
            line.to_lowercase()
                .strip_prefix("content-length:")
                .and_then(|v| v.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    while bytes.len() < boundary + len {
        let Ok(n) = socket.read(&mut chunk) else {
            return;
        };
        if n == 0 {
            return;
        }
        bytes.extend_from_slice(&chunk[..n]);
    }
    if !path.starts_with("/api/panel/devices") {
        let body = if path.starts_with("/api/mobile/orchestrator/threads") {
            json!({"threads":[]})
        } else {
            json!({"projects":[],"workspaces":[]})
        };
        respond(&mut socket, 200, &body);
        return;
    }
    assert!(
        header
            .to_lowercase()
            .contains("authorization: bearer fixture-device-operator")
    );
    if path.contains("stream=controllers") {
        requests.lock().unwrap().push(json!({"action":"STREAM"}));
        let _ = socket.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        );
        let mut last = Value::Null;
        while !stop.load(Ordering::Acquire) {
            let snapshot = {
                let s = state.lock().unwrap();
                json!({"revision":s["controllerRevision"],"controllers":s["controllers"]})
            };
            if snapshot != last {
                if write!(socket, "data: {snapshot}\n\n").is_err() {
                    return;
                }
                last = snapshot;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        return;
    }
    let body: Value =
        serde_json::from_slice(&bytes[boundary..boundary + len]).unwrap_or(json!({"action":"GET"}));
    let held = (body["action"] == "GET" && hold.load(Ordering::Acquire))
        .then(|| state.lock().unwrap().clone());
    requests.lock().unwrap().push(body.clone());
    while held.is_some() && hold.load(Ordering::Acquire) && !stop.load(Ordering::Acquire) {
        std::thread::sleep(Duration::from_millis(5));
    }
    if fail.load(Ordering::Acquire) {
        respond(
            &mut socket,
            503,
            &json!({"error":{"message":"Fixture device failure"}}),
        );
        return;
    }
    if let Some(old) = held {
        respond(&mut socket, 200, &old);
        return;
    }
    let mut s = state.lock().unwrap();
    match body["action"].as_str().unwrap_or("") {
        "install" => {
            s["phase"] = json!("installing");
            s["stage"] = json!("Downloading device helper");
        }
        "start" => {
            s["phase"] = json!("starting");
            s["stage"] = json!("Starting the device dashboard");
        }
        "stop" => {
            s["phase"] = json!("idle");
            s.as_object_mut().unwrap().remove("embedUrl");
        }
        "take-control" => {
            assert_eq!(
                body["expectedSession"],
                s["controllers"][0]["active"]["session"]
            );
            s["controllers"][0]["active"] =
                json!({"session":"operator-1","label":"Operator","kind":"operator"});
            s["controllerRevision"] = json!(1);
        }
        "release-control" => {
            assert_eq!(body["expectedSession"], json!("operator-1"));
            s["controllers"][0]["active"] = Value::Null;
            s["controllerRevision"] = json!(2);
        }
        "handoff" => {
            assert_eq!(body["targetSession"], json!("worker-1"));
            s["controllers"][0]["active"] =
                json!({"session":"worker-1","label":"Waiting worker","kind":"worker"});
            s["controllerRevision"] = json!(3);
        }
        _ => {}
    }
    respond(&mut socket, 200, &s);
}
fn respond(socket: &mut TcpStream, status: u16, body: &Value) {
    let body = body.to_string();
    let _ = write!(
        socket,
        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}
fn start(f: &Fixture, cx: &mut TestAppContext) -> (gpui::Entity<Shell>, VisualTestContext) {
    let (shell, mut visual) = open(
        f.client.clone(),
        f.root.join("shell.json"),
        State::default(),
        cx,
    );
    visual.update(|window, _| window.activate_window());
    shell.update_in(&mut visual, |s, w, cx| {
        super::super::right_panel::toggle(s, w, cx)
    });
    // The production panel has a 260 ms opening transition. Drive its actual
    // render frames before clicking, rather than querying render-only helpers.
    let settled = Instant::now() + Duration::from_millis(320);
    while Instant::now() < settled {
        pump(&shell, &mut visual);
    }
    // Use the catalog control that already exists on base. A red run must
    // demonstrate the missing Devices UI, rather than a newly named shortcut.
    click(&shell, &mut visual, "panel-tool-devices");
    (shell, visual)
}
fn pump(shell: &gpui::Entity<Shell>, cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.cx.executor().advance_clock(Duration::from_millis(25));
    shell.update_in(cx, |s, w, cx| {
        s.connected = true;
        s.tick(false, w, cx);
    });
    draw(cx);
    std::thread::sleep(Duration::from_millis(5));
}
fn wait(shell: &gpui::Entity<Shell>, cx: &mut VisualTestContext, selector: &'static str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        pump(shell, cx);
        if cx.debug_bounds(selector).is_some() {
            return;
        }
        assert!(Instant::now() < deadline, "missing {selector}");
    }
}
fn click(shell: &gpui::Entity<Shell>, cx: &mut VisualTestContext, selector: &'static str) {
    wait(shell, cx, selector);
    // Loading controls already have bounds but reject input. Wait for the
    // enabled paint (disabled is 0.6, including any parent animation opacity).
    let deadline = Instant::now() + Duration::from_secs(10);
    while cx
        .debug_opacity(selector)
        .is_none_or(|opacity| opacity <= 0.6)
    {
        pump(shell, cx);
        assert!(Instant::now() < deadline, "disabled {selector}");
    }
    let p = cx.debug_bounds(selector).unwrap().center();
    cx.simulate_click(p, gpui::Modifiers::default());
    pump(shell, cx);
}
fn requested(shell: &gpui::Entity<Shell>, cx: &mut VisualTestContext, f: &Fixture, action: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f.logs().iter().any(|r| r["action"] == action) {
        pump(shell, cx);
        assert!(Instant::now() < deadline, "missing {action}");
    }
}
#[gpui::test]
fn devices_status_cards_and_passive_inspection(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (s, mut v) = start(&f, cx);
    wait(&s, &mut v, "devices-ios");
    wait(&s, &mut v, "devices-android");
    wait(&s, &mut v, "devices-guide-android");
    assert!(v.debug_bounds("devices-guide-ios").is_none());
    assert!(f.logs().iter().all(|r| r["action"] == "GET"));
}
#[gpui::test]
fn devices_setup_and_open_stages_disable_duplicate_actions(cx: &mut TestAppContext) {
    let f = Fixture::new();
    let (s, mut v) = start(&f, cx);
    click(&s, &mut v, "devices-open");
    requested(&s, &mut v, &f, "install");
    wait(&s, &mut v, "devices-stage-installing");
    assert!(
        v.debug_opacity("devices-open")
            .is_some_and(|opacity| opacity <= 0.6)
    );
    let disabled = v.debug_bounds("devices-open").unwrap();
    v.simulate_click(disabled.center(), Default::default());
    pump(&s, &mut v);
    assert_eq!(
        f.logs().iter().filter(|r| r["action"] == "install").count(),
        1
    );
    {
        let mut state = f.state.lock().unwrap();
        state["phase"] = json!("idle");
        state["tools"]["hub"]["installed"] = json!(true);
    }
    v.cx.executor().advance_clock(Duration::from_millis(1600));
    for _ in 0..60 {
        pump(&s, &mut v);
    }
    click(&s, &mut v, "devices-open");
    requested(&s, &mut v, &f, "start");
    wait(&s, &mut v, "devices-stage-starting");
}
#[gpui::test]
fn devices_server_error_preserves_refresh_recovery(cx: &mut TestAppContext) {
    let f = Fixture::new();
    f.fail.store(true, Ordering::Release);
    let (s, mut v) = start(&f, cx);
    wait(&s, &mut v, "devices-error");
    f.fail.store(false, Ordering::Release);
    f.running();
    click(&s, &mut v, "devices-refresh");
    click(&s, &mut v, "devices-control-sim-1");
    // Operator input only opens after the error actually clears. GPUI's
    // debug-bounds map retains removed selectors, so absence is not evidence.
    wait(&s, &mut v, "devices-viewer-operator-1");
}
#[gpui::test]
fn devices_timeout_clears_busy_and_late_response_cannot_replace_recovery(cx: &mut TestAppContext) {
    let f = Fixture::new();
    f.hold.store(true, Ordering::Release);
    let (s, mut v) = start(&f, cx);
    wait(&s, &mut v, "devices-checking");
    requested(&s, &mut v, &f, "GET");
    v.cx.executor().advance_clock(Duration::from_secs(16));
    wait(&s, &mut v, "devices-error");
    f.running();
    click(&s, &mut v, "devices-refresh");
    click(&s, &mut v, "devices-control-sim-1");
    wait(&s, &mut v, "devices-viewer-operator-1");
    f.hold.store(false, Ordering::Release);
    for _ in 0..30 {
        pump(&s, &mut v);
    }
    // The late idle response must not replace the recovered running workspace.
    click(&s, &mut v, "devices-control-sim-1");
    requested(&s, &mut v, &f, "release-control");
}
#[gpui::test]
fn devices_roster_take_release_handoff_and_stop(cx: &mut TestAppContext) {
    let f = Fixture::new();
    f.running();
    let (s, mut v) = start(&f, cx);
    click(&s, &mut v, "devices-control-sim-1");
    requested(&s, &mut v, &f, "take-control");
    wait(&s, &mut v, "devices-viewer-operator-1");
    for _ in 0..30 {
        pump(&s, &mut v);
    }
    click(&s, &mut v, "devices-control-sim-1");
    requested(&s, &mut v, &f, "release-control");
    wait(&s, &mut v, "devices-viewer-passive-2");
    for _ in 0..30 {
        pump(&s, &mut v);
    }
    click(&s, &mut v, "devices-handoff-worker-1");
    requested(&s, &mut v, &f, "handoff");
    click(&s, &mut v, "devices-stop");
    requested(&s, &mut v, &f, "stop");
    wait(&s, &mut v, "devices-introduction-idle");
    v.simulate_keystrokes("ctrl-shift-p");
    pump(&s, &mut v);
    assert!(
        s.read_with(&v, |s, _| s.palette),
        "stopping the viewer must preserve shell keyboard focus"
    );
}

#[gpui::test]
fn devices_stream_updates_input_gate_and_panel_visibility(cx: &mut TestAppContext) {
    let f = Fixture::new();
    f.running();
    let (s, mut v) = start(&f, cx);
    wait(&s, &mut v, "devices-viewer-passive-0");
    {
        let mut state = f.state.lock().unwrap();
        state["controllers"][0]["active"] =
            json!({"session":"operator-1","kind":"operator","label":"Operator"});
        state["controllerRevision"] = json!(9);
    }
    wait(&s, &mut v, "devices-viewer-operator-9");
    let renew_deadline = Instant::now() + Duration::from_secs(3);
    while f.logs().iter().filter(|r| r["action"] == "STREAM").count() < 2 {
        pump(&s, &mut v);
        assert!(
            Instant::now() < renew_deadline,
            "ownership stream must renew before its request deadline"
        );
    }
    for _ in 0..20 {
        pump(&s, &mut v);
    }
    assert!(
        v.debug_bounds("devices-viewer-passive-9").is_none(),
        "healthy stream renewal must never revoke operator input"
    );
    // A lagging helper status response must not revoke newer stream ownership.
    {
        let mut state = f.state.lock().unwrap();
        state["controllers"][0]["active"] = Value::Null;
        state["controllerRevision"] = json!(8);
    }
    click(&s, &mut v, "devices-refresh");
    for _ in 0..25 {
        pump(&s, &mut v);
    }
    // The control action itself must still carry revision 9's operator session.
    click(&s, &mut v, "devices-control-sim-1");
    requested(&s, &mut v, &f, "release-control");
    {
        let mut state = f.state.lock().unwrap();
        state["controllers"][0]["active"] = Value::Null;
        state["controllerRevision"] = json!(10);
    }
    wait(&s, &mut v, "devices-viewer-passive-10");
    s.update_in(&mut v, |s, w, cx| {
        super::super::right_panel::toggle(s, w, cx)
    });
    for _ in 0..25 {
        pump(&s, &mut v);
    }
    let reads = f.logs().iter().filter(|r| r["action"] != "STREAM").count();
    v.cx.executor().advance_clock(Duration::from_secs(10));
    for _ in 0..10 {
        pump(&s, &mut v);
    }
    assert_eq!(
        f.logs().iter().filter(|r| r["action"] != "STREAM").count(),
        reads,
        "closed Devices must stop polling"
    );
    s.update_in(&mut v, |s, w, cx| {
        super::super::right_panel::toggle(s, w, cx)
    });
    wait(&s, &mut v, "devices-viewer-passive-10");
}

#[gpui::test]
fn devices_keyboard_scroll_and_tab_activation_reach_lower_controls(cx: &mut TestAppContext) {
    let f = Fixture::new();
    f.state.lock().unwrap()["platforms"]["android"]["detail"] =
        json!("Install Android SDK platform tools and emulator. ".repeat(60));
    let (s, mut v) = start(&f, cx);
    wait(&s, &mut v, "devices-ios");
    v.simulate_keystrokes("end");
    for _ in 0..5 {
        pump(&s, &mut v);
    }
    let bounds = v
        .debug_bounds("devices-copy")
        .or_else(|| v.debug_bounds("devices-agent-install"))
        .expect("lower agent controls must paint after keyboard scroll");
    let viewport = v.update(|window, _| window.viewport_size().height);
    assert!(
        bounds.top() >= gpui::px(0.) && bounds.bottom() <= viewport,
        "keyboard End must reveal the lower control: {bounds:?}"
    );
    let before = v.update(|window, cx| window.focused(cx));
    v.simulate_keystrokes("tab");
    let after = v.update(|window, cx| window.focused(cx));
    assert_ne!(before, after, "Tab must traverse native Devices controls");
    v.simulate_keystrokes("space");
    requested(&s, &mut v, &f, "refresh");
    for _ in 0..10 {
        pump(&s, &mut v);
    }
    v.simulate_keystrokes("enter");
    let deadline = Instant::now() + Duration::from_secs(10);
    while f.logs().iter().filter(|r| r["action"] == "refresh").count() < 2 {
        pump(&s, &mut v);
        assert!(
            Instant::now() < deadline,
            "Enter must activate the focused control"
        );
    }
}
