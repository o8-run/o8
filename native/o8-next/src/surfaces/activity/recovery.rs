//! Existing packet lifecycle routes; an uncertain request keeps its original identity.
use super::feed::text;
use super::*;
use crate::{composer::Composer, theme::current as theme};
use gpui::{AppContext, Entity, div, prelude::*, px};

#[derive(Clone, Copy, PartialEq)]
pub(in super::super) enum Kind {
    Retry,
    Reset,
    StopReset,
    StartOver,
}
pub(super) struct Editor {
    pub input: Entity<Composer>,
    _submit: gpui::Subscription,
}
#[derive(Default)]
pub(super) struct State {
    pub ask: Option<(String, Kind)>,
    pub inputs: HashMap<String, Editor>,
    pub active: Option<Kind>,
}
fn eligible(row: &Row) -> bool {
    let status = text(&row.data, "status");
    !row.data["archivedAt"].is_string()
        && !text(&row.data["lane"], "laneId").is_empty()
        && matches!(
            status.as_str(),
            "blocked" | "idle" | "recovering" | "awaiting_review" | "running" | "launching"
        )
}
impl ActivityPane {
    pub(super) fn recovery_focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.pending
            && let Some((id, Kind::StartOver)) = &self.packet.recovery.ask
            && let Some(editor) = self.packet.recovery.inputs.get(id)
        {
            editor.input.read(cx).focus.focus(window);
        }
    }
    pub(super) fn recovery_editing(&self, window: &Window, cx: &gpui::App) -> bool {
        self.packet.recovery.ask.as_ref().is_some_and(|(id, kind)| {
            *kind == Kind::StartOver
                && self
                    .packet
                    .recovery
                    .inputs
                    .get(id)
                    .is_some_and(|editor| editor.input.read(cx).focus.is_focused(window))
        })
    }
    pub(super) fn recovery_ask(&mut self, row: Row, kind: Kind, cx: &mut Context<Self>) {
        if self.pending || self.unsettled.is_some() {
            return;
        }
        self.packet.action = Some(row.id.clone());
        self.closing = None;
        self.archiving = None;
        if kind == Kind::Retry {
            self.recovery_run(&row.id, kind, cx);
            return;
        }
        if kind == Kind::StartOver && !self.packet.recovery.inputs.contains_key(&row.id) {
            let input = cx.new(|cx| {
                let mut input = Composer::new(cx);
                input.newline_on_enter = true;
                input.placeholder =
                    "What needs to change? Feedback is required (up to 4000 characters).".into();
                input
            });
            let id = row.id.clone();
            let submit = cx.subscribe(&input, move |this, _, _: &crate::composer::Submit, cx| {
                this.recovery_confirm(&id, cx)
            });
            self.packet.recovery.inputs.insert(
                row.id.clone(),
                Editor {
                    input,
                    _submit: submit,
                },
            );
        }
        self.packet.recovery.ask = Some((row.id, kind));
        self.notice.clear();
        self.notice_error = false;
        self.changed(cx);
    }
    pub(super) fn recovery_confirm(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.pending || self.unsettled.is_some() {
            return;
        }
        let Some((packet, kind)) = self.packet.recovery.ask.clone() else {
            return;
        };
        if packet != id {
            return;
        }
        self.recovery_run(id, kind, cx);
    }
    fn recovery_run(&mut self, id: &str, kind: Kind, cx: &mut Context<Self>) {
        if self.pending || self.unsettled.is_some() {
            return;
        }
        let mutation = format!(
            "next-recovery-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let mut body = json!({ "packetId": id, "idempotencyKey": mutation });
        let path = if kind == Kind::StartOver {
            let Some(editor) = self.packet.recovery.inputs.get(id) else {
                return;
            };
            let feedback = editor.input.read(cx).text.trim().to_string();
            if feedback.is_empty() || feedback.encode_utf16().count() > 4000 {
                self.notice_error = true;
                self.notice =
                    "Enter feedback of at most 4000 characters before starting over.".into();
                self.changed(cx);
                return;
            }
            body["feedback"] = json!(feedback);
            "/api/orchestrator/rerun-with-feedback"
        } else {
            let retry = kind == Kind::Retry;
            body["clearWorktree"] = json!(!retry);
            body["reason"] = json!(if retry {
                "operator retry"
            } else {
                "operator reset"
            });
            "/api/orchestrator/reset-packet"
        };
        self.packet.action = Some(id.to_string());
        self.packet.recovery.active = Some(kind);
        self.mutate("POST", path, body, cx);
        if self.pending {
            self.notice = if kind == Kind::Retry {
                "Retrying packet…"
            } else if kind == Kind::StartOver {
                "Starting over with feedback…"
            } else {
                "Stopping worker and resetting packet…"
            }
            .into();
        }
    }
    fn recovery_button(
        &mut self,
        id: &str,
        title: &str,
        action: Action,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        if self.pending || self.unsettled.is_some() {
            Self::inert(id.to_string(), title.to_string())
        } else {
            self.button(id.to_string(), title.to_string(), action, cx)
        }
    }
    pub(super) fn recovery_actions(
        &mut self,
        row: &Row,
        live: bool,
        cx: &mut Context<Self>,
    ) -> Vec<gpui::AnyElement> {
        let status = text(&row.data, "status");
        if !eligible(row)        {
            return vec![];
        }
        let active = self.pending && self.packet.action.as_deref() == Some(row.id.as_str());
        let kind = self.packet.recovery.active;
        let mut actions = vec![];
        if matches!(status.as_str(), "blocked" | "idle" | "recovering") {
            actions.push(
                self.recovery_button(
                    "activity-recovery-retry",
                    if active && kind == Some(Kind::Retry) {
                        "Retrying…"
                    } else {
                        "Retry"
                    },
                    Action::Recovery(row.clone(), Kind::Retry),
                    cx,
                )
                .text_color(theme().text_muted)
                .into_any_element(),
            );
        }
        actions.push(
            self.recovery_button(
                if live {
                    "activity-recovery-stop-reset"
                } else {
                    "activity-recovery-reset"
                },
                if active && matches!(kind, Some(Kind::Reset | Kind::StopReset)) {
                    "Resetting…"
                } else if live {
                    "Stop and reset…"
                } else {
                    "Reset…"
                },
                Action::Recovery(
                    row.clone(),
                    if live { Kind::StopReset } else { Kind::Reset },
                ),
                cx,
            )
            .text_color(theme().text_muted)
            .into_any_element(),
        );
        actions.push(
            self.recovery_button(
                "activity-recovery-start-over",
                if active && kind == Some(Kind::StartOver) {
                    "Starting over…"
                } else {
                    "Start over with feedback…"
                },
                Action::Recovery(row.clone(), Kind::StartOver),
                cx,
            )
            .text_color(theme().text_muted)
            .into_any_element(),
        );
        actions
    }
    pub(super) fn recovery_confirmation(&mut self, row: &Row, cx: &mut Context<Self>) -> gpui::Div {
        let view = div().w_full().min_w_0();
        let Some((id, kind)) = self
            .packet
            .recovery
            .ask
            .clone()
            .filter(|(id, _)| id == &row.id)
        else {
            return view;
        };
        if !eligible(row) {
            self.packet.recovery.ask = None;
            return view;
        }
        let starting_over = kind == Kind::StartOver;
        let warning = if starting_over {
            concat!(
                "Current work will be discarded. The worker stops, its checkout is removed, ",
                "and a new attempt is queued with your feedback."
            )
        } else {
            concat!(
                "Current work will be discarded. Stop the worker, remove its checkout, ",
                "and reset this packet to a held draft?"
            )
        };
        let mut confirm = div()
            .w_full()
            .min_w_0()
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(10.))
            .rounded(px(6.))
            .border_1()
            .border_color(theme().danger)
            .bg(theme().danger_surface)
            .debug_selector(|| "activity-recovery-confirm".into())
            .child(div().text_size(px(11.)).child(warning));
        let mut valid = true;
        if starting_over && let Some(editor) = self.packet.recovery.inputs.get(&id) {
            let input = editor.input.clone();
            let feedback = input.read(cx).text.clone();
            let length = feedback.trim().encode_utf16().count();
            valid = length > 0 && length <= 4000;
            if self.pending || self.unsettled.is_some() {
                confirm = confirm.child(
                    div()
                        .id("activity-recovery-feedback-snapshot")
                        .max_h(px(120.))
                        .overflow_y_scroll()
                        .text_size(px(11.))
                        .child(feedback),
                );
            } else {
                confirm = confirm.child(input);
            }
            confirm = confirm.child(
                div()
                    .text_size(px(10.))
                    .text_color(theme().text_muted)
                    .child(format!("{length} / 4000 characters")),
            );
        }
        let title = if self.pending {
            "Applying…"
        } else if starting_over {
            "Discard work and start over"
        } else {
            "Discard work and reset"
        };
        let submit = if valid {
            self.recovery_button(
                "activity-recovery-confirm-submit",
                title,
                Action::RecoveryConfirm(row.clone()),
                cx,
            )
        } else {
            Self::inert("activity-recovery-confirm-submit", title)
        };
        confirm = confirm.child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(6.))
                .child(
                    submit
                        .text_color(theme().danger)
                        .border_color(theme().danger)
                        .bg(theme().danger_surface),
                )
                .child(self.recovery_button(
                    "activity-recovery-cancel",
                    "Cancel",
                    Action::RecoveryCancel,
                    cx,
                )),
        );
        if self.unsettled.is_some() {
            confirm = confirm.child(
                div()
                    .text_size(px(11.))
                    .child("This request is unsettled. Refresh to inspect the original receipt."),
            );
        }
        view.child(confirm)
    }
}
