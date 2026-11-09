//! The Inbox's rows, as T3 Code draws them: a three-line card for active and
//! working threads, a slim line for snoozed and settled ones, and the folding
//! Working, Snoozed and Settled shelves pinned to the foot of the sidebar.
//!
//! Adapted from T3 Code (https://github.com/pingdotgg/t3code),
//! apps/web/src/components/sidebar/SidebarThreadRow.tsx (card and slim rows,
//! status labels), apps/web/src/components/Sidebar.tsx (the foot shelves) and
//! apps/web/src/components/ui/collapsible-section-header.tsx, commit
//! 8f144827f6. Copyright (c) 2026 T3 Tools Inc. MIT; full notice retained in
//! src/lib/usage/history-readers/LICENSE.txt. Adaptations: Rust and GPUI,
//! o8's fonts, colours and words; icons are Lucide's.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, Rgba, div, px};

/// A card's height: three lines and their padding (T3's 4.875rem row, set in o8's type).
pub(crate) const CARD_HEIGHT: f32 = 74.;
/// A snoozed or settled thread's single line.
pub(crate) const SLIM_HEIGHT: f32 = 34.;
/// The hover controls' width: Snooze and the Settle pill.
const CONTROLS_WIDTH: f32 = 84.;
/// A shelf's folded header.
pub(crate) const SHELF_HEIGHT: f32 = 30.;

// Lucide icons.
const CIRCLE_DASHED: &str = "M10.1 2.182a10 10 0 0 1 3.8 0 M13.9 21.818a10 10 0 0 1-3.8 0 M17.609 3.721a10 10 0 0 1 2.69 2.7 M2.182 13.9a10 10 0 0 1 0-3.8 M20.279 17.609a10 10 0 0 1-2.7 2.69 M21.818 10.1a10 10 0 0 1 0 3.8 M3.721 6.391a10 10 0 0 1 2.7-2.69 M6.391 20.279a10 10 0 0 1-2.69-2.7";
const SHIELD_QUESTION: &str = "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3 M12 17h.01";
const MESSAGE_QUESTION: &str = "M7.9 20A9 9 0 1 0 4 16.1L2 22Z M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3 M12 17h.01";
const CIRCLE_ALERT: &str = "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 8v4 M12 16h.01";
const CIRCLE_CHECK: &str = "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M9 12l2 2 4-4";
const ALARM_CLOCK: &str = "M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M12 9v4l2 2 M5 3 2 6 M22 6l-3-3 M6.38 18.7 4 21 M17.64 18.67 20 21";
const ALARM_CLOCK_OFF: &str = "M6.87 6.87a8 8 0 1 0 11.26 11.26 M19.9 14.25a8 8 0 0 0-9.15-9.15 M22 6l-3-3 M6.26 18.67 4 21 M2 2l20 20 M4 4 2 6";
const CLOCK: &str = "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2";
const UNDO: &str = "M9 14 4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11";
const BRANCH: &str = "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9";
const TERMINAL: &str = "M4 17l6-6-6-6 M12 19h8";
const CHEVRON_DOWN: &str = "M6 9l6 6 6-6";
const CHEVRON_RIGHT: &str = "M9 6l6 6-6 6";

/// The status on a card's first line: T3's icon, label and colour, on the
/// states o8 tracks.
pub(crate) struct Status {
    pub key: &'static str,
    pub icon: &'static str,
    pub label: String,
    pub color: Rgba,
}

/// T3's indigo for a question waiting on you.
fn input_color() -> Rgba {
    if crate::theme::light() {
        gpui::rgb(0x4f46e5)
    } else {
        gpui::rgb(0xa5b4fc)
    }
}

/// What a card says on the right of its first line; `None` leaves its age.
pub(crate) fn status(s: &Session, woke: bool, now: u64) -> Option<Status> {
    let rank = sidebar::rank(s);
    let status = s.status.trim().to_lowercase();
    let make = |key, icon, label: &str, color| Some(Status { key, icon, label: label.into(), color });
    match rank {
        5 => return make("failed", CIRCLE_ALERT, "Failed", theme().danger),
        4 => return make("rejected", CIRCLE_ALERT, "Rejected", crate::theme::rejected_mark()),
        3 => return make("input", MESSAGE_QUESTION, "Input", input_color()),
        2 if matches!(status.as_str(), "approval") => {
            return make("approval", SHIELD_QUESTION, "Approval", theme().warning);
        }
        2 => return make("review", SHIELD_QUESTION, "Review", theme().warning),
        _ => {}
    }
    if sidebar::working(s) || matches!(status.as_str(), "launching" | "recovering") {
        // Working counts its run, second by second.
        let timer = s
            .run_started_at
            .as_deref()
            .and_then(recents::timestamp)
            .map(|start| run_timer(now.saturating_sub(start)));
        let label = match timer {
            Some(timer) => format!("Working {timer}"),
            None => "Working".into(),
        };
        return Some(Status { key: "working", icon: CIRCLE_DASHED, label, color: theme().accent });
    }
    if woke {
        return make("woke", ALARM_CLOCK, "Woke", theme().warning);
    }
    if rank == 1 {
        return make("done", CIRCLE_CHECK, "Done", theme().success);
    }
    None
}

/// A small square icon button that shows on the row's hover.
fn icon_button(id: String, icon: &'static str, tip: &'static str) -> gpui::Stateful<gpui::Div> {
    let selector = id.clone();
    div()
        .id(gpui::ElementId::Name(id.into()))
        .debug_selector(move || selector.clone())
        .size(px(20.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(5.))
        .cursor_pointer()
        .hover(|v| v.bg(theme().hover))
        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.into())).into())
        .child(crate::icon::stroke(icon, theme().text_muted, 13., 1.9))
}

impl ThreadList {
    /// The project mark on a row: the repository's icon, else its initial.
    fn row_identity(&self, row: &Row, size: f32) -> AnyElement {
        let name = label(&row.workspace);
        let selector = format!("thread-identity-{}", row.id.as_deref().unwrap_or_default());
        super::project_header::repo_identity(
            &name,
            None,
            self.repo_icon(&row.workspace),
            size,
            &selector,
        )
    }

    /// The card's hover controls: Snooze and Settle, in place of the status.
    fn card_controls(&self, row: &Row, cx: &mut Context<Self>) -> Option<AnyElement> {
        let id = row.id.clone()?;
        let session = self.settleable(&id)?;
        let settled = session.settled();
        let snooze_id = id.clone();
        let settle_id = id.clone();
        let label = if settled { "Un-settle" } else { "Settle" };
        let icon = if settled { UNDO } else { super::folders::CHECK };
        let selector = format!("thread-settle-{id}");
        Some(
            div()
                .flex()
                .items_center()
                .gap(px(2.))
                .when(self.snoozable(&id), |v| {
                    v.child(
                        icon_button(format!("thread-snooze-{id}"), CLOCK, "Snooze").on_click(
                            cx.listener(move |this, event: &gpui::ClickEvent, _, cx| {
                                cx.stop_propagation();
                                this.open_snooze_menu(&snooze_id, event.position(), cx);
                            }),
                        ),
                    )
                })
                .child(
                    div()
                        .id(gpui::ElementId::Name(format!("settle:{id}").into()))
                        .debug_selector(move || selector.clone())
                        .h(px(20.))
                        .px(px(6.))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .rounded(px(5.))
                        .cursor_pointer()
                        .text_size(px(11.5))
                        .font_weight(gpui::FontWeight(450.))
                        .text_color(theme().text_secondary)
                        .hover(|v| v.bg(theme().hover).text_color(theme().text))
                        .opacity(if self.settling.is_some() { 0.5 } else { 1. })
                        .child(crate::icon::stroke(icon, theme().text_secondary, 11., 2.4))
                        .child(label)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.focus.focus(window);
                            this.settle_id(settle_id.clone(), cx);
                        })),
                )
                .into_any_element(),
        )
    }

    /// A card's three lines: project and status, the title, then the branch
    /// with its PR and terminal.
    pub(super) fn card_content(&self, row: &Row, cx: &mut Context<Self>) -> AnyElement {
        let id = row.id.clone().unwrap_or_default();
        let session = self.sessions.iter().find(|s| s.id == id);
        let now = recents::now();
        let woke = row.marker == "back";
        let status = session.and_then(|s| status(s, woke, now));
        let secondary = theme().text_secondary;
        let faint = theme().text_faint;
        let project = session
            .and_then(|s| s.repo_slug.as_deref())
            .filter(|r| !r.is_empty())
            .map(|r| r.rsplit('/').next().unwrap_or(r).to_owned())
            .unwrap_or_else(|| label(&row.workspace));
        let status_id = id.clone();
        let status_slot = match status {
            Some(st) => {
                let key = st.key;
                div()
                    .debug_selector(move || format!("thread-status-{key}-{status_id}"))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .text_size(px(11.5))
                    .font_weight(gpui::FontWeight(450.))
                    .text_color(st.color)
                    .child(crate::icon::stroke(st.icon, st.color, 13., 1.9))
                    .child(st.label)
            }
            None => div()
                .debug_selector(move || format!("thread-age-{status_id}"))
                .text_size(px(11.))
                .text_color(faint)
                .child(row.age.clone()),
        };
        let controls = self.card_controls(row, cx);
        let has_controls = controls.is_some();
        let first = div()
            .h(px(16.))
            .flex()
            .items_center()
            .gap(px(6.))
            .child(self.row_identity(row, 14.))
            .children(self.pin_mark(&id))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_size(px(11.5))
                    .text_color(secondary)
                    .child(row.on_machine(project)),
            )
            .children(self.auto_off_mark(&id))
            .child(
                div()
                    .relative()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_end()
                    // The slot keeps room for the hover controls, so they never
                    // draw over the project name. (GPUI cannot change layout on
                    // hover: hiding an element there skips its prepaint.)
                    .when(has_controls, |slot| slot.min_w(px(CONTROLS_WIDTH)))
                    .child(status_slot.group_hover("thread-row", move |s| {
                        if has_controls { s.invisible() } else { s }
                    }))
                    .children(controls.map(|controls| {
                        div()
                            .absolute()
                            .right_0()
                            .top(px(-2.))
                            .invisible()
                            .group_hover("thread-row", |s| s.visible())
                            .child(controls)
                    })),
            );
        let title = div()
            .whitespace_nowrap()
            .overflow_hidden()
            .text_ellipsis()
            .text_size(px(13.5))
            .font_weight(gpui::FontWeight(450.))
            .text_color(theme().text)
            .child(crate::text::sanitize(&row.title));
        let working = session.is_some_and(sidebar::working);
        let mut third = div()
            .h(px(16.))
            .flex()
            .items_center()
            .gap(px(6.))
            .text_size(px(11.))
            .text_color(faint)
            .children(session.and_then(|s| self.branch_of(s)).map(|b| {
                let sid = id.clone();
                div()
                    .debug_selector(move || format!("thread-branch-{sid}"))
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .child(crate::icon::stroke(BRANCH, faint, 11., 2.))
                    .child(
                        div()
                            .min_w_0()
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(b),
                    )
            }))
            .child(div().flex_1())
            .children(self.workspace_parked_detail(&id))
            .children(self.pr_badge(&id, cx));
        if session.is_some_and(|s| s.tmux_session.as_deref().is_some_and(|t| !t.is_empty())) {
            // T3's terminal pulse: full, then half, every other second while it works.
            let pulse = if working && now % 2 == 1 { 0.5 } else { 1. };
            let color = if crate::theme::light() { gpui::rgb(0x0d9488) } else { gpui::rgb(0x5eead4) };
            let sid = id.clone();
            third = third.child(
                div()
                    .id(gpui::ElementId::Name(format!("thread-terminal-{sid}").into()))
                    .debug_selector(move || format!("thread-terminal-{sid}"))
                    .opacity(pulse)
                    .tooltip(|_, cx| cx.new(|_| crate::icon::Tip("Terminal running".into())).into())
                    .child(crate::icon::stroke(TERMINAL, color, 12., 2.)),
            );
        }
        div()
            .flex()
            .flex_col()
            .justify_center()
            .flex_1()
            .min_w_0()
            .px(px(4.))
            .gap(px(4.))
            .child(first)
            .child(title)
            .child(third)
            .into_any_element()
    }

    /// A snoozed or settled thread on one line: faded mark, title, and its
    /// time, with Wake or Un-settle on hover.
    pub(super) fn slim_content(&self, row: &Row, cx: &mut Context<Self>) -> AnyElement {
        let id = row.id.clone().unwrap_or_default();
        let snoozed = row.marker == "snoozed";
        let time = div()
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap(px(4.))
            .text_size(px(11.))
            .text_color(if snoozed { theme().accent } else { theme().text_faint })
            .when(snoozed, |v| v.child(crate::icon::stroke(ALARM_CLOCK, theme().accent, 12., 1.9)))
            .child(row.age.clone());
        let action = if snoozed {
            let wake = id.clone();
            Some(icon_button(format!("thread-wake-{id}"), ALARM_CLOCK_OFF, "Wake").on_click(
                cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    this.snooze(wake.clone(), None, cx);
                }),
            ))
        } else {
            self.settleable(&id).map(|_| {
                let unsettle = id.clone();
                icon_button(format!("thread-settle-{id}"), UNDO, "Un-settle").on_click(
                    cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.focus.focus(window);
                        this.settle_id(unsettle.clone(), cx);
                    }),
                )
            })
        };
        let has_action = action.is_some();
        div()
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap(px(9.))
            .px(px(4.))
            .child(
                div()
                    .opacity(0.45)
                    .group_hover("thread-row", |s| s.opacity(1.))
                    .child(self.row_identity(row, 14.)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_size(px(13.))
                    .text_color(theme().text_secondary)
                    .child(crate::text::sanitize(&row.title)),
            )
            .child(
                div()
                    .relative()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .when(has_action, |slot| slot.min_w(px(20.)).justify_end())
                    .child(time.group_hover("thread-row", move |s| if has_action { s.invisible() } else { s }))
                    .children(action.map(|action| {
                        div()
                            .absolute()
                            .right_0()
                            .top(px(-3.))
                            .invisible()
                            .group_hover("thread-row", |s| s.visible())
                            .child(action)
                    })),
            )
            .into_any_element()
    }

    /// A shelf's header: its name, count and a chevron; a click folds it.
    pub(super) fn shelf_header(&self, row: &Row, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        let name = row.title.clone();
        let open = row.status == "open";
        let selector = format!("sidebar-shelf-{}", name.to_lowercase());
        div()
            .id(gpui::ElementId::Name(selector.clone().into()))
            .debug_selector(move || selector.clone())
            .w_full()
            .h(px(SHELF_HEIGHT))
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(10.))
            .rounded(px(6.))
            .cursor_pointer()
            .hover(|v| v.bg(theme().hover))
            .text_size(px(12.))
            .font_weight(gpui::FontWeight(450.))
            .text_color(theme().text_muted)
            .child(div().flex_1().child(name.clone()))
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_faint)
                    .child(row.age.clone()),
            )
            .child(crate::icon::stroke(
                if open { CHEVRON_DOWN } else { CHEVRON_RIGHT },
                theme().text_faint,
                12.,
                2.,
            ))
            .on_click(cx.listener(move |this, _, _, cx| {
                let key = super::inbox::open_key(&name);
                if !this.expanded.remove(&key) {
                    this.expanded.insert(key);
                }
                this.rebuild();
                cx.notify();
            }))
    }

    /// Keeps Working timers counting: one repaint a second while any is shown.
    pub(super) fn tick_working(&mut self, cx: &mut Context<Self>) {
        if self.second_tick || self.view() != folders::View::Inbox {
            return;
        }
        let shown = self.rows.iter().any(|r| r.running && r.id.is_some());
        if !shown {
            return;
        }
        self.second_tick = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(std::time::Duration::from_millis(1000)).await;
            let _ = this.update(cx, |this, cx| {
                this.second_tick = false;
                cx.notify();
            });
        })
        .detach();
    }
}

/// A run's clock keeps its seconds: "42s", "1m 05s", "1h 02m 05s".
pub(super) fn run_timer(secs: u64) -> String {
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m {:02}s", secs / 60, secs % 60),
        _ => format!("{}h {:02}m {:02}s", secs / 3600, secs % 3600 / 60, secs % 60),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn run_timer_keeps_seconds() {
        assert_eq!(super::run_timer(42), "42s");
        assert_eq!(super::run_timer(65), "1m 05s");
        assert_eq!(super::run_timer(3725), "1h 02m 05s");
    }
}
