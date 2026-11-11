//! Headless native notice/control regression; no operating-system window or input.
use super::*;
use gpui::{KeyDownEvent, Keystroke, TestAppContext};
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
    gets: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
}
impl Fixture {
    fn new(status: u16, code: &'static str, lane: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let mode = Arc::new(AtomicUsize::new(0));
        let posts = Arc::new(Mutex::new(vec![]));
        let gets = Arc::new(Mutex::new(vec![]));
        let stop = Arc::new(AtomicBool::new(false));
        let (worker_mode, worker_posts, worker_stop) = (mode.clone(), posts.clone(), stop.clone());
        let worker_gets = gets.clone();
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
                    worker_gets
                        .lock()
                        .unwrap()
                        .push(header.lines().next().unwrap().into());
                    (
                        status,
                        if code.is_empty() {
                            json!({"diff":"", "headSha":"a".repeat(40)})
                        } else {
                            json!({"ok":false,"error":{"code":code,"message":"Fixture checkout is absent.","laneId":lane}})
                        },
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
            gets,
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
    let (view, cx) = cx.add_window_view(|window, cx| {
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
    let refresh = cx.debug_bounds("diff-refresh").unwrap();
    assert_eq!(
        discard.top(),
        refresh.top(),
        "action belongs in the decision row"
    );
    assert!(discard.size.width < px(180.), "content-width action");
    view.update(cx, |view, cx| view.confirm_missing(true, cx));
    assert!(cx.debug_bounds("diff-discard-confirm").is_some());
    assert!(cx.debug_bounds("diff-discard-cancel").is_some());
    assert!(
        fixture.posts.lock().unwrap().is_empty(),
        "opening confirmation is read-only"
    );
    view.update(cx, |view, cx| {
        assert!(view.cancel_missing(
            &KeyDownEvent {
                keystroke: Keystroke::parse("escape").unwrap(),
                is_held: false,
            },
            cx
        ));
    });
    assert!(cx.debug_bounds("diff-discard-confirm").is_none());
    view.update(cx, |view, cx| {
        view.confirm_missing(true, cx);
        view.confirm_missing(false, cx);
        assert!(
            !view.missing.as_ref().unwrap().confirming,
            "Cancel closes confirmation"
        );
        view.confirm_missing(true, cx);
        view.discard_missing(cx);
        assert!(view.busy);
        view.discard_missing(cx);
        view.confirm_missing(false, cx);
        view.load(cx);
        assert!(
            view.missing.as_ref().unwrap().confirming,
            "busy blocks Cancel and Refresh"
        );
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(!view.busy);
        let state = view.missing.as_ref().unwrap();
        assert!(state.confirming, "failed confirmation offers retry");
        assert_eq!(state.failure.as_deref(), Some("Fixture discard refused."));
        assert!(!state.discarded);
    });
    assert_eq!(
        *fixture.posts.lock().unwrap(),
        vec![json!({"laneId":"lane-orphan"})]
    );
    assert!(cx.debug_bounds("diff-discard-confirm").is_some());
    fixture.mode.store(1, Ordering::SeqCst);
    view.update(cx, |view, cx| view.discard_missing(cx));
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        let state = view.missing.as_ref().unwrap();
        assert!(state.discarded);
        assert!(!state.confirming);
        assert!(state.failure.is_none());
    });
    assert_eq!(fixture.posts.lock().unwrap().len(), 2);
    assert!(cx.debug_bounds("diff-discard-orphan").is_none());
    view.update(cx, |view, cx| view.load(cx));
    cx.run_until_parked();
    assert!(
        cx.debug_bounds("diff-discard-orphan").is_none(),
        "refresh does not reoffer a discarded lane"
    );
}

#[gpui::test]
fn diff_other_refusals_never_offer_discard(cx: &mut TestAppContext) {
    for (status, code, lane) in [
        (403, "worktree_missing", "lane-orphan"),
        (409, "branch_unresolved", "lane-orphan"),
        (409, "immutable_review_unavailable", "lane-orphan"),
        (409, "worktree_missing", ""),
        (200, "worktree_missing", "lane-orphan"),
    ] {
        let fixture = Fixture::new(status, code, lane);
        let (view, cx) = cx.add_window_view(|window, cx| {
            DiffSurface::new(
                fixture.client(),
                Target::Packet("packet-orphan".into()),
                window,
                cx,
            )
        });
        cx.run_until_parked();
        view.read_with(cx, |view, _| {
            assert!(view.failed && view.missing.is_none(), "{status} {code}")
        });
        assert!(cx.debug_bounds("diff-discard-orphan").is_none());
        assert!(fixture.posts.lock().unwrap().is_empty());
    }
}

/// The constructor used by the worker card keeps the ordinary working-diff read,
/// then obtains canonical missing-checkout proof from the recorded lane.
#[gpui::test]
fn diff_missing_checkout_from_worker_inspector(cx: &mut TestAppContext) {
    let fixture = Fixture::new(409, "worktree_missing", "lane-orphan");
    let (view, cx) = cx.add_window_view(|window, cx| {
        DiffSurface::in_lane(
            fixture.client(),
            Target::Worktree {
                path: "/fixture/removed-checkout".into(),
                base: None,
                file: None,
            },
            Some("lane-orphan".into()),
            window,
            cx,
        )
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("diff-missing-checkout").is_some());
    assert!(cx.debug_bounds("diff-discard-orphan").is_some());
    assert!(cx.debug_bounds("diff-approve").is_none());
    let gets = fixture.gets.lock().unwrap().clone();
    assert_eq!(gets.len(), 2);
    assert!(gets[0].starts_with("GET /api/worktrees/diff?"));
    assert!(gets[1].starts_with("GET /api/lanes/lane-orphan/diff?"));
    view.update(cx, |view, cx| {
        view.confirm_missing(true, cx);
        view.discard_missing(cx);
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(
            view.missing.as_ref().unwrap().failure.as_deref(),
            Some("Fixture discard refused.")
        );
    });
    assert_eq!(
        *fixture.posts.lock().unwrap(),
        vec![json!({"laneId":"lane-orphan"})]
    );
}

#[gpui::test]
fn diff_worker_inspector_keeps_successful_working_diff(cx: &mut TestAppContext) {
    let fixture = Fixture::new(200, "", "lane-present");
    let (view, cx) = cx.add_window_view(|window, cx| {
        DiffSurface::in_lane(
            fixture.client(),
            Target::Worktree {
                path: "/fixture/present-checkout".into(),
                base: None,
                file: None,
            },
            Some("lane-present".into()),
            window,
            cx,
        )
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(view.ready && !view.failed && view.missing.is_none())
    });
    assert!(cx.debug_bounds("diff-discard-orphan").is_none());
    let gets = fixture.gets.lock().unwrap();
    assert_eq!(
        gets.len(),
        1,
        "a valid working diff needs no lane proof read"
    );
    assert!(gets[0].starts_with("GET /api/worktrees/diff?"));
}
