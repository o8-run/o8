//! A bot's main thread, two-way through its mailbox: o8 appends the
//! operator's replies as `user` lines and the bot answers on its next pass. For Grok bots this is the o8 mailbox the
//! bot mirrors its chat into (`<dataDir>/bots/grok/<agentId>/thread.jsonl`);
//! the real Grok Bot chat opens through the app's deep link.
use super::requests::{BotEntry, MailboxMessage};
use super::*;
use crate::theme::current as theme;
use crate::browser_panel::address::Address;
use crate::composer::Submit;
use gpui::{Entity, FocusHandle, ScrollHandle, SharedString};
use std::time::{Duration, Instant};

const REFRESH: Duration = Duration::from_secs(10);

pub(crate) struct BotThread {
    client: Client,
    id: String,
    pub(crate) focus: FocusHandle,
    scroll: ScrollHandle,
    pub(crate) bot: Option<BotEntry>,
    pub(crate) messages: Vec<MailboxMessage>,
    pub(crate) external_url: Option<String>,
    pub(crate) error: Option<String>,
    pub(crate) loading: bool,
    in_flight: bool,
    fetched: Option<Instant>,
    pub(crate) reply: Entity<Address>,
    sending: bool,
}

impl BotThread {
    pub(crate) fn new(
        client: Client,
        id: String,
        bot: Option<BotEntry>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let reply = cx.new(|cx| {
            let mut input = Address::new(cx);
            input.placeholder = "Reply to the bot…".into();
            input
        });
        cx.subscribe(&reply, |this, _, _: &Submit, cx| this.send(cx)).detach();
        let mut view = Self {
            client,
            id,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            bot,
            messages: vec![],
            external_url: None,
            error: None,
            loading: true,
            in_flight: false,
            fetched: None,
            reply,
            sending: false,
        };
        view.load(cx);
        view
    }
    pub(crate) fn tick(&mut self, refresh: bool, cx: &mut Context<Self>) {
        if refresh || self.fetched.is_none_or(|t| t.elapsed() >= REFRESH) {
            self.load(cx);
        }
    }
    pub(crate) fn send(&mut self, cx: &mut Context<Self>) {
        let text = self.reply.read(cx).text.trim().to_owned();
        if text.is_empty() || self.sending {
            return;
        }
        self.sending = true;
        let (client, id) = (self.client.clone(), self.id.clone());
        let task = cx
            .background_executor()
            .spawn(async move { client.bot_reply(&id, &text) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.sending = false;
                match result {
                    Ok(()) => {
                        this.reply.update(cx, |r, cx| r.clear(cx));
                        this.load(cx);
                    }
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn load(&mut self, cx: &mut Context<Self>) {
        if self.in_flight {
            return;
        }
        self.in_flight = true;
        self.fetched = Some(Instant::now());
        let client = self.client.clone();
        let id = self.id.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.bot_thread(&id) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.in_flight = false;
                this.loading = false;
                match result {
                    Ok(thread) => {
                        let grew = thread.messages.len() > this.messages.len();
                        this.bot = Some(thread.bot);
                        this.messages = thread.messages;
                        this.external_url = thread.external_url;
                        this.error = None;
                        if grew {
                            this.scroll.scroll_to_bottom();
                        }
                    }
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
    }
}

pub(super) fn speaker(role: &str, bot: &str) -> String {
    match role {
        "user" => "You".into(),
        "bot" => bot.into(),
        _ => "System".into(),
    }
}

impl Render for BotThread {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let name = self
            .bot
            .as_ref()
            .map(|b| b.name.clone())
            .unwrap_or_else(|| self.id.clone());
        let house = self
            .bot
            .as_ref()
            .map(|b| b.house.clone())
            .unwrap_or_default();
        let link = self.external_url.clone();
        let empty = !self.loading && self.error.is_none() && self.messages.is_empty();
        let rows =
            self.messages.iter().map(|m| {
                let mine = m.role == "user";
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .when(mine, |d| d.items_end())
                    .child(div().text_xs().text_color(theme().text_muted).child(
                        SharedString::from(match &m.at {
                            Some(at) => format!("{} · {at}", speaker(&m.role, &name)),
                            None => speaker(&m.role, &name),
                        }),
                    ))
                    .child(
                        div()
                            .max_w(px(640.))
                            .px(px(12.))
                            .py(px(8.))
                            .rounded(px(10.))
                            .bg(if mine {
                                theme().surface_raised
                            } else {
                                theme().surface
                            })
                            .text_sm()
                            .child(SharedString::from(m.text.clone())),
                    )
            });
        div()
            .id("bot-thread")
            .key_context("BotThread")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(20.))
                    .py(px(12.))
                    .border_b_1()
                    .border_color(theme().border)
                    .child(crate::icon::stroke(
                        super::glyph_path(&house, self.bot.as_ref().and_then(|b| b.icon.key.as_deref())),
                        theme().text,
                        18.,
                        1.8,
                    ))
                    .child(div().text_base().child(SharedString::from(name.clone())))
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme().text_muted)
                            .child(SharedString::from(format!("{house} · mailbox"))),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .id("bot-thread-copy-mcp")
                            .debug_selector(|| "bot-thread-copy-mcp".into())
                            .px(px(10.))
                            .py(px(4.))
                            .rounded(px(8.))
                            .cursor_pointer()
                            .text_xs()
                            .border_1()
                            .border_color(theme().border)
                            .hover(|v| v.bg(theme().hover))
                            .child("Copy MCP URL")
                            .on_click(cx.listener(|this, _, _, cx| {
                                let Some(url) = this.client.mcp_url() else { return };
                                cx.write_to_clipboard(gpui::ClipboardItem::new_string(url));
                                crate::shell::toasts::show(
                                    crate::shell::toasts::Kind::Success,
                                    "MCP URL copied",
                                    vec![],
                                    Some(crate::shell::toasts::NOTICE_TIMEOUT),
                                    cx,
                                );
                            })),
                    )
                    .when_some(link, |d, url| {
                        d.child(
                            div()
                                .id("bot-thread-open-app")
                                .debug_selector(|| "bot-thread-open-app".into())
                                .px(px(10.))
                                .py(px(4.))
                                .rounded(px(8.))
                                .cursor_pointer()
                                .text_xs()
                                .border_1()
                                .border_color(theme().border)
                                .hover(|v| v.bg(theme().hover))
                                .child("Open in app")
                                .on_click(cx.listener(move |_, _, _, cx| cx.open_url(&url))),
                        )
                    }),
            )
            .child(
                div()
                    .id("bot-thread-messages")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .px(px(20.))
                    .py(px(16.))
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .when_some(self.error.clone(), |d, e| {
                        d.child(div().text_sm().text_color(theme().danger).child(SharedString::from(e)))
                    })
                    .when(empty, |d| {
                        d.child(
                            div()
                                .text_sm()
                                .text_color(theme().text_muted)
                                .child("No messages yet. Replies below go to the bot's mailbox; the bot answers on its next pass."),
                        )
                    })
                    .children(rows),
            )
            .child(
                div()
                    .id("bot-thread-reply")
                    .debug_selector(|| "bot-thread-reply".into())
                    .px(px(20.))
                    .py(px(10.))
                    .border_t_1()
                    .border_color(theme().border)
                    .child(self.reply.clone()),
            )
    }
}
