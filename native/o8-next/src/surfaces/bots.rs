//! Always-on bots from every house (Grok, Codex, Claude, o8 native, …) as rail
//! entries directly under PRs. The list comes from `GET /api/bots`; a click
//! opens the bot's main thread as a `Tab::Bot(id)` in the main pane. No drag:
//! a rail row carries at most one `on_drag`, and bots do not claim one yet.
use super::*;
use crate::icon::Tip;
use crate::theme::current as theme;
use gpui::{AnyElement, SharedString};
use std::sync::{Mutex, Once};
use std::time::Duration;

#[path = "bots/client.rs"]
mod requests;
#[path = "bots/view.rs"]
mod view;

pub(crate) use requests::BotEntry;

pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) type View = view::BotThread;

/// The rail's current bot list, refreshed by a background poll.
static BOTS: Mutex<Vec<BotEntry>> = Mutex::new(Vec::new());
const POLL: Duration = Duration::from_secs(30);

pub(super) fn bots() -> Vec<BotEntry> {
    BOTS.lock().unwrap().clone()
}
#[cfg(test)]
pub(super) fn set_bots(list: Vec<BotEntry>) {
    *BOTS.lock().unwrap() = list;
}

fn watch(client: &Client) {
    // Fixture servers record every request, so tests seed the list instead.
    if cfg!(test) {
        return;
    }
    static STARTED: Once = Once::new();
    STARTED.call_once(|| {
        let client = client.clone();
        std::thread::spawn(move || {
            loop {
                if let Ok(list) = client.bots() {
                    *BOTS.lock().unwrap() = list;
                }
                std::thread::sleep(POLL);
            }
        });
    });
}

/// House glyphs. Grok is a bespoke o8 stroke (ring cut by a diagonal, after
/// the xAI mark); every other house falls back to Lucide's `bot`.
pub(super) fn glyph_path(house: &str, key: Option<&str>) -> &'static str {
    match key.unwrap_or(house) {
        "grok" | "xai" => "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18Z M6.5 17.5 17.5 6.5",
        _ => {
            "M12 8V4H8 M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z M2 14h2 M20 14h2 M15 13v2 M9 13v2"
        }
    }
}

fn status_color(status: &str) -> Option<gpui::Rgba> {
    match status {
        "online" => Some(theme().success),
        "offline" => Some(theme().text_faint),
        _ => None,
    }
}

pub(super) fn rail_id(bot: &BotEntry) -> SharedString {
    format!("rail-bot-{}", bot.id).into()
}

fn entry(s: &Shell, bot: &BotEntry, cx: &mut Context<Shell>) -> AnyElement {
    let active = s.active() == Some(Tab::Bot(bot.id.clone()));
    let id = rail_id(bot);
    let selector = id.clone();
    let name: SharedString = bot.name.clone().into();
    let color = if active {
        theme().text
    } else {
        theme().text_secondary
    };
    let bot_id = bot.id.clone();
    div()
        .id(id)
        .debug_selector(move || selector.to_string())
        .relative()
        .size(px(super::rail::TARGET))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(10.))
        .cursor_pointer()
        .hover(|view| view.bg(theme().hover))
        .when(active, |view| view.bg(theme().hover))
        .tooltip(move |_, cx| cx.new(|_| Tip(name.clone())).into())
        .child(crate::icon::stroke(
            glyph_path(&bot.house, bot.icon.key.as_deref()),
            color,
            19.,
            1.8,
        ))
        .when_some(status_color(&bot.status), |view, dot| {
            view.child(
                div()
                    .absolute()
                    .right(px(9.))
                    .bottom(px(9.))
                    .size(px(7.))
                    .rounded_full()
                    .bg(dot),
            )
        })
        .on_click(cx.listener(move |this, _, window, cx| {
            this.capture(window, cx);
            this.execute(Command::Bot(bot_id.clone()), window, cx);
        }))
        .into_any_element()
}

pub(super) const REGISTRATION: Registration = Registration {
    create: |shell, tab, _, window, cx| {
        let Tab::Bot(id) = tab else {
            return None;
        };
        let bot = bots().into_iter().find(|b| b.id == id);
        let client = shell.client.clone();
        Some(Content::Bot(
            cx.new(|cx| view::BotThread::new(client, id, bot, window, cx)),
        ))
    },
    // Registered right after pull_requests, so these sit directly under PRs.
    nav: |s, position, cx| {
        if position != NavPosition::BeforeWorkspaces {
            return vec![];
        }
        watch(&s.client);
        bots().iter().map(|bot| entry(s, bot, cx)).collect()
    },
    ..Registration::new("Bot", "", |_, command, _, _| match command {
        Command::Bot(id) => Some((Tab::Bot(id), false)),
        _ => None,
    })
};

impl ShellView for View {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus.focus(window);
    }
    fn tick(view: &Entity<Self>, refresh: bool, cx: &mut Context<Shell>) {
        view.update(cx, |s, cx| s.tick(refresh, cx));
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        !view.read(cx).loading
    }
}

#[cfg(test)]
#[path = "bots/tests.rs"]
mod tests;
