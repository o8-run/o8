//! Headless native notice/control regression; no operating-system window or input.
use super::*;
use gpui::{Modifiers, TestAppContext};
use serde_json::json;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

struct Fixture {
    origin: String,
    mode: Arc<AtomicUsize>,
    posts: Arc<Mutex<Vec<Value>>>,
    stop: Arc<AtomicBool>,
}
impl Fixture {
    fn new(status: u16, code: &'static str, lane: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let mode = Arc::new(AtomicUsize::new(0));
        let posts = Arc::new(Mutex::new(vec![]));
        let stop = Arc::new(AtomicBool::new(false));
        let (worker_mode, worker_posts, worker_stop) = (mode.clone(), posts.clone(), stop.clone());
        std::thread::spawn(move || {
            while !worker_stop.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
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
                stream.read_exact(&mut body).unwrap();
                let (status, value) = if header.starts_with("GET ") {
                    (
                        status,
                        json!({"ok":false,"error":{"code":code,"message":"Fixture checkout is absent.","laneId":lane}}),
                    )
                } else {
                    assert!(header.starts_with("POST /api/lanes/discard-orphaned "));
                    worker_posts
                        .lock()
                        .unwrap()
                        .push(serde_json::from_slice(&body).unwrap());
                    if worker_mode.load(Ordering::SeqCst) == 0 {
                        (
                            409,
                            json!({"ok":false,"error":{"code":"worktree_present","message":"Fixture discard refused."}}),
                        )
                    } else {
                        (200, json!({"ok":true,"laneId":lane,"status":"archived"}))
                    }
                };
                let body = value.to_string();
                write!(
                    stream,
                    concat!(
                        "HTTP/1.1 {} Response\r\nContent-Type: application/json\r\n",
                        "Content-Length: {}\r\nConnection: close\r\n\r\n{}"
                    ),
                    status,
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        Self {
            origin,
            mode,
            posts,
            stop,
        }
    }
    fn client(&self) -> Client {
        Client::authenticated(&self.origin, Some("fixture-orphan-operator".into())).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}
#[gpui::test]
fn diff_missing_checkout_notice_and_discard(cx: &mut TestAppContext) {
    let fixture = Fixture::new(409, "worktree_missing", "lane-orphan");
    let (_view, cx) = cx.add_window_view(|window, cx| {
        DiffSurface::new(
            fixture.client(),
            Target::Packet("packet-orphan".into()),
            window,
            cx,
        )
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("diff-missing-checkout").is_some());
    let discard = cx
        .debug_bounds("diff-discard-orphan")
        .expect("explicit orphan discard");
    cx.simulate_click(discard.center(), Modifiers::default());
    assert!(cx.debug_bounds("diff-discard-confirm").is_some());
    assert!(
        fixture.posts.lock().unwrap().is_empty(),
        "opening confirmation is read-only"
    );
}
