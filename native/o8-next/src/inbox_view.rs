use super::*;
use gpui::{FontWeight, IntoElement, KeyDownEvent, Render, div, prelude::*, px, rgb};

// main has no theme.rs. Keep the existing native shell palette local to Inbox.
const BG: u32 = 0x1a1e24;
const CARD: u32 = 0x202630;
const HOVER: u32 = 0x303744;
const TEXT: u32 = 0xe8ecf2;
const MUTED: u32 = 0x9aa7b8;
const WARNING: u32 = 0xffb454;
const ACCENT: u32 = 0xff5a1f;

impl Inbox {
    fn key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.modifiers.control || event.keystroke.modifiers.platform {
            return;
        }
        match event.keystroke.key.as_str() {
            "tab" => {
                let controls = self.cards[self.lane]
                    .iter()
                    .enumerate()
                    .filter(|(_, card)| self.can_resolve(card))
                    .flat_map(|(index, card)| {
                        self.action_focus[&card.id]
                            .iter()
                            .cloned()
                            .map(move |handle| (index, handle))
                    })
                    .collect::<Vec<_>>();
                if !controls.is_empty() {
                    let current = controls
                        .iter()
                        .position(|(_, handle)| handle.is_focused(window));
                    let next = if event.keystroke.modifiers.shift {
                        current
                            .map(|i| (i + controls.len() - 1) % controls.len())
                            .unwrap_or(controls.len() - 1)
                    } else {
                        current.map(|i| (i + 1) % controls.len()).unwrap_or(0)
                    };
                    self.selected = controls[next].0;
                    controls[next].1.focus(window);
                }
            }
            "left" | "right" | "home" | "end" => {
                let lane = match event.keystroke.key.as_str() {
                    "left" => (self.lane + 4) % 5,
                    "right" => (self.lane + 1) % 5,
                    "home" => 0,
                    _ => 4,
                };
                self.focus.focus(window);
                self.select_lane(lane, cx);
            }
            "up" => self.selected = self.selected.saturating_sub(1),
            "down" => {
                self.selected =
                    (self.selected + 1).min(self.cards[self.lane].len().saturating_sub(1))
            }
            "enter" => {
                if let Some(card) = self.cards[self.lane].get(self.selected).cloned() {
                    self.open(&card, cx);
                }
            }
            "f5" => self.load(cx),
            _ => return,
        }
        self.scroll.scroll_to_item(self.selected);
        cx.stop_propagation();
        cx.notify();
    }
    fn card(
        &self,
        card: Card,
        index: usize,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let id = card.id.clone();
        let source_id = format!("inbox-source-{}-{}", card.id, card.source);
        let status_id = format!("inbox-status-{}-{}", card.id, card.status);
        let can_resolve = self.can_resolve(&card);
        let open = card.clone();
        let status = format!(
            "{}{}{}",
            label(&card.status),
            if card.unsettled {
                " · Continuation unconfirmed"
            } else {
                ""
            },
            if card.risk.is_empty() {
                String::new()
            } else {
                format!(" · {} risk", label(&card.risk))
            }
        );
        div().id(("inbox-card", index)).debug_selector(move || format!("inbox-card-{id}"))
            .flex().flex_col().gap(px(4.)).p(px(12.)).mb(px(8.)).rounded(px(8.))
            .bg(rgb(if index == self.selected { HOVER } else { CARD }))
            .child(div().flex().flex_wrap().gap(px(8.)).text_size(px(9.5)).text_color(rgb(MUTED))
                .child(div().debug_selector(move || source_id.clone()).child(label(&card.source)))
                .child(div().debug_selector(move || status_id.clone()).text_color(rgb(if card.status == "human_required" || card.unsettled { WARNING } else { MUTED })).child(status)))
            .child(div().text_size(px(13.5)).child(card.title.clone()))
            .when(!card.detail.is_empty(), |v| v.child(div().text_size(px(11.5)).text_color(rgb(MUTED)).child(card.detail.clone())))
            .child(div().text_size(px(9.5)).text_color(rgb(MUTED)).child(card.metadata.clone()))
            .when(card.unsettled, |v| v.child(div().text_size(px(11.)).text_color(rgb(WARNING))
                .child("Approval recorded; continuation unconfirmed. Inspect the target before another action.")))
            .child(div().flex().flex_wrap().gap(px(8.)).mt(px(4.))
                .when(!card.session.is_empty() || github_url(&card.url).is_some(), |v| v.child(
                    div().id(("inbox-open", index)).debug_selector({ let id = card.id.clone(); move || format!("inbox-open-{id}") })
                        .cursor_pointer().p(px(6.)).rounded(px(7.)).text_size(px(11.))
                        .hover(|s| s.bg(rgb(CARD)))
                        .child(if card.session.is_empty() { "Open on GitHub" } else { "Open session" })
                        .on_click(cx.listener(move |this, _, _, cx| this.open(&open, cx)))))
                .when(card.approval, |v| v.children([false, true].map(|approve| {
                    self.decision_button(card.clone(), index, approve, can_resolve, window, cx)
                }))))
    }
    fn decision_button(
        &self,
        card: Card,
        index: usize,
        approve: bool,
        enabled: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let action = if approve { "approve" } else { "reject" };
        let focus = self.action_focus[&card.id][usize::from(approve)].clone();
        let focused = focus.is_focused(window);
        let clicked = card.clone();
        let keyboard = card.clone();
        div()
            .id(gpui::SharedString::from(format!(
                "inbox-{action}-{}",
                card.id
            )))
            .debug_selector({
                let id = card.id.clone();
                move || format!("inbox-{action}-{id}")
            })
            .relative()
            .track_focus(&focus)
            .tab_index((index * 2 + usize::from(approve)) as isize)
            .tab_stop(enabled)
            .p(px(10.))
            .min_h(px(44.))
            .rounded(px(8.))
            .text_size(px(12.))
            .bg(rgb(if approve && enabled { ACCENT } else { CARD }))
            .text_color(rgb(if enabled { TEXT } else { MUTED }))
            .child(if self.busy.as_ref() == Some(&card.id) {
                "Resolving…"
            } else if approve {
                "Approve"
            } else {
                "Reject"
            })
            .when(focused, |v| {
                v.child(
                    div()
                        .absolute()
                        .inset_0()
                        .rounded(px(8.))
                        .border_2()
                        .border_color(rgb(WARNING))
                        .debug_selector({
                            let id = card.id.clone();
                            move || format!("inbox-focus-{action}-{id}")
                        }),
                )
            })
            .when(enabled, |v| {
                v.cursor_pointer()
                    .hover(|s| s.bg(rgb(HOVER)))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.decide(clicked.clone(), approve, window, cx)
                    }))
                    .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space" | " ") {
                            this.decide(keyboard.clone(), approve, window, cx);
                            cx.stop_propagation();
                        }
                    }))
            })
    }
}
impl Render for Inbox {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let error = self.error().map(str::to_owned);
        let empty =
            self.loaded && !self.loading && error.is_none() && self.cards[self.lane].is_empty();
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(BG))
            .text_color(rgb(TEXT))
            .font_weight(FontWeight::LIGHT)
            .text_size(px(13.))
            .track_focus(&self.focus)
            .tab_group()
            .tab_index(-1)
            .tab_stop(false)
            .on_key_down(cx.listener(Self::key_down))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .p(px(12.))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(8.))
                            .child(div().flex_1().text_size(px(15.)).child("Inbox"))
                            .child(
                                div()
                                    .id("inbox-scope")
                                    .debug_selector(|| "inbox-scope".into())
                                    .p(px(6.))
                                    .rounded(px(7.))
                                    .text_size(px(11.))
                                    .child(if self.lane == 2 {
                                        "All workspaces"
                                    } else if self.all {
                                        "All repositories"
                                    } else {
                                        "This workspace"
                                    })
                                    .when(self.lane != 2 && !self.workspace.is_empty(), |v| {
                                        v.cursor_pointer()
                                            .hover(|s| s.bg(rgb(HOVER)))
                                            .on_click(cx.listener(|this, _, _, cx| this.scope(cx)))
                                    }),
                            )
                            .child(
                                div()
                                    .id("inbox-refresh")
                                    .debug_selector(|| "inbox-refresh".into())
                                    .p(px(6.))
                                    .rounded(px(7.))
                                    .text_size(px(11.))
                                    .child(if self.loading {
                                        "Refreshing…"
                                    } else {
                                        "Refresh"
                                    })
                                    .when(!self.loading, |v| {
                                        v.cursor_pointer()
                                            .hover(|s| s.bg(rgb(HOVER)))
                                            .on_click(cx.listener(|this, _, _, cx| this.load(cx)))
                                    }),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(9.5))
                            .text_color(rgb(MUTED))
                            .child(self.freshness()),
                    )
                    .child(div().flex().flex_wrap().gap(px(4.)).mt(px(8.)).children(
                        VIEWS.iter().enumerate().map(|(i, (lane, label))| {
                            let count = self.cards[i].len();
                            div()
                                .id(("inbox-view", i))
                                .debug_selector(move || format!("inbox-view-{lane}"))
                                .h(px(26.))
                                .px(px(8.))
                                .rounded(px(7.))
                                .flex()
                                .items_center()
                                .gap(px(5.))
                                .bg(rgb(if i == self.lane { HOVER } else { BG }))
                                .cursor_pointer()
                                .text_size(px(11.))
                                .child(*label)
                                .child(
                                    div()
                                        .debug_selector(move || {
                                            format!("inbox-count-{lane}-{count}")
                                        })
                                        .text_size(px(9.5))
                                        .text_color(rgb(MUTED))
                                        .child(count.to_string()),
                                )
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.select_lane(i, cx);
                                    this.focus(window);
                                }))
                        }),
                    )),
            )
            .when(self.lane == 2, |v| {
                v.child(
                    div()
                        .px(px(12.))
                        .text_size(px(11.))
                        .text_color(rgb(MUTED))
                        .child("Approvals across all workspaces"),
                )
            })
            .when(!self.loaded, |v| {
                v.child(div().p(px(12.)).child(if self.loading {
                    "Loading inbox…"
                } else {
                    "Inbox unavailable"
                }))
            })
            .when_some(error, |v, error| {
                v.child(
                    div()
                        .debug_selector(|| "inbox-error".into())
                        .p(px(12.))
                        .text_size(px(11.))
                        .text_color(rgb(WARNING))
                        .child(error),
                )
            })
            .when(!self.notice.is_empty(), |v| {
                v.child(
                    div()
                        .debug_selector(|| "inbox-notice".into())
                        .px(px(12.))
                        .text_size(px(11.))
                        .child(self.notice.clone()),
                )
            })
            .when(self.truncated(), |v| {
                v.child(
                    div()
                        .px(px(12.))
                        .text_size(px(11.))
                        .text_color(rgb(MUTED))
                        .child(if self.lane == 0 {
                            "Showing the 200 oldest unanswered conversations."
                        } else {
                            "Showing the 200 most recently updated contributions."
                        }),
                )
            })
            .when(empty, |v| {
                v.child(
                    div()
                        .debug_selector(|| "inbox-empty".into())
                        .p(px(16.))
                        .text_size(px(12.))
                        .text_color(rgb(MUTED))
                        .child(match self.lane {
                            0 if self.feed.sources.is_empty() => {
                                "Connect a GitHub repository to see conversations here."
                            }
                            0 => "No unanswered threads in the cached GitHub conversations.",
                            1 => "No open contributions or claimed issues in this scope.",
                            2 => "No pending approvals across your workspaces.",
                            3 => "No active agent issues in this scope.",
                            _ => "No resolved or dismissed items yet.",
                        }),
                )
            })
            .child(
                div()
                    .id("inbox-cards")
                    .debug_selector(|| "inbox-cards".into())
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .p(px(12.))
                    .children(
                        self.cards[self.lane]
                            .clone()
                            .into_iter()
                            .enumerate()
                            .map(|(i, card)| self.card(card, i, window, cx)),
                    ),
            )
    }
}
