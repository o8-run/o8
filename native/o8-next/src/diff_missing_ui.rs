//! A missing checkout closes through the classic orphan-discard route only.
use super::*;
use serde_json::json;

pub(super) struct State {
    checkout: diff::MissingCheckout,
    pub(super) confirming: bool,
    pub(super) discarded: bool,
    pub(super) failure: Option<String>,
}
impl State {
    pub(super) fn with_discarded(mut self, discarded: bool) -> Self {
        self.discarded = discarded;
        self
    }
    pub(super) fn new(checkout: diff::MissingCheckout) -> Self {
        Self {
            checkout,
            confirming: false,
            discarded: false,
            failure: None,
        }
    }
}

impl DiffSurface {
    pub(super) fn confirm_missing(&mut self, confirm: bool, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        if let Some(state) = &mut self.missing {
            if !state.discarded {
                state.confirming = confirm;
            }
        }
        cx.notify();
    }
    pub(super) fn cancel_missing(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        if event.keystroke.key != "escape" || !self.missing.as_ref().is_some_and(|s| s.confirming) {
            return false;
        }
        self.confirm_missing(false, cx);
        true
    }
    pub(super) fn discard_missing(&mut self, cx: &mut Context<Self>) {
        let Some(state) = &mut self.missing else {
            return;
        };
        if self.busy || !state.confirming || state.discarded {
            return;
        }
        let lane_id = state.checkout.lane_id.clone();
        state.failure = None;
        self.busy = true;
        let generation = self.generation;
        let target = self.target.clone();
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { discard(&client, &lane_id) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                if this.generation != generation || this.target != target {
                    return;
                }
                if let Some(state) = &mut this.missing {
                    match result {
                        Ok(()) => {
                            state.discarded = true;
                            state.confirming = false;
                            this.discarded_lanes.insert(state.checkout.lane_id.clone());
                            this.client.wake();
                        }
                        Err(error) => state.failure = Some(error),
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn missing_actions(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        let Some(state) = &self.missing else {
            return vec![];
        };
        if state.discarded {
            return vec![];
        }
        if !state.confirming {
            return vec![
                button("diff-discard-orphan", "Discard lane", false)
                    .text_color(theme().text_muted)
                    .on_click(cx.listener(|s, _, _, cx| s.confirm_missing(true, cx)))
                    .into_any_element(),
            ];
        }
        vec![
            button(
                "diff-discard-confirm",
                if self.busy {
                    "Discarding…"
                } else {
                    "Confirm discard"
                },
                false,
            )
            .text_color(theme().danger)
            .when(self.busy, |b| b.opacity(0.5).cursor_default())
            .when(!self.busy, |b| {
                b.on_click(cx.listener(|s, _, _, cx| s.discard_missing(cx)))
            })
            .into_any_element(),
            button("diff-discard-cancel", "Cancel", false)
                .text_color(theme().text_muted)
                .when(self.busy, |b| b.opacity(0.5).cursor_default())
                .when(!self.busy, |b| {
                    b.on_click(cx.listener(|s, _, _, cx| s.confirm_missing(false, cx)))
                })
                .into_any_element(),
        ]
    }
    pub(super) fn missing_notice(&self) -> gpui::Div {
        let state = self.missing.as_ref().expect("missing-checkout notice");
        div()
            .debug_selector(|| "diff-missing-checkout".into())
            .p(px(16.))
            .flex().flex_col().gap(px(10.))
            .max_w(px(560.))
            .child(if state.discarded { "Lane discarded" } else { "Worktree no longer on disk" })
            .when(!state.discarded, |body| body
                .child(div().text_size(px(12.)).text_color(theme().text_muted)
                    .child("This lane’s checkout was removed while the lane was still open, so there is no diff left to review and no work left to recover. Discarding closes the lane and clears it from the escalated count."))
                .child(div().text_size(px(11.))
                    .text_color(if state.failure.is_some() { theme().danger } else { theme().text_muted })
                    .child(state.failure.as_ref().unwrap_or(&state.checkout.detail).clone())))
    }
}

fn discard(client: &Client, lane_id: &str) -> Result<(), String> {
    let url = client
        .url("/api/lanes/discard-orphaned")
        .map_err(|_| "Invalid route")?;
    let response = client
        .request("POST", &url)
        .send_json(json!({"laneId":lane_id}));
    let (status, response) = match response {
        Ok(response) => (response.status(), response),
        Err(ureq::Error::Status(status, response)) => (status, response),
        Err(_) => return Err("Could not reach the selected server".into()),
    };
    let body = Client::read::<Value>(response).unwrap_or(Value::Null);
    if status < 300
        && body["ok"] == true
        && body["laneId"] == lane_id
        && body["status"] == "archived"
    {
        return Ok(());
    }
    Err(body["error"]["message"]
        .as_str()
        .or_else(|| body["note"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Discard failed with status {status}")))
}
