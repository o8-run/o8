use super::*;
use crate::diff::Target;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

impl Card {
    pub(super) fn inspect(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let path = self.task.lane["worktreePath"]
            .as_str()
            .or(self.task.lane["repoPath"].as_str())
            .or(self.task.packet["workspaceTargetPath"].as_str())
            .unwrap_or_default()
            .to_owned();
        if path.is_empty() {
            self.notice = "This task has no workspace to inspect.".into();
            cx.notify();
            return;
        }
        let base = self.task.lane["baseBranch"].as_str().map(str::to_owned);
        let client = self.client.clone();
        self.diff = Some(cx.new(|cx| {
            DiffSurface::new(
                client,
                Target::Worktree {
                    path,
                    base,
                    file: None,
                },
                window,
                cx,
            )
        }));
        cx.notify();
    }
    pub(super) fn keep_waiting(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.task.lane_id().is_empty() {
            return;
        }
        self.busy = true;
        cx.notify();
        let client = self.client.clone();
        let lane = self.task.lane_id();
        let task = cx.background_executor().spawn(async move {
            let id: String = url::form_urlencoded::byte_serialize(lane.as_bytes()).collect();
            client.get::<Value>(&format!("/api/lanes/{id}"), &[("events", "0")])
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                this.notice = result.err().unwrap_or_default();
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn send(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.composer.read(cx).composing() {
            return;
        }
        let body = match self.pending.clone() {
            Some(body) => body,
            None => {
                let message = self.composer.read(cx).text.trim().to_owned();
                if message.is_empty() {
                    return;
                }
                static NEXT: AtomicU64 = AtomicU64::new(0);
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let id = format!(
                    "next-worker-{stamp}-{}",
                    NEXT.fetch_add(1, Ordering::Relaxed)
                );
                json!({ "packetId": self.task.id, "message": message, "source": "operator", "idempotencyKey": id })
            }
        };
        self.pending = Some(body.clone());
        self.busy = true;
        self.notice.clear();
        cx.notify();
        let client = self.client.clone();
        let request = body.clone();
        let task = cx
            .background_executor()
            .spawn(async move { steer(&client, &request) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok((status, value, unknown))
                        if (200..300).contains(&status)
                            && value["ok"] == true
                            && status != 202
                            && value["result"]["inProgress"] != true
                            && !unknown =>
                    {
                        this.pending = None;
                        if this.composer.read(cx).text.trim()
                            == body["message"].as_str().unwrap_or_default()
                        {
                            this.composer.update(cx, |composer, cx| composer.clear(cx));
                        }
                    }
                    Ok((status, value, unknown)) => {
                        if !unknown && (value["ok"] == false || (400..500).contains(&status)) {
                            this.pending = None;
                        }
                        this.notice = value["error"]["message"]
                            .as_str()
                            .or(value["error"].as_str())
                            .map(str::to_owned)
                            .unwrap_or_else(|| {
                                "Delivery pending. Retry to check the same adjustment.".into()
                            });
                    }
                    Err(error) => this.notice = error,
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn action(
        &self,
        id: String,
        label: &str,
        enabled: bool,
        primary: bool,
        handler: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let index = if id.starts_with("worker-inspect-") {
            0
        } else if id.starts_with("worker-wait-") {
            1
        } else if id.starts_with("worker-send-") {
            2
        } else {
            3
        };
        let focus = self.action_focus[index].clone();
        let tab = [0, 1, 3, 4][index];
        let handler = Rc::new(handler);
        let clicked = handler.clone();
        div()
            .id(SharedString::from(id.clone()))
            .debug_selector(move || id.clone())
            .track_focus(&focus)
            .tab_index(tab)
            .tab_stop(enabled)
            .border_1()
            .border_color(gpui::transparent_black())
            .focus(|style| style.border_color(theme().warning))
            .min_h(px(26.))
            .px(px(9.))
            .py(px(5.))
            .rounded(px(7.))
            .text_size(px(12.))
            .bg(if primary {
                theme().accent
            } else {
                gpui::transparent_black().into()
            })
            .opacity(if enabled { 1. } else { 0.4 })
            .child(label.to_owned())
            .when(enabled, |v| v.cursor_pointer().hover(|v| v.opacity(0.85)))
            .on_click(cx.listener(move |this, _, window, cx| {
                if enabled {
                    clicked(this, window, cx);
                }
                cx.stop_propagation();
            }))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if enabled && ["enter", "space", " "].contains(&event.keystroke.key.as_str()) {
                    handler(this, window, cx);
                    cx.stop_propagation();
                }
            }))
            .into_any_element()
    }
    pub(super) fn actions_view(&mut self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let id = self.task.id.clone();
        let buttons = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(self.action(
                format!("worker-inspect-{id}"),
                if self.task.filter == 2 {
                    "Inspect conflict"
                } else {
                    "Inspect"
                },
                !self.busy,
                true,
                |this, window, cx| this.inspect(window, cx),
                cx,
            ))
            .child(self.action(
                format!("worker-wait-{id}"),
                "Keep waiting",
                !self.busy && !self.task.lane_id().is_empty(),
                false,
                |this, _, cx| this.keep_waiting(cx),
                cx,
            ));
        let empty = self.composer.read(cx).text.is_empty();
        let field_id = format!("worker-adjust-{id}");
        let field = div()
            .id(SharedString::from(field_id.clone()))
            .debug_selector(move || field_id.clone())
            .flex_1()
            .min_w_0()
            .relative()
            .child(self.composer.clone())
            .when(empty, |v| {
                v.child(
                    div()
                        .absolute()
                        .left(px(9.))
                        .top(px(9.))
                        .text_size(px(12.))
                        .text_color(theme().text_faint)
                        .child("Tell the worker what to adjust")
                        .id("worker-adjust-placeholder")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.composer.read(cx).focus.focus(window);
                            cx.stop_propagation();
                        })),
                )
            });
        let can_send = !self.busy
            && (!self.composer.read(cx).text.trim().is_empty() || self.pending.is_some());
        let input = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(field)
            .child(self.action(
                format!("worker-send-{id}"),
                if self.pending.is_some() {
                    "Retry"
                } else {
                    "↑"
                },
                can_send,
                false,
                |this, _, cx| this.send(cx),
                cx,
            ));
        let mut view = div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(buttons)
            .child(input);
        if !self.notice.is_empty() {
            view = view.child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().danger)
                    .child(self.notice.clone()),
            );
        }
        if let Some(diff) = &self.diff {
            view = view
                .child(self.action(
                    format!("worker-close-diff-{id}"),
                    "Close diff",
                    true,
                    false,
                    |this, window, cx| {
                        this.diff = None;
                        this.focus.focus(window);
                        cx.notify();
                    },
                    cx,
                ))
                .child(div().w_full().h(px(360.)).child(diff.clone()));
        }
        view.into_any_element()
    }
}

fn steer(client: &Client, body: &Value) -> Result<(u16, Value, bool), String> {
    let url = client
        .url("/api/orchestrator/steer-packet")
        .map_err(|_| "Invalid steer route")?;
    let response = match client.request("POST", &url).send_json(body.clone()) {
        Ok(response) | Err(ureq::Error::Status(_, response)) => response,
        Err(_) => return Err("Delivery unconfirmed. Retry to check the same adjustment.".into()),
    };
    let status = response.status();
    let unknown = response.header("x-o8-steer-outcome") == Some("unknown");
    let value = Client::read(response)?;
    Ok((status, value, unknown))
}
