//! Always-on bots from every house (Grok, Codex, Claude, o8 native, …) as rail
//! entries directly under PRs. The list comes from `GET /api/bots`; a click
//! opens the bot's main thread as a `Tab::Bot(id)` in the main pane. No drag:
//! a rail row carries at most one `on_drag`, and bots do not claim one yet.
use super::*;
use crate::icon::Tip;
use crate::theme::current as theme;
use gpui::{AnyElement, SharedString};
use std::time::{Duration, Instant};

#[path = "bots/client.rs"]
mod requests;
#[path = "bots/view.rs"]
mod view;

pub(crate) use requests::BotEntry;

pub(super) type Slice = EmptyState;
pub(super) type View = view::BotThread;

/// Window-owned roster and scroll state; no process-wide poller.
#[derive(Default)]
pub(super) struct Runtime {
    entries: Vec<BotEntry>,
    loading: bool,
    fetched: Option<Instant>,
    settings_revision: u64,
    error: Option<String>,
    scroll: gpui::ScrollHandle,
}
const POLL: Duration = Duration::from_secs(30);

fn load_roster(shell: &mut Shell, force: bool, cx: &mut Context<Shell>) {
    let state = &mut shell.surfaces.bots;
    let settings_revision = crate::settings_fields::bot_rail_revision(&shell.client);
    if state.settings_revision != settings_revision && !state.entries.is_empty() {
        // Confirmed Settings choices supersede cached visibility even if
        // the replacement roster fails or an older request is in flight.
        state.entries.clear();
        cx.notify();
    }
    if state.loading
        || !force
            && state.settings_revision == settings_revision
            && state.fetched.is_some_and(|t| t.elapsed() < POLL)
    {
        return;
    }
    state.settings_revision = settings_revision;
    state.loading = true;
    state.fetched = Some(Instant::now());
    let client = shell.client.clone();
    let task = cx.background_executor().spawn(async move { client.bots() });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |shell, cx| {
            let state = &mut shell.surfaces.bots;
            state.loading = false;
            if settings_revision != crate::settings_fields::bot_rail_revision(&shell.client) {
                state.fetched = None;
                cx.notify();
                return;
            }
            match result {
                Ok(entries) => {
                    state.entries = entries;
                    state.error = None;
                }
                Err(error) => state.error = Some(error),
            }
            cx.notify();
        });
    })
    .detach();
}

fn native_id(bot: &BotEntry) -> Option<&str> {
    bot.main_thread
        .as_ref()
        .filter(|t| t.kind == "o8-thread")?
        .id
        .as_deref()
}

fn can_open(shell: &Shell, id: &str) -> bool {
    shell.sessions.iter().any(|s| s.id == id)
}

fn open_native(
    shell: &mut Shell,
    tab: Tab,
    id: String,
    window: &mut Window,
    cx: &mut Context<Shell>,
) {
    // A global bot can have unresolved placeholders in several workspace tab
    // lists. Retire every copy before opening its single resolved conversation.
    for (workspace, saved) in &mut shell.state.workspaces {
        let before = saved.tabs.len();
        let active = saved
            .tabs
            .iter()
            .take(saved.active)
            .filter(|t| *t != &tab)
            .count();
        saved.tabs.retain(|t| t != &tab);
        if before != saved.tabs.len() {
            saved.active = active.min(saved.tabs.len().saturating_sub(1));
            let key = format!("{workspace}|{tab:?}");
            shell.content.remove(&key);
            shell.state.tab_labels.remove(&key);
        }
    }
    shell.open_thread(id, window, cx);
}

/// Restored Bot tabs may precede both roster and thread-catalog hydration.
/// Only the active bot can redirect; inactive mirrors never steal navigation.
fn route_native(shell: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    if shell.palette || shell.shortcuts || registrations().iter().any(|r| (r.overlay_open)(shell)) {
        return;
    }
    let Some(Tab::Bot(id)) = shell.active() else {
        return;
    };
    let tab = Tab::Bot(id);
    let key = shell.key(&tab);
    let Some(Content::Bot(view)) = shell.content.get(&key) else {
        return;
    };
    let view = view.clone();
    let target = view
        .read(cx)
        .bot
        .as_ref()
        .and_then(|b| b.main_thread.clone())
        .filter(|t| t.kind == "o8-thread");
    let Some(target) = target else { return };
    if let Some(id) = target
        .id
        .filter(|id| shell.connected && can_open(shell, id))
    {
        open_native(shell, tab, id, window, cx);
    } else {
        // Routine maintenance also sets shell.loading; a completed healthy
        // catalog must continue to report a missing target as unavailable.
        let loading = !shell.connected;
        view.update(cx, |view, cx| {
            if view.native_loading != loading {
                view.native_loading = loading;
                cx.notify();
            }
        });
    }
}

fn roster_status(label: String, cx: &mut Context<Shell>) -> AnyElement {
    div()
        .id("rail-bots-retry")
        .debug_selector(|| "rail-bots-retry".into())
        .size(px(super::rail::TARGET))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(10.))
        .cursor_pointer()
        .hover(|v| v.bg(theme().hover))
        .tooltip(move |_, cx| cx.new(|_| Tip(label.clone().into())).into())
        .child(crate::icon::stroke(
            "M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-1l2 6 M4 12l2 6a7 7 0 0 0 12-1",
            theme().text_muted,
            19.,
            1.8,
        ))
        .on_click(cx.listener(|shell, _, _, cx| load_roster(shell, true, cx)))
        .into_any_element()
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
    let active = match s.active() {
        Some(Tab::Bot(id)) => id == bot.id,
        Some(Tab::Session(id)) => native_id(bot).is_some_and(|target| {
            s.current()
                .and_then(|w| w.selections.get(&id))
                .unwrap_or(&id)
                == target
        }),
        _ => false,
    };
    let id = rail_id(bot);
    let selector = id.clone();
    let name: SharedString = if s.surfaces.bots.error.is_some() {
        format!(
            "{} · Bot list unavailable; showing the last known entry",
            bot.name
        )
        .into()
    } else {
        bot.name.clone().into()
    };
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
        .when_some(
            s.surfaces
                .bots
                .error
                .is_none()
                .then(|| status_color(&bot.status))
                .flatten(),
            |view, dot| {
                let marker: SharedString =
                    format!("rail-bot-status-{}-{}", bot.id, bot.status).into();
                let selector = marker.clone();
                view.child(
                    div()
                        .id(marker)
                        .debug_selector(move || selector.to_string())
                        .absolute()
                        .right(px(9.))
                        .bottom(px(9.))
                        .size(px(7.))
                        .rounded_full()
                        .bg(dot),
                )
            },
        )
        .on_click(cx.listener(move |this, _, window, cx| {
            this.capture(window, cx);
            this.execute(Command::Bot(bot_id.clone()), window, cx);
        }))
        .into_any_element()
}

pub(super) const REGISTRATION: Registration = Registration {
    global: true,
    initialize: |shell, _, cx| load_roster(shell, true, cx),
    tick: |shell, window, cx| {
        load_roster(shell, false, cx);
        route_native(shell, window, cx);
    },
    create: |shell, tab, _, window, cx| {
        let Tab::Bot(id) = tab else {
            return None;
        };
        let bot = shell
            .surfaces
            .bots
            .entries
            .iter()
            .find(|b| b.id == id)
            .cloned();
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
        let state = &s.surfaces.bots;
        if state.entries.is_empty() && !state.loading && state.error.is_none() {
            return vec![];
        }
        let status = state
            .error
            .as_ref()
            .map(|error| format!("Bot list unavailable: {error}. Click to retry."))
            .or_else(|| state.entries.is_empty().then(|| "Loading bots…".into()));
        let region = div()
            .id("rail-bots")
            .debug_selector(|| "rail-bots".into())
            .w(px(super::rail::TARGET))
            .min_h_0()
            .flex_shrink()
            .flex()
            .flex_col()
            .overflow_y_scroll()
            .track_scroll(&state.scroll)
            .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
            .when_some(status, |list, label| list.child(roster_status(label, cx)))
            .children(state.entries.iter().map(|bot| entry(s, bot, cx)));
        vec![region.into_any_element()]
    },
    ..Registration::new("Bot", "", |shell, command, window, cx| match command {
        Command::Bot(id) => {
            let native = shell
                .surfaces
                .bots
                .entries
                .iter()
                .find(|b| b.id == id)
                .and_then(native_id)
                .filter(|id| can_open(shell, id))
                .map(str::to_owned);
            if let Some(thread) = native {
                open_native(shell, Tab::Bot(id), thread, window, cx);
                None
            } else {
                Some((Tab::Bot(id), false))
            }
        }
        _ => None,
    })
};

impl ShellView for View {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus.focus(window);
    }
    fn tick(view: &Entity<Self>, _: bool, cx: &mut Context<Shell>) {
        view.update(cx, |s, cx| s.tick(cx));
    }
    fn refresh(view: &Entity<Self>, cx: &mut Context<Shell>) {
        view.update(cx, |s, cx| s.refresh(cx));
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        !view.read(cx).loading
    }
}

#[cfg(test)]
#[path = "bots/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "bots/rail_tests.rs"]
mod rail_tests;

#[cfg(test)]
#[path = "bots/settings_tests.rs"]
mod settings_tests;

#[cfg(test)]
#[path = "bots/ask_user_tests.rs"]
pub(crate) mod ask_user_tests;
