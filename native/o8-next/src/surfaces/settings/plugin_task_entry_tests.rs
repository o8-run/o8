//! MCP entry-point regressions. Headless platform; no simulated input.
use super::*;
use gpui::TestAppContext;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

pub(crate) struct Peer {
    origin: String,
    stop: Arc<AtomicBool>,
    pub(crate) mode: Arc<AtomicUsize>,
    pub(crate) deny_load: Arc<AtomicBool>,
    pub(crate) data: Arc<Mutex<Value>>,
    pub(crate) posts: Arc<Mutex<Vec<Value>>>,
}
impl Peer {
    pub(crate) fn new(attempt: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let mode = Arc::new(AtomicUsize::new(0));
        let deny_load = Arc::new(AtomicBool::new(false));
        let posts = Arc::new(Mutex::new(vec![]));
        let hash = "a".repeat(64);
        let execution = attempt.then(|| {
            json!({"taskId":"task-fixture", "contractHash":hash,
            "attemptId":"attempt-fixture", "state":"accepted", "stopped":false, "completed":false})
        });
        let data = Arc::new(Mutex::new(
            json!({"ok":true,"accountId":"fixture-account","drafts":[{
                "taskId":"task-fixture","contractHash":hash,"sessionCurrent":true,
                "revision":"b".repeat(40),"rulesDigest":"c".repeat(64),"execution":execution,"executionError":null,
                "contract":{"objective":"Read the fixture and report evidence.","runtime":"codex","model":"fixture-model",
                    "effort":"high","workMode":"read-only","machineId":"fixture-machine","projectId":"fixture-project",
                    "repoId":"fixture-repo","allowedFiles":["README.md"],"evidence":["Report its contents."],
                    "sealedTaskContract":{"version":1,"requirements":[{"id":"R1","expectedBehavior":"Read only."}]}}
            }]}),
        ));
        let (worker_mode, worker_deny, worker_data, worker_posts) =
            (mode.clone(), deny_load.clone(), data.clone(), posts.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                };
                let (worker_mode, worker_deny, worker_data, worker_posts) = (
                    worker_mode.clone(), worker_deny.clone(), worker_data.clone(), worker_posts.clone(),
                );
                // Accepted sockets can inherit nonblocking mode on macOS. An idle
                // Settings connection must not stall the task request behind it.
                std::thread::spawn(move || {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut header = vec![];
                    while !header.ends_with(b"\r\n\r\n") {
                        let mut byte = [0];
                        if stream.read_exact(&mut byte).is_err() {
                            return;
                        }
                        header.push(byte[0]);
                    }
                    let header = String::from_utf8(header).unwrap();
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    let mut body = vec![0; length];
                    if stream.read_exact(&mut body).is_err() {
                        return;
                    }
                    let (status, value) = if header.starts_with("GET /api/plugins/task-drafts ") {
                        if worker_deny.load(Ordering::SeqCst) {
                            (403, json!({"error":"account_changed_or_unavailable"}))
                        } else {
                            (200, worker_data.lock().unwrap().clone())
                        }
                    } else if header.starts_with("POST /api/plugins/task-drafts/control ") {
                        let body: Value = serde_json::from_slice(&body).unwrap();
                        worker_posts.lock().unwrap().push(body.clone());
                        match worker_mode.load(Ordering::SeqCst) {
                            0 => (409, json!({"error":"fixture_control_held"})),
                            mode => {
                                let stop = body["action"] == "stop";
                                let receipt = json!({"taskId":body["taskId"],"contractHash":if mode == 2 { json!("wrong") } else { body["contractHash"].clone() },
                                "attemptId":"attempt-fixture","state":if stop { "stopped" } else { "accepted" },"stopped":stop,"completed":false});
                                (200, json!({"ok":true,"execution":receipt}))
                            }
                        }
                    } else {
                        (
                            200,
                            json!({"ok":true,"diagnostics":{},"installed":false,"fileExists":false}),
                        )
                    };
                    let body = value.to_string();
                    let _ = write!(stream, "HTTP/1.1 {} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, body.len(), body);
                });
            }
        });
        Self {
            origin,
            stop,
            mode,
            deny_load,
            data,
            posts,
        }
    }
    pub(crate) fn client(&self) -> Client {
        Client::authenticated(&self.origin, Some("fixture-operator".into())).unwrap()
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

#[gpui::test]
fn mcp_held_task_launch_is_reachable(cx: &mut TestAppContext) {
    let peer = Peer::new(false);
    let (_, cx) = cx.add_window_view(|_, cx| Mcp::new(peer.client(), cx));
    cx.run_until_parked();
    assert!(
        cx.debug_bounds("plugin-task-launch").is_some(),
        "MCP exposes the reviewed launch control"
    );
}
#[gpui::test]
fn mcp_held_task_inspect_is_reachable(cx: &mut TestAppContext) {
    let peer = Peer::new(true);
    let (_, cx) = cx.add_window_view(|_, cx| Mcp::new(peer.client(), cx));
    cx.run_until_parked();
    assert!(
        cx.debug_bounds("plugin-task-inspect").is_some(),
        "MCP exposes persisted attempt inspection"
    );
}
#[gpui::test]
fn mcp_held_task_stop_is_reachable(cx: &mut TestAppContext) {
    let peer = Peer::new(true);
    let (_, cx) = cx.add_window_view(|_, cx| Mcp::new(peer.client(), cx));
    cx.run_until_parked();
    assert!(
        cx.debug_bounds("plugin-task-stop").is_some(),
        "MCP retains the safety-stop control"
    );
}
