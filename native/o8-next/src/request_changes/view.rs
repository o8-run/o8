use super::*;

fn button(id: &'static str, title: &'static str, enabled: bool) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .flex_shrink_0()
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
impl RequestChanges {
    pub(super) fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open = true;
        if self.pending.is_some() {
            self.focus[2].focus(window);
        } else {
            self.input.read(cx).focus.focus(window);
        }
        cx.notify();
    }
    /// Rendered by the host in its existing verdict toolbar; the entity below
    /// that toolbar owns only the optional field and its single outcome line.
    pub(crate) fn trigger(&mut self, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        let enabled = self.enabled();
        button(
            "request-changes-open",
            if self.loading {
                "Checking author…"
            } else if self.busy {
                "Sending findings…"
            } else {
                "Request changes"
            },
            enabled,
        )
        .track_focus(&self.focus[0])
        .tab_stop(true)
        .when(enabled, |button| {
            button
                .on_click(cx.listener(|s, _, window, cx| s.open(window, cx)))
                .on_key_down(cx.listener(|s, event: &KeyDownEvent, window, cx| {
                    if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                        s.open(window, cx);
                        cx.stop_propagation();
                    }
                }))
        })
    }
    pub(super) fn outcome(&self) -> String {
        let reason = self.availability["reason"].as_str().unwrap_or("");
        let text = if self.notice.is_empty() {
            reason
        } else {
            &self.notice
        };
        if text.is_empty() {
            return String::new();
        }
        if self.availability["available"] == false && !self.availability["receipt"].is_object() {
            format!(
                "{text} Use Start over with feedback to discard the current work and dispatch again."
            )
        } else {
            text.to_string()
        }
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "escape" && self.open {
            self.close(window, cx);
            cx.stop_propagation();
            return;
        }
        if event.keystroke.key == "enter" && event.keystroke.modifiers.platform && self.open {
            self.send(cx);
            cx.stop_propagation();
            return;
        }
        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
            if self.focus[2].is_focused(window) {
                self.send(cx);
                cx.stop_propagation();
            } else if self.focus[3].is_focused(window) {
                self.close(window, cx);
                cx.stop_propagation();
            } else if self.focus[1].is_focused(window) {
                self.refresh(cx);
                cx.stop_propagation();
            }
            return;
        }
        if event.keystroke.key != "tab" {
            return;
        }
        let mut stops = vec![self.focus[0].clone()];
        if self.open && !self.busy {
            if self.pending.is_none() {
                stops.push(self.input.read(cx).focus.clone());
            }
            if self.enabled() {
                stops.push(self.focus[2].clone());
            }
            stops.push(self.focus[3].clone());
        }
        if self.availability["available"] != true
            && !self.busy
            && !self.loading
            && self.pending.is_none()
        {
            stops.push(self.focus[1].clone());
        }
        let current = stops.iter().position(|focus| focus.is_focused(window));
        let Some(current) = current else {
            return;
        };
        let next = if event.keystroke.modifiers.shift {
            current.checked_sub(1)
        } else {
            (current + 1 < stops.len()).then_some(current + 1)
        };
        if let Some(next) = next {
            stops[next].focus(window);
            cx.stop_propagation();
        }
    }
}
impl Render for RequestChanges {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let enabled = self.enabled();
        let length = self.note_length(cx);
        let limit = self.note_limit();
        let can_send = enabled && (self.pending.is_some() || length <= limit);
        let unavailable = self.availability["available"] != true;
        let outcome = self.outcome();
        let original = self
            .pending
            .as_ref()
            .and_then(|body| body["note"].as_str())
            .map(str::to_string)
            .unwrap_or_else(|| self.input.read(cx).text.clone());
        div()
            .w_full()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(6.))
            .debug_selector(|| "request-changes".into())
            .capture_key_down(cx.listener(Self::key))
            .when(self.open, |view| {
                view.when(!self.busy && self.pending.is_none(), |view| {
                    view.child(self.input.clone())
                })
                .when(self.busy || self.pending.is_some(), |view| {
                    view.child(
                        div()
                            .id("request-changes-note-readonly")
                            .debug_selector(|| "request-changes-note-readonly".into())
                            .w_full()
                            .max_h(px(120.))
                            .overflow_y_scroll()
                            .p(px(8.))
                            .border_1()
                            .border_color(theme().border)
                            .rounded(px(5.))
                            .text_size(px(12.))
                            .child(if original.is_empty() {
                                "No operator note.".into()
                            } else {
                                original
                            }),
                    )
                })
                .when(self.pending.is_none() && !self.busy, |view| {
                    view.child(
                        div()
                            .text_size(px(11.))
                            .text_color(if length > limit {
                                theme().danger
                            } else {
                                theme().text_muted
                            })
                            .debug_selector(move || {
                                if length > limit {
                                    format!("request-changes-note-over-{}", length - limit)
                                } else {
                                    format!("request-changes-note-room-{}", limit - length)
                                }
                            })
                            .child(if length > limit {
                                format!("{} characters over the limit", length - limit)
                            } else {
                                format!(
                                    "{} characters remaining · Cmd+Enter to send",
                                    limit - length
                                )
                            }),
                    )
                })
                .child(
                    div()
                        .flex()
                        .items_start()
                        .gap(px(6.))
                        .child(
                            button(
                                "request-changes-send",
                                if self.busy {
                                    "Sending…"
                                } else if self.pending.is_some() {
                                    "Retry send"
                                } else {
                                    "Send findings"
                                },
                                can_send,
                            )
                            .bg(theme().accent)
                            .text_color(crate::theme::on_accent())
                            .active(|style| style.bg(theme().accent).opacity(0.8))
                            .track_focus(&self.focus[2])
                            .tab_stop(true)
                            .when(self.focus[2].is_focused(window), |button| {
                                button.border_1().border_color(theme().text)
                            })
                            .when(can_send, |button| {
                                button.on_click(cx.listener(|s, _, _, cx| s.send(cx)))
                            }),
                        )
                        .child(
                            button("request-changes-cancel", "Cancel", !self.busy)
                                .track_focus(&self.focus[3])
                                .tab_stop(true)
                                .when(self.focus[3].is_focused(window), |button| {
                                    button.bg(theme().selection)
                                })
                                .when(!self.busy, |button| {
                                    button.on_click(
                                        cx.listener(|s, _, window, cx| s.close(window, cx)),
                                    )
                                }),
                        ),
                )
            })
            .when(!outcome.is_empty(), |view| {
                view.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(6.))
                        .child(
                            div()
                                .debug_selector(|| "request-changes-notice".into())
                                .text_size(px(11.))
                                .text_color(if self.failed {
                                    theme().danger
                                } else {
                                    theme().text_muted
                                })
                                .child(outcome),
                        )
                        .when(
                            unavailable && !self.busy && !self.loading && self.pending.is_none(),
                            |row| {
                                row.child(
                                    div()
                                        .id("request-changes-refresh")
                                        .debug_selector(|| "request-changes-refresh".into())
                                        .track_focus(&self.focus[1])
                                        .tab_stop(true)
                                        .text_size(px(11.))
                                        .text_color(theme().text_muted)
                                        .cursor_pointer()
                                        .hover(|style| style.text_color(theme().text))
                                        .on_click(cx.listener(|s, _, _, cx| s.refresh(cx)))
                                        .child("Check author again"),
                                )
                            },
                        ),
                )
            })
            .when(self.open && self.failed && self.pending.is_some(), |view| {
                view.child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child("Not sent. Retry sends the same note."),
                )
            })
    }
}
