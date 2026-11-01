use super::*;
use crate::theme::current as palette;
use gpui::{div, prelude::*, px};
use std::rc::Rc;

fn button(
    label: &str,
    selector: String,
    enabled: bool,
    cx: &mut Context<Inbox>,
    action: impl Fn(&mut Inbox, &mut Window, &mut Context<Inbox>) + 'static,
) -> gpui::AnyElement {
    let action = Rc::new(action);
    let click = action.clone();
    div()
        .id(gpui::ElementId::Name(selector.clone().into()))
        .debug_selector(move || selector.clone())
        .p(px(6.))
        .rounded(px(7.))
        .text_size(px(11.))
        .opacity(if enabled { 1. } else { 0.5 })
        .child(label.to_owned())
        .when(enabled, |v| {
            v.focusable()
                .tab_index(0)
                .cursor_pointer()
                .hover(|v| v.bg(palette().hover))
                .active(|v| v.bg(palette().selection))
                .focus(|v| v.bg(palette().selection))
                .on_click(cx.listener(move |this, _, window, cx| {
                    click(this, window, cx);
                    cx.stop_propagation();
                }))
                .on_key_down(
                    cx.listener(move |this, event: &gpui::KeyDownEvent, window, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                            action(this, window, cx);
                            cx.stop_propagation();
                        }
                    }),
                )
        })
        .into_any_element()
}
impl Inbox {
    fn exchange_row(&self, row: AgentExchange, cx: &mut Context<Self>) -> gpui::AnyElement {
        let closed = row.status == "closed";
        let id = row.id.clone();
        let target = ExchangeSelection {
            id: row.id.clone(),
            repo: row.repo.clone(),
        };
        let busy = self.exchanges.busy;
        div()
            .debug_selector(move || {
                format!(
                    "inbox-exchange-{}-{id}",
                    if closed { "settled" } else { "active" }
                )
            })
            .flex()
            .flex_col()
            .gap(px(4.))
            .py(px(8.))
            .text_size(px(13.5))
            .child(row.participants.join(" · "))
            .child(
                div()
                    .text_size(px(9.5))
                    .text_color(palette().text_muted)
                    .child(format!(
                        "{} · {} · {} turns remaining",
                        if closed { "Settled" } else { "Active" },
                        row.repo,
                        row.remaining_turns
                    )),
            )
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(button(
                        "Open exchange",
                        format!("inbox-exchange-open-{}", row.id),
                        true,
                        cx,
                        move |this, _, cx| this.select_exchange(target.clone(), cx),
                    ))
                    .when(!closed, |v| {
                        v.child(button(
                            if busy { "Settling…" } else { "Settle" },
                            format!("inbox-exchange-settle-{}", row.id),
                            !busy,
                            cx,
                            move |this, window, cx| {
                                this.focus.focus(window);
                                this.settle_exchange(row.clone(), cx);
                            },
                        ))
                    }),
            )
            .into_any_element()
    }
    pub(super) fn exchange_group(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let mut group = div()
            .debug_selector(|| "inbox-agent-exchanges-group".into())
            .flex()
            .flex_col()
            .mb(px(16.))
            .gap(px(4.))
            .child(
                div()
                    .text_size(px(10.))
                    .text_color(palette().text_muted)
                    .child("Agent exchanges"),
            );
        for error in [
            self.exchanges.error.as_ref(),
            self.exchanges.notice.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            group = group.child(
                div()
                    .text_size(px(11.))
                    .text_color(palette().warning)
                    .child(error.clone()),
            );
        }
        if self.exchanges.pending.is_some() {
            group = group.child(button(
                "Retry Settle",
                "inbox-exchange-retry".into(),
                !self.exchanges.busy,
                cx,
                |this, _, cx| this.retry_exchange_close(cx),
            ));
        }
        if self.exchanges.undo.is_some() {
            group = group.child(button(
                "Undo Settle",
                "inbox-exchange-undo".into(),
                !self.exchanges.busy,
                cx,
                |this, _, cx| this.undo_exchange(cx),
            ));
        }
        for row in self
            .exchanges
            .rows
            .iter()
            .filter(|row| row.status == "open")
        {
            group = group.child(self.exchange_row(row.clone(), cx));
        }
        let count = self
            .exchanges
            .rows
            .iter()
            .filter(|row| row.status == "closed")
            .count();
        group = group.child(button(
            &format!("Settled (recent {count})"),
            "inbox-exchanges-settled".into(),
            true,
            cx,
            |this, _, cx| {
                this.exchanges.expanded = !this.exchanges.expanded;
                cx.notify();
            },
        ));
        if self.exchanges.expanded {
            for row in self
                .exchanges
                .rows
                .iter()
                .filter(|row| row.status == "closed")
            {
                group = group.child(self.exchange_row(row.clone(), cx));
            }
        }
        if let Some(detail) = &self.exchanges.detail {
            group = group.child(
                div()
                    .text_size(px(13.5))
                    .mt(px(8.))
                    .child(detail.conversation.participants.join(" · ")),
            );
            if let Some(summary) = &detail.conversation.summary {
                group = group.child(div().text_size(px(11.)).child(summary.clone()));
            }
            for message in &detail.messages {
                let id = text(message, "id");
                group = group.child(
                    div()
                        .debug_selector(move || format!("inbox-exchange-message-{id}"))
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .py(px(8.))
                        .child(
                            div()
                                .text_size(px(9.5))
                                .text_color(palette().text_muted)
                                .child(text(message, "from")),
                        )
                        .child(div().text_size(px(13.)).child(text(message, "text"))),
                );
            }
        }
        group.into_any_element()
    }
}
