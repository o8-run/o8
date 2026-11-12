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
    /// Whether the drawer lists its threads: open, or still closing on screen.
    pub(super) fn drawer_rows_shown(&self) -> bool {
        !self.working_closed || self.drawer_motion.is_some_and(|(_, opening)| !opening)
    }

    /// The drawer's header row in the list, while anything runs.
    pub(super) fn drawer_at(&self) -> Option<usize> {
        (self.view() != folders::View::Inbox)
            .then(|| self.top_len())
            .filter(|at| *at < self.rows.len())
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
        self.sessions
            .iter()
            .find(|s| &s.id == id)
            .and_then(|s| s.run_started_at.as_deref())
            .and_then(recents::timestamp)
            .map(|start| detailed::elapsed(start, recents::now()))
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
        let keyboard = self.focus.is_focused(window);
        let row_height = if self.cards() { detailed::ROW_HEIGHT } else { 28. } + 2.;
        let body: Vec<AnyElement> = (at + 1..self.rows.len())
            .map(|i| {
                div()
                    .w_full()
                    .flex_shrink_0()
                    .py(px(1.))
                    .child(self.render_row(i, keyboard, cx))
                    .into_any_element()
            })
            .collect();
        let full = body.len() as f32 * row_height + 2.;
        // The dot breathes once a second, as the Inbox's terminal mark.
        let pulse = if recents::now() % 2 == 1 { 0.45 } else { 1. };
        let open = !self.working_closed;
        let header = div()
            .id("sidebar-working-header")
            .debug_selector(|| "sidebar-working-header".into())
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
            .text_color(theme().text_muted)
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
        let rows = (!body.is_empty()).then(|| {
            div()
                .id("sidebar-working-rows")
                .debug_selector(|| "sidebar-working-rows".into())
                .w_full()
                .min_h_0()
                .flex_shrink()
                .h(px(full * openness))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .children(body)
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
