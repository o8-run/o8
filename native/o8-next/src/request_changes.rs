//! Manual saved-review delivery uses the same route and record as the review loop.
use crate::{client::Client, composer::Composer, theme::current as theme};
use gpui::{Context, Entity, FocusHandle, KeyDownEvent, Render, Window, div, prelude::*, px};
use serde_json::{Value, json};

pub(crate) struct RequestChanges {
    client: Client,
    packet: String,
    availability: Value,
    input: Entity<Composer>,
    focus: [FocusHandle; 3],
    open: bool,
    loading: bool,
    busy: bool,
    notice: String,
    failed: bool,
    // A transport retry keeps the exact review, run and note that may have landed.
    pending: Option<Value>,
}
impl RequestChanges {
    pub(crate) fn new(client: Client, packet: String, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            let mut input = Composer::new(cx);
            input.newline_on_enter = true;
            input.placeholder = "Add a note to the saved findings (optional)".into();
            input
        });
        let mut view = Self {
            client,
            packet,
            input,
            focus: [cx.focus_handle(), cx.focus_handle(), cx.focus_handle()],
            availability: Value::Null,
            open: false,
            loading: false,
            busy: false,
            notice: String::new(),
            failed: false,
            pending: None,
        };
        view.refresh(cx);
        view
    }
    pub(crate) fn editing(&self, window: &Window, cx: &gpui::App) -> bool {
        self.open && self.input.read(cx).focus.is_focused(window)
    }
    pub(crate) fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.loading || self.pending.is_some() {
            return;
        }
        self.loading = true;
        let client = self.client.clone();
        let packet = self.packet.clone();
        let task = cx.background_executor().spawn(async move {
            client.activity_request(
                "GET",
                "/api/orchestrator/worker-corrections",
                &[("packetId", &packet)],
                None,
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                s.loading = false;
                match result {
                    Ok(value) => {
                        s.availability = value["reviewCorrection"].clone();
                        s.notice.clear();
                        s.failed = false;
                    }
                    Err(error) => {
                        s.availability = Value::Null;
                        s.notice = error.message;
                        s.failed = true;
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn send(&mut self, cx: &mut Context<Self>) {
        if self.busy
            || self.loading
            || (self.pending.is_none() && self.availability["available"] != true)
        {
            return;
        }
        let body = self.pending.get_or_insert_with(|| json!({
            "repoPath": self.availability["repoPath"], "threadId": self.availability["threadId"],
            "review": self.availability["review"], "note": self.input.read(cx).text.trim(),
        })).clone();
        self.busy = true;
        self.failed = false;
        self.notice = "Sending findings to the original author…".into();
        let client = self.client.clone();
        let packet = self.packet.clone();
        let task = cx.background_executor().spawn(async move {
            let result = client.activity_request(
                "POST",
                "/api/orchestrator/worker-corrections",
                &[],
                Some(&body),
            );
            let availability = if result
                .as_ref()
                .is_err_and(|error| error.status == Some(409))
            {
                client
                    .activity_request(
                        "GET",
                        "/api/orchestrator/worker-corrections",
                        &[("packetId", packet.as_str())],
                        None,
                    )
                    .ok()
            } else {
                None
            };
            (result, availability)
        });
        cx.spawn(async move |this, cx| {
            let (result, availability) = task.await;
            let _ = this.update(cx, |s, cx| {
                s.busy = false;
                match result {
                    Ok(value) => {
                        let delivery = &value["receipt"]["deliveries"][0];
                        let delivered = delivery["status"] == "delivered";
                        s.notice = delivery["note"]
                            .as_str()
                            .unwrap_or(
                                "Delivery outcome unknown. Inspect the author before retrying.",
                            )
                            .into();
                        s.failed = !delivered;
                        s.availability = json!({"available": false, "reason": s.notice, "receipt": value["receipt"]});
                        s.pending = None;
                        if delivered {
                            s.input.update(cx, |input, cx| input.set_text("", cx));
                            s.open = false;
                        }
                    }
                    Err(error) => {
                        s.failed = true;
                        s.notice = error.message.clone();
                        // A route refusal is authoritative. Network failures remain retryable
                        // with the original immutable body, even if the note is edited.
                        if error.status == Some(409) {
                            s.availability = availability
                                .map(|value| value["reviewCorrection"].clone())
                                .unwrap_or_else(
                                    || json!({"available": false, "reason": error.message}),
                                );
                            s.pending = None;
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}
fn button(id: &'static str, title: &'static str, enabled: bool) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .px(px(8.))
        .py(px(4.))
        .rounded(px(5.))
        .text_size(px(12.))
        .bg(theme().surface_raised)
        .opacity(if enabled { 1. } else { 0.5 })
        .when(enabled, |button| {
            button
                .cursor_pointer()
                .hover(|s| s.bg(theme().selection))
                .active(|s| s.bg(theme().selection))
        })
        .child(title)
}
impl Render for RequestChanges {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let enabled = !self.loading
            && !self.busy
            && (self.availability["available"] == true || self.pending.is_some());
        let reason = self.availability["reason"]
            .as_str()
            .unwrap_or("")
            .to_string();
        div().flex().flex_col().gap(px(6.)).min_w_0().debug_selector(|| "request-changes".into())
            .capture_key_down(cx.listener(move |s, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "tab" {
                    let mut stops = vec![];
                    if enabled { stops.push(s.focus[0].clone()); }
                    if !s.busy && !s.loading && s.pending.is_none() { stops.push(s.focus[1].clone()); }
                    if s.open && !s.busy && s.pending.is_none() { stops.push(s.input.read(cx).focus.clone()); }
                    if s.open && enabled { stops.push(s.focus[2].clone()); }
                    if !stops.is_empty() {
                        let current = stops.iter().position(|focus| focus.is_focused(window));
                        if current.is_some_and(|i| (event.keystroke.modifiers.shift && i == 0) || (!event.keystroke.modifiers.shift && i + 1 == stops.len())) { return; }
                        let next = if event.keystroke.modifiers.shift { current.unwrap_or(0).wrapping_add(stops.len() - 1) % stops.len() } else { current.map_or(0, |i| (i + 1) % stops.len()) };
                        stops[next].focus(window); cx.stop_propagation();
                    }
                } else if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    if enabled && s.focus[2].is_focused(window) { s.send(cx); cx.stop_propagation(); }
                    else if enabled && s.focus[0].is_focused(window) { s.open = true; s.input.read(cx).focus.focus(window); cx.notify(); cx.stop_propagation(); }
                    else if s.focus[1].is_focused(window) { s.refresh(cx); cx.stop_propagation(); }
                }
            }))
            .child(div().flex().flex_wrap().gap(px(6.))
                .child(button("request-changes-open", if self.loading { "Checking author…" } else if self.busy { "Sending findings…" } else { "Request changes" }, enabled).track_focus(&self.focus[0])
                    .when(self.focus[0].is_focused(window), |b| b.bg(theme().selection))
                    .when(enabled, |b| b.on_click(cx.listener(|s, _, window, cx| { s.open = true; s.input.read(cx).focus.focus(window); cx.notify(); }))))
                .when(!self.loading && !self.busy && self.pending.is_none(), |bar| bar.child(
                    button("request-changes-refresh", "Check author again", true).track_focus(&self.focus[1])
                    .when(self.focus[1].is_focused(window), |b| b.bg(theme().selection)).on_click(cx.listener(|s, _, _, cx| s.refresh(cx))))))
            .when(self.open, |view| view
                .when(!self.busy && self.pending.is_none(), |view| view.child(self.input.clone()))
                .when(self.pending.is_some(), |view| view.child(div().text_size(px(11.)).child(format!("Retry sends the original note and saved review. Note: {}", self.pending.as_ref().and_then(|p| p["note"].as_str()).unwrap_or("")))))
                .child(
                button("request-changes-send", if self.busy { "Sending…" } else if self.pending.is_some() { "Retry send" } else { "Send findings" }, enabled).track_focus(&self.focus[2])
                    .when(self.focus[2].is_focused(window), |b| b.bg(theme().selection))
                    .when(enabled, |b| b.on_click(cx.listener(|s, _, _, cx| s.send(cx))))))
            .when(!reason.is_empty(), |view| view.child(div().text_size(px(11.)).text_color(theme().text_muted)
                .child(if self.availability["receipt"].is_object() { reason.clone() } else { format!("{reason} Use Start over with feedback to discard the current work and dispatch again.") })))
            .when(!self.notice.is_empty(), |view| view.child(div().debug_selector(|| "request-changes-notice".into()).text_size(px(11.))
                .text_color(if self.failed { theme().danger } else { theme().text_muted }).child(self.notice.clone())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
        time::Duration,
    };

    #[gpui::test]
    fn request_changes_note_does_not_trigger_diff_shortcuts(cx: &mut TestAppContext) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming().take(3) {
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut byte = [0];
                while !bytes.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                }
                let header = String::from_utf8(bytes).unwrap();
                let value = if header.contains("worker-corrections") {
                    json!({"reviewCorrection":{"available":true}})
                } else if header.contains("/diff?") {
                    json!({"headSha":"1111111111111111111111111111111111111111","diff":"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"})
                } else {
                    json!({"orchestratorReview":{"verdict":"rejected"}})
                };
                let body = value.to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        let client = Client::authenticated(&origin, Some("fixture".into())).unwrap();
        let (view, cx) = cx.add_window_view(|window, cx| {
            crate::diff_ui::DiffSurface::new(
                client,
                crate::diff::Target::Packet("note-fixture".into()),
                window,
                cx,
            )
        });
        cx.run_until_parked();
        let open = cx.debug_bounds("request-changes-open").unwrap();
        cx.simulate_click(open.center(), gpui::Modifiers::default());
        cx.simulate_input("Keep the public interface stable.");
        cx.simulate_keystrokes("u s r");
        view.read_with(cx, |s, _| {
            assert!(!s.split, "Typing a note must not switch the diff mode");
            assert!(s.ready, "Typing r must not refresh the diff");
        });
    }

    #[gpui::test]
    fn request_changes_retains_note_and_retries_same_saved_review(cx: &mut TestAppContext) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = bodies.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(3) {
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut byte = [0];
                while !bytes.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                }
                let header = String::from_utf8(bytes).unwrap();
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|n| n.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                let mut body = vec![0; length];
                stream.read_exact(&mut body).unwrap();
                let (status, value) = if header.starts_with("GET ") {
                    assert!(header.contains("packetId=packet-review"));
                    (
                        200,
                        json!({"reviewCorrection":{"available":true,"repoPath":"/fixture","threadId":"parent","review":{"packetId":"packet-review","approvalId":"rejection","reviewedHeadSha":"1111111111111111111111111111111111111111","surfaceId":"author","runId":"run"}}}),
                    )
                } else {
                    let mut bodies = captured.lock().unwrap();
                    bodies.push(serde_json::from_slice(&body).unwrap());
                    if bodies.len() == 1 {
                        (503, json!({"error":"Temporary delivery failure"}))
                    } else {
                        (
                            200,
                            json!({"receipt":{"deliveries":[{"status":"delivered","note":"Runtime accepted a new turn on the same worker."}]}}),
                        )
                    }
                };
                let body = value.to_string();
                write!(stream, "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let client = Client::authenticated(&origin, Some("fixture".into())).unwrap();
        let (view, cx) =
            cx.add_window_view(|_, cx| RequestChanges::new(client, "packet-review".into(), cx));
        for _ in 0..100 {
            cx.run_until_parked();
            if !view.read_with(cx, |s, _| s.loading) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let open = cx
            .debug_bounds("request-changes-open")
            .expect("Request changes button");
        cx.simulate_click(open.center(), gpui::Modifiers::default());
        view.update(cx, |s, cx| {
            s.input
                .update(cx, |input, cx| input.set_text("Keep the API stable", cx))
        });
        assert!(cx.debug_bounds("request-changes-send").is_some());
        view.update(cx, |s, cx| {
            s.send(cx);
            assert!(s.busy);
            s.send(cx); // Duplicate submission before the first task settles is inert.
        });
        for _ in 0..100 {
            cx.run_until_parked();
            if !view.read_with(cx, |s, _| s.busy) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        view.read_with(cx, |s, cx| {
            assert!(s.notice.contains("Temporary delivery failure"));
            assert_eq!(s.input.read(cx).text, "Keep the API stable");
            assert!(s.pending.is_some());
        });
        let retry = cx.debug_bounds("request-changes-send").unwrap();
        cx.simulate_click(retry.center(), gpui::Modifiers::default());
        for _ in 0..100 {
            cx.run_until_parked();
            if !view.read_with(cx, |s, _| s.busy) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let bodies = bodies.lock().unwrap();
        assert_eq!(bodies.len(), 2);
        assert_eq!(bodies[0], bodies[1]);
        assert_eq!(bodies[0]["note"], "Keep the API stable");
        view.read_with(cx, |s, cx| {
            assert!(!s.open);
            assert!(s.input.read(cx).text.is_empty());
        });
    }
}
