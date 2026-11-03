//! Detailed thread rows and the Working section, opt-in from the view menu.
//!
//! Modelled on T3 Code's sidebar rows (https://github.com/pingdotgg/t3code,
//! apps/web/src/components/sidebar/SidebarThreadRow.tsx): repository and
//! status, then the title, then the branch with the PR, terminal and agent
//! marks. Reimplemented, no code shared. Every field comes from data o8
//! already has; a missing one is left out rather than guessed.
//!
//! Dev only: O8_DEV_SIDEBAR_WORKING may list thread ids (comma separated)
//! drawn as running, to show the Working section without starting an agent.
use super::status_mark::{self, State};
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, px};
use std::sync::OnceLock;

pub(crate) const ROW_HEIGHT: f32 = 66.;
pub(super) const DEV_WORKING_ENV: &str = "O8_DEV_SIDEBAR_WORKING";
/// Lucide icons.
const REPO: &str = "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z";
const BRANCH: &str = "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9";
const TERMINAL: &str = "M4 17l6-6-6-6 M12 19h8";

/// The right-aligned status on a detailed row's first line: classic's state
/// and label (status_mark), the run time while it runs, else just its age.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Status {
    pub key: &'static str,
    pub label: String,
}
pub(crate) fn status(s: &Session, running: bool, age: &str) -> Status {
    status_of(status_mark::state(s, running), age)
}
fn status_of(state: Option<State>, age: &str) -> Status {
    match state {
        // Running counts its time; a snoozed row already sits under Snoozed.
        Some(state @ (State::Running | State::Snoozed)) => {
            Status { key: state.key(), label: age.to_owned() }
        }
        Some(state) => Status { key: state.key(), label: state.label().into() },
        None => Status { key: "age", label: age.to_owned() },
    }
}
/// Elapsed run time: `42s`, `12m`, `1h 5m`, `2d`.
pub(crate) fn elapsed(start: u64, now: u64) -> String {
    let secs = now.saturating_sub(start);
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m", secs / 60),
        3600..86400 => format!("{}h {}m", secs / 3600, secs % 3600 / 60),
        _ => format!("{}d", secs / 86400),
    }
}
fn dev_working() -> &'static HashSet<String> {
    static IDS: OnceLock<HashSet<String>> = OnceLock::new();
    IDS.get_or_init(|| {
        std::env::var(DEV_WORKING_ENV)
            .map(|v| v.split(',').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default()
    })
}
pub(super) fn mark_dev_working(rows: &mut [Row]) {
    let ids = dev_working();
    if ids.is_empty() {
        return;
    }
    for row in rows.iter_mut() {
        if row.id.as_ref().is_some_and(|id| ids.contains(id)) {
            row.running = true;
        }
    }
}
/// Running top-level threads leave their groups for a Working section before
/// Merged, Snoozed, Settled and Archived. Nested children travel with their row;
/// the caller keeps the pinned shelf outside this fold.
pub(crate) fn fold_working(rows: Vec<Row>, closed: bool) -> Vec<Row> {
    let end = rows
        .iter()
        .position(|r| {
            r.kind == "section"
                && matches!(r.title.as_str(), "Merged" | "Snoozed" | "Settled" | "Archived")
        })
        .unwrap_or(rows.len());
    let mut rows = rows;
    let tail = rows.split_off(end);
    let (mut working, mut rest) = (Vec::new(), Vec::new());
    let (mut moving, mut count) = (false, 0);
    for row in rows {
        if row.depth == 0 {
            moving = row.kind == "thread" && row.running && row.marker != "input";
            if moving {
                count += 1;
            }
        }
        if moving {
            working.push(row);
        } else {
            rest.push(row);
        }
    }
    let mut out = Vec::new();
    if !working.is_empty() {
        out.push(recents::header(
            "section",
            &format!("Working · {count}"),
            "working",
        ));
        if !closed {
            out.extend(working);
        }
    }
    out.extend(rest);
    out.extend(tail);
    out
}

impl ThreadList {
    pub fn restore_row_mode(&mut self, detailed: bool, working: bool) {
        self.detailed = detailed;
        self.working_section = working;
        self.rebuild();
    }
    fn save_row_mode(&mut self, cx: &mut Context<Self>) {
        self.view_menu = false;
        self.rebuild();
        cx.emit(Event::RowMode(self.detailed, self.working_section));
        cx.notify();
    }
    pub(super) fn toggle_detailed(&mut self, cx: &mut Context<Self>) {
        self.detailed = !self.detailed;
        self.save_row_mode(cx);
    }
    pub(super) fn toggle_working_section(&mut self, cx: &mut Context<Self>) {
        self.working_section = !self.working_section;
        self.save_row_mode(cx);
    }
    pub(super) fn toggle_working_closed(&mut self, cx: &mut Context<Self>) {
        self.working_closed = !self.working_closed;
        self.rebuild();
        cx.notify();
    }
    pub(super) fn branch_of(&self, s: &Session) -> Option<String> {
        self.branch_names
            .get(&s.id)
            .filter(|b| !b.is_empty())
            .cloned()
            .or_else(|| {
                s.packet_header
                    .as_ref()
                    .and_then(|h| h["branch"].as_str())
                    .filter(|b| !b.is_empty())
                    .map(str::to_owned)
            })
            .or_else(|| s.branch.clone().filter(|b| !b.is_empty()))
    }
    /// A detailed row's three lines; the row container, its clicks and its
    /// menu stay with the list.
    pub(super) fn detailed_content(
        &self,
        row: &Row,
        keyboard: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = row.id.clone().unwrap_or_default();
        let session = self.sessions.iter().find(|s| s.id == id);
        // A real run timer when the host recorded the run start; else last activity.
        let timer = session
            .and_then(|s| s.run_started_at.as_deref())
            .and_then(recents::timestamp)
            .map(|start| elapsed(start, recents::now()))
            .unwrap_or_else(|| row.age.clone());
        let state = self.row_state(row);
        let st = session.map(|_| status_of(state, &timer));
        let faint = theme().text_faint;
        let mut first = div()
            .flex()
            .items_center()
            .gap(px(5.))
            .text_size(px(11.))
            .text_color(faint)
            .child(crate::icon::stroke(REPO, faint, 11., 2.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .text_ellipsis()
                    .child(row.on_machine(label(
                        session
                            .and_then(|s| s.repo_slug.as_deref())
                            .filter(|r| !r.is_empty())
                            .unwrap_or(&row.workspace),
                    ))),
            );
        first = first.children(self.pin_mark(&id));
        first = first.children(self.auto_off_mark(&id));
        let auto_reason = session
            .filter(|s| s.settled())
            .and_then(|s| s.auto_settled_reason.as_deref());
        // The note carries the age; a bare age would repeat it.
        if let Some(st) = st.filter(|_| state.is_some() || auto_reason.is_none()) {
            // An idle thread shows only its age; a state brings its mark.
            let color = state.map_or(faint, State::color);
            let key = st.key;
            let sid = id.clone();
            first = first.child(
                div()
                    .debug_selector(move || format!("thread-status-{key}-{sid}"))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .text_color(color)
                    .children(state.map(status_mark::mark))
                    .child(st.label),
            );
        }
        // An automatic settle says why ("merged · 2h") beside any badge.
        if let Some(reason) = auto_reason {
            let sid = id.clone();
            let age = row.age.clone();
            let note = if age.starts_with(super::inbox::auto_note(reason)) {
                age
            } else {
                super::inbox::note_with_age(reason, &age)
            };
            first = first.child(
                div()
                    .debug_selector(move || format!("thread-auto-note-{sid}"))
                    .flex_shrink_0()
                    .whitespace_nowrap()
                    .text_color(faint)
                    .child(note),
            );
        }
        let title = div()
            .whitespace_nowrap()
            .overflow_hidden()
            .text_ellipsis()
            // The sidebar's own face and weight, as the compact rows.
            .text_size(px(13.5))
            .text_color(theme().text)
            .child(crate::text::sanitize(&row.title));
        let mut third = div()
            .flex()
            .items_center()
            .gap(px(5.))
            .text_size(px(11.))
            .text_color(faint)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .children(session.and_then(|s| self.branch_of(s)).map(|b| {
                        let sid = id.clone();
                        div()
                            .debug_selector(move || format!("thread-branch-{sid}"))
                            .min_w_0()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .child(crate::icon::stroke(BRANCH, faint, 10., 2.))
                            .child(
                                div()
                                    .min_w_0()
                                    .whitespace_nowrap()
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .child(b),
                            )
                    })),
            )
            .children(self.workspace_parked_detail(&id))
            .children(self.pr_badge(&id, cx));
        if let Some(s) = session {
            if s.tmux_session.as_deref().is_some_and(|t| !t.is_empty()) {
                let sid = id.clone();
                third = third.child(
                    div()
                        .id(gpui::ElementId::Name(format!("thread-terminal-{sid}").into()))
                        .debug_selector(move || format!("thread-terminal-{sid}"))
                        .tooltip(|_, cx| cx.new(|_| crate::icon::Tip("Has a terminal session".into())).into())
                        .child(crate::icon::stroke(TERMINAL, faint, 11., 2.)),
                );
            }
        }
        third = third.children(self.row_settle_control(row, keyboard, cx));
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .gap(px(2.))
            .child(first)
            .child(title)
            .child(third)
            .into_any_element()
    }
}

