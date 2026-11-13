//! Manual saved-review delivery uses the same route and record as the review loop.
use crate::{client::Client, composer::Composer, theme::current as theme};
use gpui::{Context, Entity, FocusHandle, KeyDownEvent, Render, Window, div, prelude::*, px};
use serde_json::{Value, json};

pub(crate) struct RequestChanges {
    client: Client,
    packet: String,
    availability: Value,
    input: Entity<Composer>,
    focus: [FocusHandle; 5],
    _submit: gpui::Subscription,
    _input_observer: gpui::Subscription,
    open: bool,
    loading: bool,
    known_rejection: bool,
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
        let submit = cx.subscribe(&input, |view, _, _: &crate::composer::Submit, cx| {
            view.send(cx);
        });
        let input_observer = cx.observe(&input, |_, _, cx| cx.notify());
        let mut view = Self {
            _input_observer: input_observer,
            _submit: submit,
            client,
            packet,
            input,
            focus: [
                cx.focus_handle(),
                cx.focus_handle(),
                cx.focus_handle(),
                cx.focus_handle(),
                cx.focus_handle(),
            ],
            availability: Value::Null,
            open: false,
            loading: false,
            known_rejection: false,
            busy: false,
            notice: String::new(),
            failed: false,
            pending: None,
        };
        view.refresh(cx);
        view
    }
    #[cfg(test)]
    pub(crate) fn open_note_for_test(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.known_rejection = true;
        self.open(window, cx);
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
                        s.known_rejection = s.availability["savedRejection"] == true;
                        if !s.known_rejection {
                            s.open = false;
                        }
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
    fn discard_and_recheck(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.loading || self.pending.is_none() {
            return;
        }
        // Drop only the local retry body. The durable delivery may already exist.
        self.pending = None;
        self.input.read(cx).focus.focus(window);
        self.refresh(cx);
    }
    pub(super) fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.open = false;
        self.focus[0].focus(window);
        cx.notify();
    }
    fn note_limit(&self) -> usize {
        self.availability["maxNoteLength"]
            .as_u64()
            .unwrap_or(1000)
            .min(1000) as usize
    }
    fn note_length(&self, cx: &gpui::App) -> usize {
        self.input.read(cx).text.trim().encode_utf16().count()
    }
    pub(crate) fn visible(&self) -> bool {
        self.availability["savedRejection"]
            .as_bool()
            .unwrap_or(self.known_rejection)
    }
    pub(crate) fn details_visible(&self) -> bool {
        self.visible() && (self.open || !self.outcome().is_empty())
    }
    fn enabled(&self) -> bool {
        self.visible()
            && !self.loading
            && !self.busy
            && (self.availability["available"] == true || self.pending.is_some())
    }
    fn send(&mut self, cx: &mut Context<Self>) {
        if !self.visible()
            || self.busy
            || self.loading
            || (self.pending.is_none() && self.availability["available"] != true)
        {
            return;
        }
        if self.pending.is_none() && self.note_length(cx) > self.note_limit() {
            self.failed = true;
            let excess = self.note_length(cx) - self.note_limit();
            self.notice = format!(
                "The operator note is {excess} character{} too long. Shorten it to {} characters.",
                if excess == 1 { "" } else { "s" },
                self.note_limit()
            );
            cx.notify();
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
                        s.availability = json!({
                            "available": false,
                            "savedRejection": true,
                            "authorUnavailable": false,
                            "reason": s.notice,
                            "receipt": value["receipt"],
                        });
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
                                    || json!({"available": false, "savedRejection": s.known_rejection, "reason": error.message}),
                                );
                            s.known_rejection = s.availability["savedRejection"] == true;
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

#[cfg(test)]
mod tests;
mod view;

#[cfg(test)]
mod availability_tests;

mod keyboard;
