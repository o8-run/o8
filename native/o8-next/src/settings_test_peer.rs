//! Disposable HTTP peer for Settings panels whose existing routes are host-owned.
use super::*;
use gpui::{Modifiers, TestAppContext, VisualTestContext};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

type Call = (String, String, Value);
pub(super) struct Peer {
    pub client: Client,
    replies: Arc<Mutex<BTreeMap<String, (u16, Value)>>>,
    calls: Arc<Mutex<Vec<Call>>>,
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}
impl Peer {
    pub fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = Client::new(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        listener.set_nonblocking(true).unwrap();
        let replies = Arc::new(Mutex::new(BTreeMap::from([
            (
                "GET /api/panel/operator-defaults?include=native".into(),
                (
                    200,
                    json!({
                        "values":{"autoTitleInferenceEnabled":true},"sources":{},
                        "settingsToml":{"text":"","revision":"fixture-revision","error":null,"additionalSettingsSet":false}
                    }),
                ),
            ),
            (
                "GET /api/setup/identity".into(),
                (200, json!({"version":"1.2.3"})),
            ),
        ])));
        let calls = Arc::new(Mutex::new(vec![]));
        let stop = Arc::new(AtomicBool::new(false));
        let (responses, requests, stopping) = (replies.clone(), calls.clone(), stop.clone());
        let join = thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                let Ok((mut socket, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                };
                // Accepted sockets can inherit the listener's nonblocking mode on macOS.
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut input = BufReader::new(&mut socket);
                let mut line = String::new();
                if input.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or("").to_owned();
                let path = parts.next().unwrap_or("").to_owned();
                let mut length = 0;
                loop {
                    line.clear();
                    if input.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some((key, value)) = line.split_once(':')
                        && key.eq_ignore_ascii_case("content-length")
                    {
                        length = value.trim().parse::<usize>().unwrap_or(0).min(16384);
                    }
                }
                let mut bytes = vec![0; length];
                let _ = input.read_exact(&mut bytes);
                drop(input);
                let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                requests
                    .lock()
                    .unwrap()
                    .push((method.clone(), path.clone(), body));
                let (status, body) = responses
                    .lock()
                    .unwrap()
                    .get(&format!("{method} {path}"))
                    .cloned()
                    .unwrap_or((404, json!({})));
                let body = body.to_string();
                let _ = write!(
                    socket,
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        Self {
            client,
            replies,
            calls,
            stop,
            join: Some(join),
        }
    }
    pub fn reply(&self, method: &str, path: &str, status: u16, body: Value) {
        self.replies
            .lock()
            .unwrap()
            .insert(format!("{method} {path}"), (status, body));
    }
    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.join.take().unwrap().join().unwrap();
    }
}
pub(super) fn open<'a>(
    peer: &Peer,
    cx: &'a mut TestAppContext,
) -> (Entity<Settings>, &'a mut VisualTestContext) {
    cx.add_window_view(|window, cx| Settings::new(peer.client.clone(), window, cx))
}
// Match shell tests: settle the hitboxes as well as the painted scene.
pub(super) fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
        window.refresh();
        window.draw(cx).clear();
    });
}
#[track_caller]
pub(super) fn wait(
    view: &Entity<Settings>,
    cx: &mut VisualTestContext,
    ready: impl Fn(&Settings) -> bool,
) {
    for _ in 0..50 {
        cx.run_until_parked();
        draw(cx);
        if view.read_with(cx, |s, _| {
            !s.busy && ready(s) && s.painted.get() == s.revision
        }) {
            return;
        }
    }
    panic!("Settings panel response must reach paint");
}
#[track_caller]
pub(super) fn click(cx: &mut VisualTestContext, selector: &'static str) {
    click_mode(cx, selector, true);
}
#[track_caller]
pub(super) fn raw_click(cx: &mut VisualTestContext, selector: &'static str) {
    click_mode(cx, selector, false);
}
#[track_caller]
fn click_mode(cx: &mut VisualTestContext, selector: &'static str, paint_press: bool) {
    draw(cx);
    for _ in 0..30 {
        let bounds = cx
            .debug_bounds(selector)
            .unwrap_or_else(|| panic!("missing {selector}"));
        let scroll_selector = if selector.starts_with("settings-nav-") {
            Some("settings-navigation")
        } else if selector.starts_with("setting-") || selector.starts_with("settings-result-") {
            Some("settings-scroll")
        } else {
            None
        };
        let Some(scroll_selector) = scroll_selector else {
            press(cx, selector, bounds.center(), paint_press);
            return;
        };
        let viewport = cx.debug_bounds(scroll_selector).unwrap();
        if viewport.contains(&bounds.center())
            && bounds.top() >= viewport.top()
            && bounds.bottom() <= viewport.bottom()
        {
            press(cx, selector, bounds.center(), paint_press);
            return;
        }
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: viewport.center(),
            delta: gpui::ScrollDelta::Pixels(gpui::point(
                gpui::px(0.),
                gpui::px(if bounds.bottom() > viewport.bottom() {
                    -200.
                } else {
                    200.
                }),
            )),
            ..Default::default()
        });
        draw(cx);
    }
    panic!("{selector} must scroll into view");
}

// Give focus/pressed-state invalidation a frame before releasing the mouse.
fn press(
    cx: &mut VisualTestContext,
    selector: &'static str,
    position: gpui::Point<gpui::Pixels>,
    paint_press: bool,
) {
    if !paint_press {
        cx.simulate_click(position, Modifiers::default());
        return;
    }
    cx.simulate_event(gpui::MouseMoveEvent {
        position,
        pressed_button: None,
        modifiers: Modifiers::default(),
    });
    draw(cx);
    cx.simulate_event(gpui::MouseDownEvent {
        position,
        button: gpui::MouseButton::Left,
        modifiers: Modifiers::default(),
        click_count: 1,
        first_mouse: false,
    });
    draw(cx);
    if selector == "setting-about-check-updates" {
        assert_eq!(
            cx.debug_bounds(selector).unwrap().center(),
            position,
            "update check must not move during a press"
        );
    }
    cx.simulate_event(gpui::MouseUpEvent {
        position,
        button: gpui::MouseButton::Left,
        modifiers: Modifiers::default(),
        click_count: 1,
    });
}
