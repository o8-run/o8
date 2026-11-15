//! An empty thread's overview under the composer: what needs you, recent
//! threads, usage and the last twelve weeks, read from what the app already
//! holds. It leaves the moment the thread has a message or a send starts.
use super::*;
use crate::client::Session;
use crate::shell::sidebar::needs_input;
use gpui::{Animation, AnimationExt};
use std::collections::BTreeMap;

/// Rows a list card shows.
const ROWS: usize = 4;
/// Days the heatmap covers: twelve weeks, oldest first, ending today.
pub(crate) const DAYS: usize = 12 * 7;
/// A card's fade, and the most a later card waits behind the one before it.
const FADE_MS: u64 = 180;
const STAGGER_MS: u64 = 40;
/// The width a card asks for, and the least it takes. The least decides how
/// many sit side by side; the workspace is never narrower than its 420-point
/// reserve, so one card always fits.
/// A card's share of the overview's width before it grows. Two shares and a
/// gap fit a row and three never do, so every chat width gives two columns.
pub(super) const CARD_SHARE: f32 = 0.4;
pub(super) const CARD_MIN: f32 = 240.;
const GAP: f32 = 12.;

/// One thread row in a list card.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Row {
    pub id: String,
    pub title: String,
    pub repo: String,
    pub age: String,
    /// Why it needs you; recent rows have none.
    pub note: Option<&'static str>,
}

/// A thread the overview may list: on this computer, a top-level thread, not
/// archived or settled, not the one open and not another empty new chat.
fn listable(s: &Session, current: Option<&str>) -> bool {
    s.machine.is_none()
        && s.parent_inbox_subject.is_none()
        && s.status != "archived"
        && !s.settled()
        && current != Some(s.id.as_str())
        && !(s.id.starts_with("thoughts-next-") && s.message_count == 0)
}

/// The project a row names: the remote's repository, else its folder.
fn repo_label(s: &Session) -> String {
    let home = s
        .repo_path
        .as_deref()
        .is_none_or(crate::shell::session::is_home);
    let slug = s
        .repo_slug
        .as_deref()
        .filter(|slug| !slug.trim().is_empty());
    slug.or(s.repo_path.as_deref())
        .and_then(|path| path.rsplit('/').find(|part| !part.is_empty()))
        .filter(|_| !home)
        .map_or_else(
            || "No project".into(),
            |name| crate::text::sanitize(name).to_string(),
        )
}

fn row(s: &Session, now: u64, note: Option<&'static str>) -> Row {
    Row {
        id: s.id.clone(),
        title: crate::text::sanitize(&s.title).to_string(),
        repo: repo_label(s),
        age: crate::clock::age(crate::clock::timestamp(&s.last_message_at), now),
        note,
    }
}

fn newest_first(a: &Session, b: &Session) -> std::cmp::Ordering {
    crate::clock::timestamp(&b.last_message_at)
        .cmp(&crate::clock::timestamp(&a.last_message_at))
        .then_with(|| a.id.cmp(&b.id))
}

/// Why a thread waits on you, and how soon it is listed. A question or an
/// approval comes first, as at the top of the sidebar's Inbox; the rest
/// follow the sidebar's attention bands.
fn attention(s: &Session) -> Option<(u8, &'static str)> {
    if needs_input(s) {
        return Some((u8::MAX, "Waiting on you"));
    }
    Some(match crate::sidebar::rank(s) {
        5 => (5, "Failed"),
        4 => (4, "Changes requested"),
        2 => (2, "Review ready"),
        1 => (1, "Merged"),
        _ if s.unread => (0, "Unread"),
        _ => return None,
    })
}

/// Threads waiting on you: questions and approvals, then the most urgent,
/// then newest. A thread snoozed in the sidebar stays out until it wakes.
pub(crate) fn needs_you(
    sessions: &[Session],
    snoozes: &BTreeMap<String, u64>,
    current: Option<&str>,
    now: u64,
) -> Vec<Row> {
    let mut waiting: Vec<_> = sessions
        .iter()
        .filter(|s| listable(s, current))
        .filter(|s| !snoozes.get(&s.id).is_some_and(|until| *until > now))
        .filter_map(|s| attention(s).map(|(urgency, note)| (urgency, s, note)))
        .collect();
    waiting.sort_by(|(a_rank, a, _), (b_rank, b, _)| {
        b_rank.cmp(a_rank).then_with(|| newest_first(a, b))
    });
    waiting
        .into_iter()
        .take(ROWS)
        .map(|(_, s, note)| row(s, now, Some(note)))
        .collect()
}

/// The last threads with any message, newest first.
pub(crate) fn recent(sessions: &[Session], current: Option<&str>, now: u64) -> Vec<Row> {
    let mut listed: Vec<_> = sessions.iter().filter(|s| listable(s, current)).collect();
    listed.sort_by(|a, b| newest_first(a, b));
    listed
        .into_iter()
        .take(ROWS)
        .map(|s| row(s, now, None))
        .collect()
}

/// A thread whose work finished: merged, released or completed.
fn finished(s: &Session) -> bool {
    let status = s.status.trim().to_lowercase();
    let outcome = s.outcome.as_deref().unwrap_or("").trim().to_lowercase();
    matches!(status.as_str(), "merged" | "released" | "completed") || outcome == "merged"
}

/// Local midnight at the start of each of the last `DAYS` days, oldest first,
/// the last one today. Each is asked of the calendar: a day is 23 or 25 hours
/// long when the clocks change, so counting back in 24-hour steps put a
/// thread on the wrong day.
pub(crate) fn day_starts(now: u64) -> [u64; DAYS] {
    let mut starts = [0; DAYS];
    let mut start = crate::shell::sidebar::calendar_midnight(now);
    for slot in starts.iter_mut().rev() {
        *slot = start;
        start = crate::shell::sidebar::calendar_midnight(start.saturating_sub(1));
    }
    starts
}

/// Finished threads per day over the last twelve weeks, oldest first, the last
/// cell today. A thread counts on the day of its last message, since the
/// listing carries no separate finish time; a time ahead of this clock counts
/// as today.
pub(crate) fn finished_by_day(sessions: &[Session], starts: &[u64; DAYS]) -> [u32; DAYS] {
    let mut days = [0; DAYS];
    for s in sessions
        .iter()
        .filter(|s| s.machine.is_none() && s.parent_inbox_subject.is_none() && finished(s))
    {
        let Some(at) = crate::clock::timestamp(&s.last_message_at) else {
            continue;
        };
        // The last day that had started by then; none means before the window.
        if let Some(day) = starts.partition_point(|start| *start <= at).checked_sub(1) {
            days[day] += 1;
        }
    }
    days
}

/// The heatmap's one line: the last seven days, then the twelve weeks.
pub(crate) fn week_total(days: &[u32; DAYS]) -> String {
    let week: u32 = days[DAYS - 7..].iter().sum();
    let all: u32 = days.iter().sum();
    format!("{week} in the last 7 days · {all} in 12 weeks")
}

/// A cell's strength, 0 empty to 4 the busiest day.
pub(crate) fn level(count: u32, most: u32) -> u8 {
    if count == 0 || most == 0 {
        0
    } else {
        (count * 4).div_ceil(most).clamp(1, 4) as u8
    }
}

impl Surface {
    /// The open thread has nothing in it yet: a chat New chat made, with no
    /// messages, no turn running and no send on its way.
    pub(crate) fn empty_chat(&self) -> bool {
        let Some(id) = self.selected.as_ref() else {
            return false;
        };
        id.starts_with("thoughts-next-")
            && self.rows.is_empty()
            && !self.turn_running()
            && !self.saving
            && !self.pending.contains_key(id)
            && self.queued_items().is_empty()
            && self
                .sessions
                .iter()
                .find(|s| &s.id == id)
                .is_some_and(|s| s.message_count == 0)
    }

    /// The shell's whole thread list, which the overview reads; this surface
    /// otherwise holds only its own workspace's threads.
    pub(crate) fn shell_overview(
        &mut self,
        sessions: &[Session],
        snoozes: &BTreeMap<String, u64>,
        cx: &mut Context<Self>,
    ) {
        let mut changed = false;
        if self.overview_sessions.as_slice() != sessions {
            self.overview_sessions = sessions.to_vec();
            changed = true;
        }
        if &self.overview_snoozes != snoozes {
            self.overview_snoozes = snoozes.clone();
            changed = true;
        }
        if changed && self.empty_chat() {
            cx.notify();
        }
    }

    fn overview_source(&self) -> &[Session] {
        if self.overview_sessions.is_empty() {
            &self.sessions
        } else {
            &self.overview_sessions
        }
    }

    /// The four cards, as wide as the composer: two columns when the pane
    /// gives each its minimum width, else one.
    pub(crate) fn empty_overview(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if !self.empty_chat() {
            return None;
        }
        let now = crate::clock::now();
        let sessions = self.overview_source();
        let current = self.selected.as_deref();
        let needs = needs_you(sessions, &self.overview_snoozes, current, now);
        let recents = recent(sessions, current, now);
        let days = finished_by_day(sessions, &day_starts(now));
        let cards = [
            self.list_card(
                "Needs you",
                "empty-overview-needs",
                needs,
                "Nothing needs you.",
                cx,
            ),
            self.list_card(
                "Recent threads",
                "empty-overview-recent",
                recents,
                "No other threads yet.",
                cx,
            ),
            usage_card(),
            heat_card(&days),
        ];
        // The width cap sits on a frame around the wrapping row. The layout
        // engine wraps a capped row at the pane's width, not at its cap, so a
        // capped row kept all four cards on one line and ran past the composer.
        let row = div()
            .debug_selector(|| "empty-overview".into())
            .w_full()
            .flex()
            .flex_wrap()
            .gap(px(GAP))
            .children(cards.into_iter().enumerate().map(|(index, card)| {
                let delay = STAGGER_MS * index as u64;
                let total = FADE_MS + delay;
                card.with_animation(
                    ("empty-overview-fade", index),
                    Animation::new(std::time::Duration::from_millis(total)),
                    move |card, delta| {
                        let elapsed = delta * total as f32 - delay as f32;
                        card.opacity(crate::motion::ease_out(
                            (elapsed / FADE_MS as f32).clamp(0., 1.),
                        ))
                    },
                )
            }));
        Some(
            div()
                .w_full()
                .max_w(px(crate::theme::chat_width()))
                .mx_auto()
                .pt(px(20.))
                .pb(px(24.))
                .child(row)
                .into_any_element(),
        )
    }

    fn list_card(
        &self,
        title: &'static str,
        selector: &'static str,
        rows: Vec<Row>,
        empty: &'static str,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let body = if rows.is_empty() {
            div()
                .px(px(8.))
                .h(px(28.))
                .flex()
                .items_center()
                .text_size(px(12.))
                .text_color(theme().text_muted)
                .child(empty)
        } else {
            div()
                .flex()
                .flex_col()
                .children(rows.into_iter().enumerate().map(|(index, row)| {
                    let link = crate::lineage::link(&row.id);
                    let meta = match row.note {
                        Some(note) => format!("{note} · {}", row.repo),
                        None => row.repo,
                    };
                    div()
                        .id((selector, index))
                        .debug_selector(move || format!("{selector}-{index}"))
                        .h(px(28.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .rounded(px(7.))
                        .cursor_pointer()
                        .hover(|row| row.bg(theme().hover))
                        .text_size(px(12.5))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .text_ellipsis()
                                .whitespace_nowrap()
                                .text_color(theme().text)
                                .child(row.title),
                        )
                        .child(
                            div()
                                .flex_shrink()
                                .min_w_0()
                                .max_w(px(150.))
                                .overflow_hidden()
                                .text_ellipsis()
                                .whitespace_nowrap()
                                .text_size(px(12.))
                                .text_color(theme().text_muted)
                                .child(meta),
                        )
                        .child(
                            crate::shell::sidebar::tabular(div())
                                .flex_shrink_0()
                                .w(px(28.))
                                .flex()
                                .justify_end()
                                .text_size(px(12.))
                                .text_color(theme().text_faint)
                                .child(row.age),
                        )
                        .on_click(cx.listener(move |_, _, window, cx| {
                            crate::ui::open_link(&link, window, cx);
                        }))
                }))
        };
        card(title, selector).child(body)
    }
}

/// A card: a hairline frame over whatever the pane shows, never a fill, so it
/// reads the same on every appearance including glass.
fn card(title: &'static str, selector: &'static str) -> gpui::Div {
    div()
        .debug_selector(move || selector.into())
        .flex_grow()
        .flex_basis(gpui::relative(CARD_SHARE))
        .min_w(px(CARD_MIN))
        .overflow_hidden()
        .p(px(8.))
        .flex()
        .flex_col()
        .gap(px(4.))
        .rounded(px(12.))
        .border_1()
        .border_color(theme().border)
        .child(
            div()
                .px(px(8.))
                .pt(px(2.))
                .pb(px(2.))
                .text_size(px(12.))
                .text_color(theme().text_secondary)
                .child(title),
        )
}

/// The rail's usage card, runtime by runtime, from the rail's last read.
fn usage_card() -> gpui::Div {
    let snapshot = crate::shell::rail::last_usage_snapshot();
    let now = crate::shell::rail::now_seconds();
    let capacities = snapshot
        .as_ref()
        .and_then(|snapshot| snapshot["capacities"].as_array().cloned())
        .unwrap_or_default();
    let quiet = |text: &'static str| {
        div()
            .px(px(8.))
            .h(px(28.))
            .flex()
            .items_center()
            .text_size(px(12.))
            .text_color(theme().text_muted)
            .child(text)
    };
    card("Usage", "empty-overview-usage").child(
        crate::shell::sidebar::tabular(div())
            .px(px(8.))
            .pb(px(4.))
            .flex()
            .flex_col()
            .gap(px(10.))
            .text_color(theme().text)
            .children(
                capacities
                    .iter()
                    .map(|capacity| crate::shell::rail::usage_runtime(capacity, now)),
            )
            .when(snapshot.is_none(), |body| {
                body.child(quiet("Reading connected runtimes…"))
            })
            .when(snapshot.is_some() && capacities.is_empty(), |body| {
                body.child(quiet("No connected runtime reports usage yet."))
            }),
    )
}

/// Twelve weeks of finished threads, a column a week, and their total.
fn heat_card(days: &[u32; DAYS]) -> gpui::Div {
    let most = days.iter().copied().max().unwrap_or(0);
    let accent = theme().accent;
    let cell = |count: u32| {
        let strength = level(count, most);
        div()
            .size(px(10.))
            .rounded(px(2.))
            .border_1()
            .border_color(theme().border)
            .when(strength > 0, |cell| {
                cell.bg(gpui::Rgba {
                    a: accent.a * [0., 0.3, 0.5, 0.75, 1.][strength as usize],
                    ..accent
                })
            })
    };
    card("Finished threads", "empty-overview-week").child(
        div()
            .px(px(8.))
            .pb(px(4.))
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                div()
                    .flex()
                    .gap(px(3.))
                    .children(days.chunks(7).map(|week| {
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(3.))
                            .children(week.iter().map(|count| cell(*count)))
                    })),
            )
            .child(
                crate::shell::sidebar::tabular(div())
                    .text_size(px(12.))
                    .text_color(theme().text_muted)
                    .child(week_total(days)),
            ),
    )
}

#[cfg(test)]
#[path = "empty_overview_tests.rs"]
mod tests;
