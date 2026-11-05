use super::*;
use crate::shell::test_support::open;
use crate::shell::test_support::*;
fn click(v: &mut VisualTestContext, id: &'static str) {
    draw(v);
    let b = v.debug_bounds(id).unwrap_or_else(|| panic!("Missing {id}"));
    v.simulate_click(b.center(), gpui::Modifiers::default());
    v.run_until_parked();
    draw(v);
}
#[gpui::test]
fn resources_opens_from_launcher_and_shows_live_metrics(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--resources");
    let mut state = crate::shell_state::State::default();
    state.right_panel.visible = true;
    let (s, mut v) = open(f.client.clone(), f.root.join("resources.json"), state, cx);
    v.simulate_resize(gpui::size(px(1680.), px(1050.)));
    ready(&s, &mut v);
    click(&mut v, "panel-launcher-more");
    click(&mut v, "panel-tool-resources");
    s.update_in(&mut v, |s, w, cx| s.tick(true, w, cx));
    v.run_until_parked();
    draw(&mut v);
    assert!(
        v.debug_bounds("resources-total").is_some(),
        "Resources must render real metrics rather than a placeholder"
    );
    let initial = s.read_with(&v, |s, _| resources::probe(s));
    assert_eq!(initial["data"]["sessions"][0]["key"], "session-heavy");
    assert_eq!(initial["data"]["sessions"][0]["cpuPercent"], 41.);
    assert!(initial["data"]["sessions"][1]["memBytes"].is_null());
    assert!(v.debug_bounds("resource-row-process-small").is_some());
    assert!(v.debug_bounds("resource-stop-session-unknown").is_none());
    assert!(v.debug_bounds("resource-confirm-session-unknown").is_none());
    assert!(
        v.debug_bounds("resource-row-session-heavy").unwrap().top()
            < v.debug_bounds("resource-row-session-unknown")
                .unwrap()
                .top()
    );
    let machine = v
        .debug_bounds("resources-machine")
        .expect("the Machine section renders");
    assert!(
        machine.top() < v.debug_bounds("resource-row-session-heavy").unwrap().top(),
        "Machine sits above the per-session rows"
    );
    for meter in [
        "resources-meter-cpu",
        "resources-meter-memory",
        "resources-meter-swap",
        "resources-meter-disk-data",
        "resources-meter-disk-projects",
        "resources-meter-network",
    ] {
        assert!(v.debug_bounds(meter).is_some(), "{meter}");
    }
    assert!(v.debug_bounds("resources-sparkline").is_some());
    assert_eq!(initial["history"], json!([23.]));
    let reads = snapshot(&f)["reads"].clone();
    for _ in 0..3 {
        tick(&s, &mut v);
    }
    assert_eq!(
        snapshot(&f)["reads"],
        reads,
        "maintenance ticks must not poll every frame or second"
    );
    mode(&f, "changed");
    refresh(&s, &mut v);
    assert_eq!(
        s.read_with(&v, |s, _| resources::probe(s))["data"]["sessions"][0]["cpuPercent"],
        72.
    );
    assert_eq!(
        s.read_with(&v, |s, _| resources::probe(s))["history"],
        json!([23., 64.]),
        "each new machine sample extends the sparkline"
    );
    for failure in ["failed", "payload-error"] {
        mode(&f, failure);
        refresh(&s, &mut v);
        assert!(v.debug_bounds("resources-error").is_some());
        assert_eq!(
            s.read_with(&v, |s, _| resources::probe(s))["data"]["sessions"][0]["cpuPercent"],
            72.,
            "failed readings must retain known metrics"
        );
    }
    mode(&f, "ready");
    click(&mut v, "resources-retry");
    assert!(v.debug_bounds("resources-error").is_none());
    click(&mut v, "resource-stop-session-heavy");
    assert_eq!(
        snapshot(&f)["stops"].as_array().unwrap().len(),
        0,
        "Stop must require a second explicit confirmation"
    );
    click(&mut v, "resource-cancel-session-heavy");
    assert!(v.debug_bounds("resource-confirm-session-heavy").is_none());
    mode(&f, "stop-refused");
    click(&mut v, "resource-stop-session-heavy");
    click(&mut v, "resource-confirm-session-heavy");
    assert!(
        v.debug_bounds("resources-error").is_some(),
        "show a refused stop instead of claiming success"
    );
    assert_eq!(
        snapshot(&f)["stops"][0],
        json!({"key":"session-heavy","pid":424242})
    );
    mode(&f, "ready");
    click(&mut v, "resources-retry");
    let before_stop = snapshot(&f)["reads"].as_u64().unwrap();
    click(&mut v, "resource-stop-session-heavy");
    click(&mut v, "resource-confirm-session-heavy");
    assert_eq!(snapshot(&f)["stops"].as_array().unwrap().len(), 2);
    assert!(
        snapshot(&f)["reads"].as_u64().unwrap() > before_stop,
        "a successful stop must reread the process snapshot"
    );
    mode(&f, "empty");
    refresh(&s, &mut v);
    assert!(v.debug_bounds("resources-empty").is_some());
    std::thread::sleep(std::time::Duration::from_millis(300));
    click(&mut v, "header-right-panel");
    tick(&s, &mut v);
    let reads = snapshot(&f)["reads"].clone();
    refresh(&s, &mut v);
    assert_eq!(
        snapshot(&f)["reads"],
        reads,
        "covered Resources must pause polling"
    );
    mode(&f, "changed");
    std::thread::sleep(std::time::Duration::from_millis(300));
    click(&mut v, "header-right-panel");
    tick(&s, &mut v);
    assert!(
        v.debug_bounds("resource-row-session-heavy").is_some(),
        "reopening must read again"
    );
}

fn snapshot(f: &Fixture) -> Value {
    f.client.get("/api/resources-fixture", &[]).unwrap()
}
fn mode(f: &Fixture, mode: &str) {
    let _: Value = f
        .client
        .get("/api/resources-fixture", &[("mode", mode)])
        .unwrap();
}
fn tick(s: &Entity<Shell>, v: &mut VisualTestContext) {
    s.update_in(v, |s, w, cx| s.tick(true, w, cx));
    v.run_until_parked();
    draw(v);
}
fn refresh(s: &Entity<Shell>, v: &mut VisualTestContext) {
    s.update(v, |s, _| resources::due(s));
    tick(s, v);
}

/// A saved machine's own server: its resource reading reports 61% CPU. The
/// counter holds how many readings it has served.
fn remote_machine_server() -> (
    crate::client::Client,
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
) {
    let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let served = hits.clone();
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            let _ = reader.read_line(&mut first);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            let body = if first.contains("/api/panel/resource-usage") {
                served.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                json!({
                    "sessions": [], "processes": [],
                    "total": {"cpuPercent": 0, "memBytes": 0, "ramTotalBytes": 0},
                    "machine": {
                        "name": "local", "sampledAt": 1, "cpuPercent": 61, "cores": 10,
                        "loadAverage": [2.0, 1.5, 1.0],
                        "memory": {"usedBytes": 6442450944u64, "totalBytes": 25769803776u64},
                        "swap": {"usedBytes": 0, "totalBytes": 0},
                        "disks": {"data": {"usedBytes": 1, "freeBytes": 3, "totalBytes": 4}, "projects": null},
                        "network": {"inBytesPerSec": 1024, "outBytesPerSec": 1024}
                    }
                })
            } else {
                json!({})
            }
            .to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (
        crate::client::Client::authenticated(&origin, None).unwrap(),
        hits,
    )
}

#[gpui::test]
fn resources_shows_each_saved_machine_from_its_own_server(cx: &mut TestAppContext) {
    use crate::shell::settings::machine_links::Reach;
    let f = Fixture::start_mode(false, "--resources");
    let mut state = crate::shell_state::State::default();
    state.right_panel.visible = true;
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("resources-remote.json"),
        state,
        cx,
    );
    v.simulate_resize(gpui::size(px(1680.), px(1050.)));
    ready(&s, &mut v);
    let (server, hits) = remote_machine_server();
    s.update(&mut v, |s, _| {
        s.links
            .put("build-box", "Build box", Reach::Online(server.clone()));
        s.links.put(
            "laptop",
            "Laptop",
            Reach::Offline("Connection lost.".into()),
        );
        s.links.put("studio", "Studio", Reach::Connecting);
    });
    click(&mut v, "panel-launcher-more");
    click(&mut v, "panel-tool-resources");
    let started = Instant::now();
    while v.debug_bounds("resources-meter-build-box-cpu").is_none() {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the saved machine's meters never rendered"
        );
        tick(&s, &mut v);
        std::thread::sleep(Duration::from_millis(20));
    }
    let local = v.debug_bounds("resources-machine").unwrap();
    let remote = v.debug_bounds("resources-machine-build-box").unwrap();
    assert!(local.top() < remote.top(), "this computer comes first");
    for meter in [
        "cpu",
        "memory",
        "swap",
        "disk-data",
        "disk-projects",
        "network",
    ] {
        let id: &'static str =
            Box::leak(format!("resources-meter-build-box-{meter}").into_boxed_str());
        assert!(v.debug_bounds(id).is_some(), "{id}");
    }
    let probe = s.read_with(&v, |s, _| resources::probe(s));
    assert_eq!(probe["remote"]["build-box"]["cpuPercent"], 61.);
    assert_eq!(probe["remote"]["build-box"]["cores"], 10);
    // Offline and connecting machines keep a section that says so, with no meters.
    for id in ["laptop", "studio"] {
        let section: &'static str = Box::leak(format!("resources-machine-{id}").into_boxed_str());
        let meter: &'static str = Box::leak(format!("resources-meter-{id}-cpu").into_boxed_str());
        assert!(v.debug_bounds(section).is_some(), "{section}");
        assert!(v.debug_bounds(meter).is_none(), "{meter}");
    }
    assert_eq!(
        probe["status"],
        json!({"laptop": "Offline · Connection lost.", "studio": "Connecting…"})
    );
    // The local panel still reads this computer's sessions.
    assert!(v.debug_bounds("resource-row-session-heavy").is_some());
    // A machine that goes offline keeps its section and loses its reading.
    s.update(&mut v, |s, _| {
        s.links
            .put("build-box", "Build box", Reach::Offline(String::new()))
    });
    refresh(&s, &mut v);
    assert!(v.debug_bounds("resources-meter-build-box-cpu").is_none());
    assert!(v.debug_bounds("resources-machine-build-box").is_some());
    let probe = s.read_with(&v, |s, _| resources::probe(s));
    assert!(probe["remote"]["build-box"].is_null(), "{probe}");
    // Back online with its server unreachable: no old meters, the error shows.
    s.update(&mut v, |s, _| {
        s.links.put(
            "build-box",
            "Build box",
            Reach::Online(crate::shell::settings::machine_links::dead_client()),
        )
    });
    refresh(&s, &mut v);
    assert!(v.debug_bounds("resources-meter-build-box-cpu").is_none());
    let status = s.read_with(&v, |s, _| resources::probe(s))["status"]["build-box"].clone();
    assert!(
        status.as_str().is_some_and(|s| s != "Reading…"),
        "the failed read is shown: {status}"
    );
    // A removed machine's section goes, and its server is not read again.
    s.update(&mut v, |s, _| {
        s.links
            .put("build-box", "Build box", Reach::Online(server.clone()))
    });
    let started = Instant::now();
    loop {
        refresh(&s, &mut v);
        if v.debug_bounds("resources-meter-build-box-cpu").is_some() {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "no fresh reading"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    s.update(&mut v, |s, _| s.links.remove("build-box"));
    refresh(&s, &mut v);
    let served = hits.load(std::sync::atomic::Ordering::SeqCst);
    for _ in 0..3 {
        refresh(&s, &mut v);
    }
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), served);
    assert!(v.debug_bounds("resources-machine-build-box").is_none());
    let probe = s.read_with(&v, |s, _| resources::probe(s));
    assert!(probe["remote"]["build-box"].is_null(), "{probe}");
}
