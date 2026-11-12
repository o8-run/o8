//! The Working drawer: running threads leave the list for a drawer pinned to
//! the foot of the sidebar, so the list above holds what needs the person.
//! Closed it is one row (a pulsing dot, "Working", the count, a chevron);
//! open it grows upward to show the running threads, scrolling past a share
//! of the sidebar. Its threads stay in the row list after the main list, so
//! the keyboard, selection, drag and bulk picks reach them in that order.
//!
//! The idea follows T3 Code's sidebar (https://github.com/pingdotgg/t3code,
//! MIT). Reimplemented in Rust and GPUI; no code shared.
use super::inbox_card::tabular;
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, px};
use std::time::{Duration, Instant};

/// A click opens or closes the drawer over this long, easing out.
pub(crate) const MOTION: Duration = Duration::from_millis(180);
/// The drawer's largest share of the sidebar's height; past it the rows scroll.
const MAX_SHARE: f32 = 0.4;
pub(crate) const HEADER_HEIGHT: f32 = 30.;
/// Lucide chevrons: up while closed (it opens upward), down while open.
const CHEVRON_UP: &str = "M18 15l-6-6-6 6";
const CHEVRON_DOWN: &str = "M6 9l6 6 6-6";

impl ThreadList {
    /// Whether running threads fold into the drawer: it is on, outside the
    /// Inbox, and no search lists them in place.
    pub(super) fn drawer_on(&self) -> bool {
        self.working_section
            && self.view() != folders::View::Inbox
            && self.query.trim().is_empty()
    }

    /// Moves the sessions bound for the drawer (running, not asking for
    /// input, not pinned) to the end, keeping both parts' order, and counts
    /// them. The list's groups are built without them, so a run never takes
    /// a place under a group's cap. A stable sort of the owned copy: no
    /// extra clone per rebuild.
    pub(super) fn drawer_runs(&self, sessions: &mut [Session]) -> usize {
        if !self.drawer_on() {
            return 0;
        }
        let pinned = pins::pinned_order(sessions);
        let run = |s: &Session| self.drawer_run(s, &pinned);
        let count = sessions.iter().filter(|s| run(s)).count();
        if count > 0 {
            sessions.sort_by_key(|s| run(s));
        }
        count
    }

    /// Whether a session belongs in the drawer: running, not asking for
    /// input, not pinned, and not archived or being archived.
    pub(super) fn drawer_run(&self, s: &Session, pinned: &[String]) -> bool {
        self.drawer_on()
            && sidebar::working(s)
            && !inbox::needs_input(s)
            && !pinned.contains(&s.id)
            && s.status != "archived"
            && !self.archiving.contains_key(&s.id)
    }

    /// An archive or restore answered: the thread leaves the in-flight set
    /// and the list rebuilds. A successful archive marks the thread archived
    /// at once, so it does not flash back into the drawer before the reload.
    pub(super) fn archive_done(&mut self, id: &str, ok: bool) {
        let Some(archiving) = self.archiving.remove(id) else {
            return;
        };
        if ok
            && archiving
            && let Some(session) = self.sessions.iter_mut().find(|s| s.id == id)
        {
            session.status = "archived".into();
        }
        self.rebuild();
    }

    /// Whether the drawer lists its threads: open, or still closing on screen.
    pub(super) fn drawer_rows_shown(&self) -> bool {
        !self.working_closed || self.drawer_motion.is_some_and(|(_, opening)| !opening)
    }

    /// The one scan for the drawer's header, made per rebuild and counted
    /// in tests; painting reads `drawer_index` instead.
    pub(super) fn find_drawer(&self, rows: &[Row]) -> Option<usize> {
        #[cfg(test)]
        self.drawer_scans.set(self.drawer_scans.get() + 1);
        rows.iter().position(|r| r.kind == "drawer")
    }

    /// The drawer's header row in the list, while anything runs.
    pub(super) fn drawer_at(&self) -> Option<usize> {
        self.drawer_index
    }

    /// Opens or closes the drawer; a click animates, the keyboard does not.
    pub(super) fn toggle_drawer(&mut self, animate: bool, cx: &mut Context<Self>) {
        self.working_closed = !self.working_closed;
        self.drawer_motion = animate.then(|| (Instant::now(), !self.working_closed));
        // The keyboard choice leaves folding rows for the list's last thread.
        if self.working_closed
            && let Some(at) = self.drawer_at()
            && self.rows[at..].iter().any(|r| r.id.is_some() && r.id == self.choice)
        {
            self.choice = self.rows[..at].iter().rev().find_map(|r| r.id.clone());
        }
        self.save_row_mode(cx);
    }

    /// The date group each drawer thread left, for tests that count a run
    /// out of its group.
    #[cfg(test)]
    pub(crate) fn drawer_groups(&self) -> Vec<&'static str> {
        let now = recents::now();
        self.sessions
            .iter()
            .filter(|s| self.drawer_threads.contains_key(&s.id))
            .map(|s| recents::group(s, now))
            .collect()
    }

    /// Opens the drawer, for tests that follow a running thread into it.
    #[cfg(test)]
    pub(crate) fn open_drawer(&mut self) {
        self.working_closed = false;
        self.rebuild();
    }

    /// Down from the list's last thread, or End, opens a closed drawer at
    /// once, so its threads follow the list in the keyboard order.
    pub(super) fn drawer_key(&mut self, key: &str, cx: &mut Context<Self>) {
        let Some(at) = self.drawer_at().filter(|_| self.working_closed) else {
            return;
        };
        let last = self.rows[..at].iter().rev().find_map(|r| r.id.as_ref());
        if key == "end" || key == "down" && (last.is_none() || last == self.choice.as_ref()) {
            self.toggle_drawer(false, cx);
        }
    }

    /// How far open the drawer stands, 0 to 1, easing while it moves. A
    /// finished close drops the drawer's rows from the list.
    pub(super) fn drawer_openness(&mut self, window: &mut Window, cx: &mut Context<Self>) -> f32 {
        let Some((start, opening)) = self.drawer_motion else {
            return if self.working_closed { 0. } else { 1. };
        };
        let t = start.elapsed().as_secs_f32() / MOTION.as_secs_f32();
        if t >= 1. {
            self.drawer_motion = None;
            if !opening {
                self.rebuild();
            }
            return if opening { 1. } else { 0. };
        }
        cx.on_next_frame(window, |_, _, cx| cx.notify());
        let eased = crate::motion::ease_out(t);
        if opening { eased } else { 1. - eased }
    }

    /// A drawer row's run time, counted from when its run started.
    pub(super) fn drawer_age(&self, i: usize) -> Option<String> {
        self.drawer_at().filter(|at| i > *at)?;
        let id = self.rows.get(i)?.id.as_ref()?;
        let start = (*self.drawer_threads.get(id)?)?;
        Some(detailed::elapsed(start, recents::now()))
    }

    /// The drawer: a hairline over its header, then its threads when open.
    pub(super) fn drawer(
        &mut self,
        openness: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let at = self.drawer_at()?;
        let count = self.rows[at].age.clone();
        let row_height = if self.cards() { detailed::ROW_HEIGHT } else { 28. } + 2.;
        let threads = self.rows.len() - at - 1;
        let full = threads as f32 * row_height + 2.;
        // The dot breathes once a second, as the Inbox's terminal mark.
        let pulse = if recents::now() % 2 == 1 { 0.45 } else { 1. };
        let open = !self.working_closed;
        // The open thread sits in the closed drawer: its header carries the
        // selection, so the person sees where the thread went.
        let holds_selection = !self.drawer_rows_shown()
            && self.selected.as_ref().is_some_and(|id| self.drawer_threads.contains_key(id));
        let header = div()
            .id("sidebar-working-header")
            .debug_selector(|| "sidebar-working-header".into())
            .relative()
            .w_full()
            .flex_shrink_0()
            .h(px(HEADER_HEIGHT))
            .px(px(10.))
            .flex()
            .items_center()
            .gap(px(8.))
            .rounded(px(6.))
            .cursor_pointer()
            .hover(|v| v.bg(theme().hover))
            .text_size(px(12.))
            .font_weight(gpui::FontWeight(450.))
            .text_color(if holds_selection { theme().text } else { theme().text_muted })
            .when(holds_selection, |header| {
                header.child(
                    div()
                        .debug_selector(|| "sidebar-working-selected".into())
                        .absolute()
                        .inset_0()
                        .rounded(px(6.))
                        .bg(theme().selection),
                )
            })
            .child(
                div()
                    .debug_selector(|| "sidebar-working-dot".into())
                    .flex_shrink_0()
                    .size(px(6.))
                    .rounded_full()
                    .bg(theme().accent)
                    .opacity(pulse),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .text_ellipsis()
                    .child("Working"),
            )
            // Unread news inside the closed drawer: the folder's unread dot.
            .when(self.drawer_unread && !self.drawer_rows_shown(), |header| {
                header.child(
                    div()
                        .debug_selector(|| "sidebar-working-unread".into())
                        .size(px(6.))
                        .flex_shrink_0()
                        .rounded_full()
                        .bg(theme().success),
                )
            })
            .child(
                tabular(div())
                    .debug_selector(|| "sidebar-working-count".into())
                    .flex_shrink_0()
                    .text_size(px(11.))
                    .text_color(theme().text_faint)
                    .child(count),
            )
            .child(crate::icon::stroke(
                if open { CHEVRON_DOWN } else { CHEVRON_UP },
                theme().text_faint,
                12.,
                2.,
            ))
            .on_click(cx.listener(|this, _, _, cx| this.toggle_drawer(true, cx)));
        // A virtual list, as the one above: hundreds of runs paint only
        // the rows in view.
        let rows = (threads > 0).then(|| {
            gpui::uniform_list(
                "sidebar-working-rows",
                threads,
                cx.processor(|this, range: std::ops::Range<usize>, window, cx| {
                    let keyboard = this.focus.is_focused(window);
                    let Some(at) = this.drawer_at() else {
                        return Vec::new();
                    };
                    let end = range.end.min(this.rows.len().saturating_sub(at + 1));
                    (range.start.min(end)..end)
                        .map(|k| {
                            div()
                                .w_full()
                                .py(px(1.))
                                .child(this.render_row(at + 1 + k, keyboard, cx))
                        })
                        .collect()
                }),
            )
            .debug_selector(|| "sidebar-working-rows".into())
            .track_scroll(self.drawer_scroll.clone())
            .w_full()
            .min_h_0()
            .flex_shrink()
            .h(px(full * openness))
        });
        Some(
            div()
                .id("sidebar-working-drawer")
                .debug_selector(|| "sidebar-working-drawer".into())
                .w_full()
                .flex_shrink_0()
                .max_h(gpui::relative(MAX_SHARE))
                .flex()
                .flex_col()
                .border_t_1()
                .border_color(theme().border)
                .px(px(6.))
                .pt(px(2.))
                .pb(px(2.))
                .child(header)
                .children(rows)
                .into_any_element(),
        )
    }
}
