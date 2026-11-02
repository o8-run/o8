//! Slow and failed first loads through the production offscreen shell.
use super::test_support::{draw, open};
use super::*;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Instant,
};

struct Server {
    origin: String,
    stop: Arc<AtomicBool>,
    failing: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(mode: &str, route: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let failing = Arc::new(AtomicBool::new(mode == "fail"));
        let outage = failing.clone();
        let mode = mode.to_owned();
        let route = route.to_owned();
        let join = thread::spawn(move || {
            let mut workers = vec![];
            while !stopping.load(Ordering::SeqCst) {
                let Ok((mut socket, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                let stop = stopping.clone();
                let failing = outage.clone();
                let mode = mode.clone();
                let route = route.clone();
                workers.push(thread::spawn(move || {
                    socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                    let mut request = [0; 4096];
                    let n = socket.read(&mut request).unwrap_or(0);
                    let request = String::from_utf8_lossy(&request[..n]);
                    let path = request.split_whitespace().nth(1).unwrap_or("").split('?').next().unwrap_or("");
                    if path == "/api/panel/ws-info" {
                        let _ = socket.write_all(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
                        return;
                    }
                    if path == route {
                        if failing.load(Ordering::SeqCst) {
                            let _ = socket.write_all(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
                            return;
                        }
                        if mode == "body" {
                            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{");
                        }
                        let delay = match mode.as_str() { "slow" => 30, "hang" | "body" => 60, _ => 0 };
                        let deadline = Instant::now() + Duration::from_secs(delay);
                        while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
                            thread::sleep(Duration::from_millis(10));
                        }
                        if stop.load(Ordering::SeqCst) { return; }
                    }
                    let body = match path {
                        "/api/mobile/orchestrator/threads" => json!({"threads":[]}),
                        "/api/orchestrator/state" => json!({"mission":{"packets":[]}}),
                        "/api/runtime/inventory" => json!({"agents":[]}),
                        "/api/v2/chat-history/list" => json!({"conversations":[]}),
                        "/api/panel/repos" => json!({"repos":[]}),
                        "/api/panel/projects" => json!({"projects":[],"activeProjectId":"default"}),
                        _ => json!({}),
                    }.to_string();
                    let _ = write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                }));
            }
            for worker in workers {
                let _ = worker.join();
            }
        });
        Self {
            origin,
            stop,
            failing,
            join: Some(join),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.join.take().unwrap().join().unwrap();
    }
}

#[test]
fn fast_first_load_keeps_the_painted_window() {
    run_case("fast");
}
#[test]
fn thirty_second_first_load_keeps_the_painted_window() {
    run_case("slow");
}
#[test]
fn failed_first_load_keeps_retry() {
    run_case("fail");
}
#[test]
fn failed_project_load_keeps_retry() {
    run_case("project-fail");
}
fn run_case(mode: &str) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "shell::startup_tests::first_load_probe",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("O8_NEXT_STARTUP_CASE", mode)
        .env("O8_NEXT_PARENT_PIPE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let stdout = child.stdout.take().unwrap();
    let reader = thread::spawn(move || {
        let mut lines = vec![];
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.ends_with("o8-next-ready") {
                let _ = tx.send(());
            }
            lines.push(line);
        }
        lines.join("\n")
    });
    let ready = rx.recv_timeout(Duration::from_secs(15));
    let status = child.wait().unwrap();
    let output = reader.join().unwrap();
    let mut errors = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut errors)
        .unwrap();
    assert!(
        ready.is_ok(),
        "{mode}: the first painted window must report ready before the parent's deadline\n{output}\n{errors}"
    );
    assert!(status.success(), "{mode}: {output}\n{errors}");
    assert!(
        output.contains("1 passed"),
        "the child must execute its assertion"
    );
    assert_eq!(
        output
            .lines()
            .filter(|line| line.ends_with("o8-next-ready"))
            .count(),
        1,
        "only the first paint signals readiness, including after Retry"
    );
    println!("{mode}: {output}");
}

#[gpui::test]
#[ignore = "owned child of run_case"]
fn first_load_probe(cx: &mut gpui::TestAppContext) {
    let mode = std::env::var("O8_NEXT_STARTUP_CASE").unwrap();
    let route = if mode == "project-fail" {
        "/api/panel/projects"
    } else {
        "/api/mobile/orchestrator/threads"
    };
    let server = Server::new(
        if mode == "project-fail" {
            "fail"
        } else {
            &mode
        },
        route,
    );
    let root = std::env::temp_dir().join(format!("o8-startup-probe-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let started = Instant::now();
    let (shell, mut visual) = open(
        Client::authenticated(&server.origin, None).unwrap(),
        root.join("shell.json"),
        State::default(),
        cx,
    );
    draw(&mut visual);
    let window = started.elapsed();
    assert!(shell.read_with(&visual, |s, _| s.loading && !s.connected));
    assert!(shell.read_with(&visual, |s, _| s.notice.contains("Connecting")));
    println!("window-ms={:.1}", window.as_secs_f64() * 1000.);
    settled(&shell, &mut visual);
    if mode == "fail" || mode == "project-fail" {
        // The connection surface owns its error label. Startup requires a
        // retained error state and Retry; named request failures are checked below.
        assert!(
            shell.read_with(&visual, |s, _| !s.loading
                && !s.connected
                && !s.notice.trim().is_empty()),
            "first load state: {:?}",
            shell.read_with(&visual, |s, _| (s.loading, s.connected, s.notice.clone()))
        );
        let retry = visual
            .debug_bounds("shell-retry")
            .expect("failed first load keeps Retry in the painted window");
        server.failing.store(false, Ordering::SeqCst);
        visual.simulate_click(retry.center(), gpui::Modifiers::default());
        settled(&shell, &mut visual);
    }
    assert!(
        shell.read_with(&visual, |s, _| s.connected
            && !s.loading
            && s.notice.is_empty()),
        "first load or Retry must complete in the original shell"
    );
    assert!(shell.read_with(&visual, |s, _| s.painted.get() != u64::MAX));
    println!(
        "window-to-load-ms={:.1}",
        (started.elapsed() - window).as_secs_f64() * 1000.
    );
    assert!(
        root.join("shell.json").exists(),
        "successful load persists state"
    );
    assert!(visual.simulate_close());
    std::fs::remove_dir_all(root).unwrap();
}

fn settled(shell: &Entity<Shell>, visual: &mut gpui::VisualTestContext) {
    let deadline = Instant::now() + Duration::from_secs(50);
    loop {
        visual.run_until_parked();
        draw(visual);
        if shell.read_with(visual, |s, _| !s.loading) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "first load must settle before its deadline"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn client_startup_requests_have_named_bounded_failures() {
    let mut jobs = vec![];
    for path in [
        "/api/mobile/orchestrator/threads",
        "/api/orchestrator/state",
        "/api/runtime/inventory",
        "/api/v2/chat-history/list",
        "/api/panel/repos",
        "/api/panel/projects",
    ] {
        for mode in ["hang", "body"] {
            jobs.push(thread::spawn(move || {
                let server = Server::new(mode, path);
                let client = Client::authenticated(&server.origin, None).unwrap();
                let started = Instant::now();
                let error = client.get::<Value>(path, &[]).unwrap_err();
                assert!(
                    started.elapsed() < Duration::from_secs(55),
                    "request must have a bounded deadline"
                );
                assert!(
                    error.contains(path) && error.contains("timed out"),
                    "{mode} {path}: {error}"
                );
            }));
        }
    }
    for job in jobs {
        job.join().unwrap();
    }
}
