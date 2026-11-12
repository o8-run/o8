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
/// How long a thread that stopped working still reads as working.
const WORKING_EXIT_GRACE: std::time::Duration = std::time::Duration::from_secs(2);
/// A row's fade-in on arriving in a section.
const FADE: std::time::Duration = std::time::Duration::from_millis(180);

// Lucide icons.
const CIRCLE_DASHED: &str = "M10.1 2.182a10 10 0 0 1 3.8 0 M13.9 21.818a10 10 0 0 1-3.8 0 M17.609 3.721a10 10 0 0 1 2.69 2.7 M2.182 13.9a10 10 0 0 1 0-3.8 M20.279 17.609a10 10 0 0 1-2.7 2.69 M21.818 10.1a10 10 0 0 1 0 3.8 M3.721 6.391a10 10 0 0 1 2.7-2.69 M6.391 20.279a10 10 0 0 1-2.69-2.7";
const SHIELD_QUESTION: &str = "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3 M12 17h.01";
const MESSAGE_QUESTION: &str =
    "M7.9 20A9 9 0 1 0 4 16.1L2 22Z M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3 M12 17h.01";
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
    crate::theme::inbox_input()
}

/// What a card says on the right of its first line; `None` leaves its age.
pub(crate) fn status(s: &Session, woke: bool, now: u64) -> Option<Status> {
    let rank = sidebar::rank(s);
    let status = s.status.trim().to_lowercase();
    let make = |key, icon, label: &str, color| {
        Some(Status {
            key,
            icon,
            label: label.into(),
            color,
        })
    };
    match rank {
        5 => return make("failed", CIRCLE_ALERT, "Failed", theme().danger),
        4 => {
            return make(
                "rejected",
                CIRCLE_ALERT,
                "Rejected",
                crate::theme::rejected_mark(),
            );
        }
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
        return Some(Status {
            key: "working",
            icon: CIRCLE_DASHED,
            label,
            color: theme().accent,
        });
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
                    .child(tabular(div()).child(st.label))
            }
            None => tabular(div())
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
            let color = crate::theme::inbox_terminal();
            let sid = id.clone();
            third = third.child(
                div()
                    .id(gpui::ElementId::Name(
                        format!("thread-terminal-{sid}").into(),
                    ))
                    .debug_selector(move || format!("thread-terminal-{sid}"))
                    .opacity(pulse)
                    .tooltip(|_, cx| {
                        cx.new(|_| crate::icon::Tip("Terminal running".into()))
                            .into()
                    })
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
        // A server settle's age already reads "merged · 2h": it is the note.
        let auto = !snoozed
            && self
                .sessions
                .iter()
                .any(|s| s.id == id && s.settled() && s.auto_settled_reason.is_some());
        let note_id = id.clone();
        let time = div()
            .when(auto, |v| {
                v.debug_selector(move || format!("thread-auto-note-{note_id}"))
            })
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap(px(4.))
            .text_size(px(11.))
            .text_color(if snoozed {
                theme().accent
            } else {
                theme().text_faint
            })
            .when(snoozed, |v| {
                v.child(crate::icon::stroke(ALARM_CLOCK, theme().accent, 12., 1.9))
            })
            .child(row.age.clone());
        let action = if snoozed {
            let wake = id.clone();
            Some(
                icon_button(format!("thread-wake-{id}"), ALARM_CLOCK_OFF, "Wake").on_click(
                    cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.snooze(wake.clone(), None, cx);
                    }),
                ),
            )
        } else {
            self.settleable(&id).map(|_| {
                let unsettle = id.clone();
                icon_button(format!("thread-settle-{id}"), UNDO, "Un-settle").on_click(cx.listener(
                    move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.focus.focus(window);
                        this.settle_id(unsettle.clone(), cx);
                    },
                ))
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
            // A settled thread whose workspace was parked says so, and what it freed.
            .children(self.workspace_parked_detail(&id))
            .child(
                div()
                    .relative()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .when(has_action, |slot| slot.min_w(px(20.)).justify_end())
                    .child(time.group_hover("thread-row", move |s| {
                        if has_action { s.invisible() } else { s }
                    }))
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
    pub(super) fn shelf_header(
        &self,
        row: &Row,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
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
                tabular(div())
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
            .when(name == "Settled", |header| {
                header
                    .drag_over::<crate::shell::features::RailPane>(|style, _, _, _| {
                        style.bg(theme().selection)
                    })
                    .on_drop(
                        cx.listener(|this, pane: &crate::shell::features::RailPane, _, cx| {
                            this.drop_thread("Settled", pane, cx)
                        }),
                    )
            })
            .on_click(cx.listener(move |this, _, _, cx| {
                this.toggle_shelf(&name);
                cx.notify();
            }))
    }

    /// Folds or unfolds an Inbox shelf. Folding moves the keyboard choice off
    /// the shelf's hidden rows, so the next rebuild does not unfold it again.
    pub(super) fn toggle_shelf(&mut self, name: &str) {
        let key = super::inbox::open_key(name);
        if self.expanded.remove(&key) {
            let hidden = self
                .choice
                .as_ref()
                .filter(|id| self.selected.as_ref() != Some(*id))
                .and_then(|id| self.sessions.iter().find(|s| &s.id == id))
                .is_some_and(|s| self.group_key(s) == name);
            if hidden {
                self.choice = self.selected.clone();
            }
        } else {
            self.expanded.insert(key);
        }
        self.rebuild();
    }

    /// Unfolds the Snoozed and Settled shelves, for tests that follow a
    /// thread onto them.
    #[cfg(test)]
    pub(crate) fn open_shelves(&mut self) {
        for shelf in inbox::SHELVES {
            self.expanded.insert(inbox::open_key(shelf));
        }
        self.rebuild();
    }
    /// A thread dropped on a section heading moves there, as in T3 Code's
    /// sidebar: Settled settles it; Active brings it back from Settled,
    /// Snoozed or Pinned; Pinned pins it.
    pub(super) fn drop_thread(
        &mut self,
        section: &str,
        pane: &crate::shell::features::RailPane,
        cx: &mut Context<Self>,
    ) {
        let crate::shell::features::RailPane::Thread { id, .. } = pane else {
            return;
        };
        let Some(session) = self.sessions.iter().find(|s| &s.id == id) else {
            return;
        };
        let (settled, snoozed, pinned) = (session.settled(), self.snoozed(id), self.pinned(id));
        let id = id.clone();
        match section {
            "Settled" if !settled => {
                if snoozed {
                    self.snooze(id.clone(), None, cx);
                }
                self.settle_id(id, cx);
            }
            "Active" => {
                if snoozed {
                    self.snooze(id.clone(), None, cx);
                }
                if pinned {
                    self.toggle_pin(id.clone(), cx);
                }
                if settled {
                    self.settle_id(id, cx);
                }
            }
            "Pinned" if !pinned => self.toggle_pin(id, cx),
            _ => {}
        }
    }

    /// A row that lands in a new place fades in (T3 Code's 150ms ease-out
    /// enter); the first build shows everything at once.
    pub(super) fn note_arrivals(&mut self, rows: &[Row]) {
        if self.view() != folders::View::Inbox {
            self.placed = None;
            return;
        }
        let now = std::time::Instant::now();
        let current: HashSet<String> = rows
            .iter()
            .filter_map(|r| r.id.as_ref().map(|id| format!("{id}/{}", r.marker)))
            .collect();
        if let Some(previous) = &self.placed {
            for key in current.difference(previous) {
                self.arrivals.insert(key.clone(), now);
            }
        }
        self.arrivals.retain(|_, at| now.duration_since(*at) < FADE);
        self.placed = Some(current);
    }
    pub(super) fn arrival_opacity(&self, i: usize) -> f32 {
        let Some(row) = self.rows.get(i) else {
            return 1.;
        };
        let Some(id) = row.id.as_ref() else { return 1. };
        let Some(at) = self.arrivals.get(&format!("{id}/{}", row.marker)) else {
            return 1.;
        };
        let t = (at.elapsed().as_secs_f32() / FADE.as_secs_f32()).min(1.);
        // Ease out: quick to appear, gentle to settle.
        1. - (1. - t).powi(3)
    }
    /// Repaints at display rate while a row is fading in.
    pub(super) fn tick_fade(&mut self, cx: &mut Context<Self>) {
        if self.fade_tick || self.arrivals.values().all(|at| at.elapsed() >= FADE) {
            return;
        }
        self.fade_tick = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(16))
                .await;
            let _ = this.update(cx, |this, cx| {
                this.fade_tick = false;
                cx.notify();
            });
        })
        .detach();
    }

    /// Keeps Working timers counting: one repaint a second while any is shown.
    pub(super) fn tick_working(&mut self, cx: &mut Context<Self>) {
        // The Working drawer's dot and run times keep the same beat.
        let drawer = self.drawer_at().is_some();
        if self.second_tick || self.view() != folders::View::Inbox && !drawer {
            return;
        }
        let shown = drawer || self.rows.iter().any(|r| r.running && r.id.is_some());
        if !shown && self.lingering.is_empty() {
            return;
        }
        self.second_tick = true;
        // Half a second keeps the clocks on time and ends a grace promptly.
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(500))
                .await;
            let _ = this.update(cx, |this, cx| {
                this.second_tick = false;
                if !this.lingering.is_empty() {
                    this.rebuild();
                }
                cx.notify();
            });
        })
        .detach();
    }
    /// A thread that stops working keeps reading as working for a moment: an
    /// orchestrator's run can end just before its continuation starts (T3
    /// Code's WORKING_EXIT_GRACE_MS in packages/client-runtime/src/state/
    /// threadInbox.ts, commit 6b02cbff). A question or approval skips it.
    pub(super) fn track_working(&mut self) {
        let now = std::time::Instant::now();
        let mut seen = std::mem::take(&mut self.working_seen);
        self.lingering.clear();
        for s in &self.sessions {
            if sidebar::working(s) {
                // Still running: no deadline yet.
                seen.insert(s.id.clone(), None);
                continue;
            }
            let Some(entry) = seen.get_mut(&s.id) else {
                continue;
            };
            if inbox::needs_input(s) {
                seen.remove(&s.id);
                continue;
            }
            // The grace starts when the stop is first seen.
            let deadline = *entry.get_or_insert(now + WORKING_EXIT_GRACE);
            if now < deadline {
                self.lingering.insert(s.id.clone());
            } else {
                seen.remove(&s.id);
            }
        }
        let live: HashSet<&str> = self.sessions.iter().map(|s| s.id.as_str()).collect();
        seen.retain(|id, _| live.contains(id.as_str()));
        self.working_seen = seen;
    }
}

/// Tabular figures, so a ticking clock or a changing count holds its width
/// (Emil Kowalski's UI cheatsheet: numbers jitter when they change).
pub(crate) fn tabular<E: gpui::Styled>(mut element: E) -> E {
    element
        .text_style()
        .get_or_insert_with(Default::default)
        .font_features = Some(gpui::FontFeatures(std::sync::Arc::new(vec![(
        "tnum".into(),
        1,
    )])));
    element
}
/// A run's clock keeps its seconds: "42s", "1m 05s", "1h 02m 05s".
pub(super) fn run_timer(secs: u64) -> String {
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m {:02}s", secs / 60, secs % 60),
        _ => format!(
            "{}h {:02}m {:02}s",
            secs / 3600,
            secs % 3600 / 60,
            secs % 60
        ),
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
