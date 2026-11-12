//! Prompt navigation through painted chat and saved worker/reviewer transcripts.
use super::*;
use crate::pane::Pane;
use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};

fn paint(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|w, cx| {
        w.refresh();
        w.draw(cx).clear();
    });
}
fn history(prefix: &str, count: usize) -> crate::model::History {
    let mut entries = Vec::new();
    for i in 0..count {
        entries.push(json!({"id":format!("{prefix}-p{i}"),"role":"user","text":format!("Review **prompt {i}**\nnext line {}", "long title ".repeat(70)),"packetHeader":{"enabled":i==0}}));
        entries.push(json!({"id":format!("{prefix}-note{i}"),"role":"assistant","text":"Early commentary, not the final answer."}));
        entries.push(json!({"id":format!("{prefix}-a{i}"),"role":"assistant","text":format!("**Final answer {i}** with useful detail.\n\n{}", "More answer detail.\n\n".repeat(40))}));
    }
    serde_json::from_value(
        json!({"sessionKey":format!("codex-owned:{prefix}"),"transcript":entries}),
    )
    .unwrap()
}
fn pane(prefix: &str, count: usize) -> Pane {
    let mut pane = Pane::new(Some(format!("codex-owned:{prefix}")));
    pane.install_saved(history(prefix, count));
    pane.navigate(false);
    pane
}
struct Reading(Pane, Option<Pane>);
impl Render for Reading {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .w(px(1000.))
            .h(px(400.))
            .flex()
            .child(
                div()
                    .w(px(490.))
                    .h_full()
                    .flex()
                    .flex_col()
                    .child(self.0.content()),
            )
            .children(self.1.as_ref().map(|p| {
                div()
                    .w(px(490.))
                    .h_full()
                    .flex()
                    .flex_col()
                    .child(p.content())
            }))
    }
}
fn row(pane: &Pane, id: &str) -> usize {
    pane.rows
        .iter()
        .position(|r| r.borrow().row.id() == id)
        .unwrap()
}
fn at_prompt(view: &Entity<Reading>, id: &str, cx: &mut VisualTestContext) {
    view.read_with(cx, |v, _| {
        let index = row(&v.0, id);
        assert_eq!(v.0.list.logical_scroll_top().item_ix, index);
        assert_eq!(v.0.list.logical_scroll_top().offset_in_item, px(0.));
        assert!(
            v.0.rows[index]
                .borrow()
                .painted_geometry
                .borrow()
                .row
                .origin
                .y
                .abs()
                < px(1.)
        );
    });
}
#[gpui::test]
fn tick_count_tracks_prompts_and_hides_short_transcripts(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|_, _| Reading(pane("count", 1), None));
    paint(cx);
    assert!(cx.debug_bounds("prompt-nav-tick-count-p0").is_none());
    view.update(cx, |v, cx| {
        v.0.install_saved(history("count", 3));
        cx.notify();
    });
    paint(cx);
    for selector in [
        "prompt-nav-tick-count-p0",
        "prompt-nav-tick-count-p1",
        "prompt-nav-tick-count-p2",
    ] {
        assert!(
            cx.debug_bounds(selector).is_some(),
            "one tick per prompt, including the packet header"
        );
    }
    assert!(cx.debug_bounds("prompt-nav-tick-count-p3").is_none());
}
#[gpui::test]
fn wheel_scrolling_marks_the_prompt_in_view(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|_, _| Reading(pane("scroll", 3), None));
    paint(cx);
    assert!(cx.debug_bounds("prompt-nav-current-scroll-p0").is_some());
    for _ in 0..8 {
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: point(px(300.), px(200.)),
            delta: gpui::ScrollDelta::Pixels(point(px(0.), px(-400.))),
            ..Default::default()
        });
        paint(cx);
    }
    let current = view.read_with(cx, |v, _| {
        let top = v.0.list.logical_scroll_top().item_ix;
        (0..3)
            .rev()
            .find(|i| row(&v.0, &format!("scroll-p{i}")) <= top)
            .unwrap()
    });
    assert!(current > 0, "the wheel actually moved to a later turn");
    assert!(
        cx.debug_bounds(
            [
                "prompt-nav-current-scroll-p0",
                "prompt-nav-current-scroll-p1",
                "prompt-nav-current-scroll-p2"
            ][current]
        )
        .is_some()
    );
    assert!(cx.debug_bounds("prompt-nav-current-scroll-p0").is_none());
}
#[gpui::test]
fn hover_and_keyboard_focus_show_compact_prompt_and_final_answer(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|_, _| Reading(pane("preview", 3), None));
    paint(cx);
    let tick = cx
        .debug_bounds("prompt-nav-tick-preview-p1")
        .expect("a native prompt tick");
    cx.simulate_mouse_move(tick.center(), None, Modifiers::default());
    paint(cx);
    let (title, answer) = view
        .read_with(cx, |v, _| v.0.navigator.borrow().cached_preview())
        .expect("the real preview card is rendered");
    assert!(title.starts_with("Review prompt 1 next line "));
    assert!(!title.contains('\n'));
    assert!(
        title.ends_with('…'),
        "bounded long titles retain an ellipsis"
    );
    assert!(answer.starts_with("Final answer 1 with useful detail."));
    assert!(!answer.contains("Early commentary"));
    let title_bounds = cx.debug_bounds("prompt-nav-preview-title").unwrap();
    let answer_bounds = cx.debug_bounds("prompt-nav-preview-answer").unwrap();
    assert!(title_bounds.size.height >= px(17.) && title_bounds.size.height <= px(19.));
    assert!(answer_bounds.size.height >= px(18.) && answer_bounds.size.height <= px(36.));
    assert!(cx.debug_bounds("prompt-nav-preview").unwrap().size.height <= px(80.));
    cx.simulate_click(tick.center(), Modifiers::default());
    cx.simulate_mouse_move(point(px(300.), px(350.)), None, Modifiers::default());
    cx.simulate_keystrokes("home");
    paint(cx);
    assert!(
        view.read_with(cx, |v, _| v
            .0
            .navigator
            .borrow()
            .cached_preview()
            .unwrap()
            .0
            .starts_with("Review prompt 0")),
        "keyboard focus has the same preview"
    );
    let title = view.read_with(cx, |v, _| {
        v.0.navigator.borrow().cached_preview().unwrap().0
    });
    for _ in 0..8 {
        paint(cx);
    }
    let cached = view.read_with(cx, |v, _| {
        v.0.navigator.borrow().cached_preview().unwrap().0
    });
    assert_eq!(
        title.as_ptr(),
        cached.as_ptr(),
        "unchanged packet-header previews reuse their parsed text"
    );
}
#[gpui::test]
fn click_and_enter_jump_instantly_without_scrolling_another_pane(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|_, _| Reading(pane("jump", 3), Some(pane("other", 3))));
    paint(cx);
    let other = view.read_with(cx, |v, _| v.1.as_ref().unwrap().list.logical_scroll_top());
    let tick = cx
        .debug_bounds("prompt-nav-tick-jump-p1")
        .expect("a native prompt tick");
    cx.simulate_click(tick.center(), Modifiers::default());
    paint(cx);
    at_prompt(&view, "jump-p1", cx);
    cx.simulate_keystrokes("end enter");
    paint(cx);
    at_prompt(&view, "jump-p2", cx);
    cx.simulate_keystrokes("up enter");
    paint(cx);
    at_prompt(&view, "jump-p1", cx);
    view.read_with(cx, |v, _| {
        let now = v.1.as_ref().unwrap().list.logical_scroll_top();
        assert_eq!(
            (now.item_ix, now.offset_in_item),
            (other.item_ix, other.offset_in_item)
        );
    });
}
#[gpui::test]
fn chat_keyboard_jump_cancels_following_the_live_turn(cx: &mut TestAppContext) {
    let client = Client::authenticated("http://127.0.0.1:1", None).unwrap();
    let (view, cx) = cx.add_window_view(|w, cx| Surface::new(client, w, cx));
    view.update(cx, |s, cx| {
        let mut h = history("chat", 3);
        h.session_key = "llm-chat:navigator".into();
        for entry in &mut h.transcript {
            entry.text = if entry.role == "user" {
                "Short question"
            } else {
                "Short answer"
            }
            .into();
        }
        let transcript = Transcript::new(h);
        let rows = transcript.rows.clone();
        s.transcript = Some(transcript);
        s.install_rows(rows, cx);
        s.following = Some(0);
        s.pinned = true;
        cx.notify();
    });
    paint(cx);
    assert!(cx.debug_bounds("prompt-nav-tick-chat-p0").is_some());
    view.read_with(cx, |s, _| {
        assert!(s.following.is_some());
        assert!(s.pinned);
    });
    cx.simulate_keystrokes("tab end enter");
    paint(cx);
    view.read_with(cx, |s, _| {
        assert!(s.following.is_none());
        assert!(!s.pinned);
        assert_eq!(
            s.list.logical_scroll_top().item_ix,
            s.rows
                .iter()
                .position(|r| r.borrow().row.id() == "chat-p2")
                .unwrap()
        );
        assert_eq!(s.list.logical_scroll_top().offset_in_item, px(0.));
    });
}

#[gpui::test]
fn a_short_final_turn_can_put_its_prompt_at_the_top(cx: &mut TestAppContext) {
    let mut history = history("short", 3);
    for entry in &mut history.transcript {
        entry.text = if entry.role == "user" {
            "Short question"
        } else {
            "Short answer"
        }
        .into();
    }
    let mut pane = Pane::new(Some("codex-owned:short".into()));
    pane.install_saved(history);
    pane.navigate(false);
    let (view, cx) = cx.add_window_view(|_, _| Reading(pane, None));
    paint(cx);
    let original_end = view.read_with(cx, |v, _| v.0.list.max_offset_for_scrollbar().height);
    let tick = cx
        .debug_bounds("prompt-nav-tick-short-p2")
        .expect("the last prompt's tick");
    cx.simulate_click(tick.center(), Modifiers::default());
    paint(cx);
    at_prompt(&view, "short-p2", cx);
    view.update(cx, |v, cx| {
        v.0.navigate(true);
        cx.notify();
    });
    paint(cx);
    assert_eq!(
        view.read_with(cx, |v, _| v.0.list.max_offset_for_scrollbar().height),
        original_end,
        "returning to the end restores normal transcript spacing"
    );
}

#[gpui::test]
fn clicking_and_escape_dismiss_the_preview(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Reading(pane("dismiss", 3), None));
    paint(cx);
    let tick = cx.debug_bounds("prompt-nav-tick-dismiss-p1").unwrap();
    cx.simulate_mouse_move(tick.center(), None, Modifiers::default());
    paint(cx);
    assert!(cx.debug_bounds("prompt-nav-preview").is_some());
    cx.simulate_click(tick.center(), Modifiers::default());
    paint(cx);
    assert!(
        cx.debug_bounds("prompt-nav-preview").is_none(),
        "a jump uncovers the transcript"
    );
    cx.simulate_keystrokes("up");
    paint(cx);
    assert!(
        cx.debug_bounds("prompt-nav-preview").is_some(),
        "keyboard selection previews again"
    );
    cx.simulate_keystrokes("escape");
    paint(cx);
    assert!(cx.debug_bounds("prompt-nav-preview").is_none());
    cx.simulate_keystrokes("down enter");
    paint(cx);
    assert!(cx.debug_bounds("prompt-nav-preview").is_none());
}

#[gpui::test]
fn a_dense_rail_pages_bounded_ticks_and_reaches_every_prompt(cx: &mut TestAppContext) {
    let mut h = history("dense", 300);
    for entry in &mut h.transcript {
        entry.text = if entry.role == "user" {
            format!("Short prompt {}", entry.id)
        } else {
            "Short answer".into()
        };
    }
    // A large retained thread includes explicitly loaded older pages. Legacy
    // live windows keep their existing 200-entry bound.
    let split = h.transcript.len() - 100;
    let older = crate::model::History {
        session_key: h.session_key.clone(),
        transcript: h.transcript.drain(..split).collect(),
        page: None,
    };
    let mut p = Pane::new(None);
    p.install_saved(h);
    p.prepend(older);
    p.navigate(false);
    let (view, cx) = cx.add_window_view(|_, _| Reading(p, None));
    paint(cx);
    assert!(
        cx.debug_bounds("prompt-nav-tick-dense-p0")
            .unwrap()
            .size
            .height
            >= px(10.),
        "ticks remain usable in long histories"
    );
    assert!(
        cx.debug_bounds("prompt-nav-tick-dense-p24").is_none(),
        "the rail virtualizes, rather than constructing every prompt element"
    );
    let later = cx
        .debug_bounds("prompt-nav-later")
        .expect("later prompts remain reachable by mouse");
    cx.simulate_click(later.center(), Modifiers::default());
    paint(cx);
    assert!(cx.debug_bounds("prompt-nav-tick-dense-p24").is_some());
    assert!(cx.debug_bounds("prompt-nav-tick-dense-p0").is_none());
    cx.simulate_keystrokes("down");
    paint(cx);
    assert_eq!(
        view.read_with(cx, |v, _| v
            .0
            .navigator
            .borrow()
            .cached_preview()
            .unwrap()
            .0)
            .as_ref(),
        "Short prompt dense-p25",
        "keyboard selection continues from the displayed page"
    );
    let earlier = cx.debug_bounds("prompt-nav-earlier").unwrap();
    cx.simulate_click(earlier.center(), Modifiers::default());
    paint(cx);
    assert!(cx.debug_bounds("prompt-nav-tick-dense-p0").is_some());
    cx.simulate_keystrokes("end");
    paint(cx);
    assert!(
        cx.debug_bounds("prompt-nav-tick-dense-p299").is_some(),
        "keyboard selection can reach the last prompt"
    );
    cx.simulate_keystrokes("enter");
    paint(cx);
    at_prompt(&view, "dense-p299", cx);
}

#[gpui::test]
fn loading_a_different_live_session_resets_navigation(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|_, _| Reading(pane("old", 3), None));
    paint(cx);
    let tick = cx.debug_bounds("prompt-nav-tick-old-p1").unwrap();
    cx.simulate_click(tick.center(), Modifiers::default());
    paint(cx);
    assert!(view.read_with(cx, |v, _| v.0.navigator.borrow().is_aligned()));
    view.update(cx, |v, cx| {
        v.0.install(
            history("replacement", 3),
            Client::authenticated("http://127.0.0.1:1", None).unwrap(),
        );
        cx.notify();
    });
    paint(cx);
    view.read_with(cx, |v, _| {
        assert!(!v.0.navigator.borrow().is_aligned());
        assert_eq!(v.0.navigator.borrow().bottom_space(px(400.)), px(0.));
        assert_eq!(v.0.list.logical_scroll_top().item_ix, 0);
    });
    assert!(cx.debug_bounds("prompt-nav-tick-replacement-p0").is_some());
    assert!(cx.debug_bounds("prompt-nav-tick-old-p1").is_none());
}

#[gpui::test]
fn wheel_down_over_the_rail_keeps_chat_following(cx: &mut TestAppContext) {
    let client = Client::authenticated("http://127.0.0.1:1", None).unwrap();
    let (view, cx) = cx.add_window_view(|w, cx| Surface::new(client, w, cx));
    view.update(cx, |s, cx| {
        let mut h = history("wheel", 3);
        h.session_key = "llm-chat:wheel".into();
        let transcript = Transcript::new(h);
        let rows = transcript.rows.clone();
        s.transcript = Some(transcript);
        s.install_rows(rows, cx);
        cx.notify();
    });
    paint(cx);
    view.update(cx, |s, cx| {
        s.following = Some(0);
        s.pinned = true;
        s.follow_frame();
        cx.notify();
    });
    paint(cx);
    let rail = cx.debug_bounds("prompt-navigator").unwrap();
    cx.simulate_event(gpui::ScrollWheelEvent {
        position: rail.center(),
        delta: gpui::ScrollDelta::Pixels(point(px(0.), px(-100.))),
        ..Default::default()
    });
    paint(cx);
    view.read_with(cx, |s, _| {
        assert!(
            s.following.is_some(),
            "scrolling farther down at the end preserves following"
        );
        assert!(!s.away_from_end);
    });
    cx.simulate_event(gpui::ScrollWheelEvent {
        position: rail.center(),
        delta: gpui::ScrollDelta::Pixels(point(px(0.), px(400.))),
        ..Default::default()
    });
    paint(cx);
    view.read_with(cx, |s, _| {
        assert!(s.following.is_none());
        assert!(s.away_from_end);
    });
}

struct LiveHost {
    client: Client,
    events: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    stopped: std::sync::Arc<std::sync::atomic::AtomicBool>,
    server: Option<std::thread::JoinHandle<()>>,
}
impl LiveHost {
    fn new() -> Self {
        use std::{
            io::{Read, Write},
            sync::{
                Arc, Mutex,
                atomic::{AtomicBool, Ordering},
            },
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let client =
            Client::authenticated(&format!("http://{}", listener.local_addr().unwrap()), None)
                .unwrap();
        let events = Arc::new(Mutex::new(vec![
            json!({"seq":1,"type":"assistant","text":"Reading the patch."}),
        ]));
        let recorded = events.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let server = std::thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                let mut stream = match listener.accept() {
                    Ok((s, _)) => s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::park_timeout(std::time::Duration::from_millis(1));
                        continue;
                    }
                    Err(e) => panic!("live fixture accept: {e}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut buf = [0; 8192];
                let n = stream.read(&mut buf).unwrap();
                let request = String::from_utf8_lossy(&buf[..n]);
                // Exercise active HTTP fallback when a fixture has no socket.
                let socket_info = request.contains("/api/panel/ws-info");
                let body=if socket_info { json!({"error":"this fixture has no socket"})
                } else if request.contains("/api/mobile/history") {
                    json!({"sessionKey":"codex-owned:live-nav","transcript":[
                        {"id":"live-p0","role":"user","text":"First **prompt**","packetHeader":{"enabled":true}},
                        {"id":"live-p1","role":"user","text":"Second prompt"}]})
                } else {
                    assert!(request.contains("/api/orchestrator/packet-transcript"));
                    let cursor=request.split("cursor=").nth(1).and_then(|s|s.split(['&',' ']).next()).unwrap().parse::<u64>().unwrap();
                    let page:Vec<_>=recorded.lock().unwrap().iter().filter(|e| e["seq"].as_u64().unwrap()>cursor).cloned().collect();
                    json!({"sessionKey":"codex-owned:live-nav","nextCursor":page.last().map(|e|e["seq"].clone()),"events":page})
                }.to_string();
                let status = if socket_info {
                    "404 Not Found"
                } else {
                    "200 OK"
                };
                write!(stream,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        Self {
            client,
            events,
            stopped,
            server: Some(server),
        }
    }
}
impl Drop for LiveHost {
    fn drop(&mut self) {
        self.stopped
            .store(true, std::sync::atomic::Ordering::Release);
        let result = self.server.take().unwrap().join();
        if !std::thread::panicking() {
            result.unwrap();
        }
    }
}

#[gpui::test]
fn a_prompt_arriving_in_a_live_pane_updates_ticks_and_preserves_cached_text(
    cx: &mut TestAppContext,
) {
    let host = LiveHost::new();
    let history = host.client.history("codex-owned:live-nav").unwrap();
    let mut pane = Pane::new(Some(history.session_key.clone()));
    pane.install(history, host.client.clone());
    let (view, cx) = cx.add_window_view(|_, _| Reading(pane, None));
    paint(cx);
    let first = cx.debug_bounds("prompt-nav-tick-live-p0").unwrap();
    cx.simulate_mouse_move(first.center(), None, Modifiers::default());
    paint(cx);
    let cached = view.read_with(cx, |v, _| {
        v.0.navigator.borrow().cached_preview().unwrap().0
    });
    host.events.lock().unwrap().extend([
        json!({"seq":2,"type":"assistant","text":"The first check passed."}),
        json!({"seq":3,"type":"steer","text":"New live prompt"}),
        json!({"seq":4,"type":"assistant","text":"The new answer is ready."}),
        json!({"seq":5,"type":"done","exitCode":0}),
    ]);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        view.update(cx, |v, cx| {
            if v.0.poll() {
                cx.notify();
            }
        });
        paint(cx);
        if cx
            .debug_bounds("prompt-nav-tick-codex-owned:live-nav:event:3")
            .is_some()
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the live HTTP cursor update reaches the painted pane"
        );
        std::thread::park_timeout(std::time::Duration::from_millis(10));
    }
    let after = view.read_with(cx, |v, _| {
        v.0.navigator.borrow().cached_preview().unwrap().0
    });
    assert_eq!(
        cached.as_ptr(),
        after.as_ptr(),
        "new work elsewhere does not reparse an unchanged packet header"
    );
    let tick = cx
        .debug_bounds("prompt-nav-tick-codex-owned:live-nav:event:3")
        .unwrap();
    cx.simulate_mouse_move(tick.center(), None, Modifiers::default());
    paint(cx);
    let (title, answer) =
        view.read_with(cx, |v, _| v.0.navigator.borrow().cached_preview().unwrap());
    assert_eq!(title.as_ref(), "New live prompt");
    assert_eq!(answer.as_ref(), "The new answer is ready.");
}
