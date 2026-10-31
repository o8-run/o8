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
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, Rgba, div, px};
use std::sync::OnceLock;

pub(crate) const ROW_HEIGHT: f32 = 60.;
pub(super) const DEV_WORKING_ENV: &str = "O8_DEV_SIDEBAR_WORKING";
/// Lucide icons.
const DONE: &str = "M21.8 10A10 10 0 1 1 17 3.3 M9 11l3 3L22 4";
const INPUT: &str = "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3 M12 17h.01";
const WOKE: &str = "M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M12 9v4l2 2 M5 3 2 6 M22 6l-3-3";
const ERROR: &str = "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 8v4 M12 16h.01";
const REPO: &str = "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z";
const BRANCH: &str = "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9";
const TERMINAL: &str = "M4 17l6-6-6-6 M12 19h8";
const AGENT: &str = "M12 8V4H8 M4 8h16v12H4z M2 14h2 M20 14h2 M15 13v2 M9 13v2";

/// The right-aligned status on a detailed row's first line.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Status {
    pub key: &'static str,
    pub label: String,
}
pub(crate) fn status(s: &Session, woken: bool, running: bool, age: &str) -> Status {
    let st = s.status.trim().to_lowercase();
    let (key, label) = if inbox::needs_input(s) {
        ("input", "Input".to_owned())
    } else if woken {
        ("woke", "Woke".into())
    } else if sidebar::rank(s) == 5 {
        ("error", "Error".into())
    } else if matches!(st.as_str(), "queued" | "pending" | "launching" | "recovering") {
        ("waiting", "Waiting".into())
    } else if running {
        // Time since the thread's last activity: o8 records no run start.
        ("running", age.to_owned())
    } else if s.outcome.is_some()
        || matches!(st.as_str(), "idle" | "ready" | "completed" | "done" | "merged" | "released")
    {
        ("done", "Done".into())
    } else {
        ("age", age.to_owned())
    };
    Status { key, label }
}
fn status_look(key: &str) -> (Option<&'static str>, Rgba) {
    match key {
        "done" => (Some(DONE), theme().success),
        "input" => (Some(INPUT), theme().accent),
        "woke" => (Some(WOKE), crate::theme::brand_orange()),
        "error" => (Some(ERROR), theme().danger),
        "waiting" => (None, theme().text_muted),
        _ => (None, theme().text_faint),
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
/// Running threads (not those waiting on you) leave their groups for a
/// Working section, placed before Snoozed, Settled and Archived. o8 has no
/// pinned threads yet, so none stay behind.
pub(crate) fn fold_working(rows: Vec<Row>, closed: bool) -> Vec<Row> {
    let end = rows
        .iter()
        .position(|r| {
            r.kind == "section" && matches!(r.title.as_str(), "Snoozed" | "Settled" | "Archived")
        })
        .unwrap_or(rows.len());
    let mut rows = rows;
    let tail = rows.split_off(end);
    let (working, mut rest): (Vec<_>, Vec<_>) = rows
        .into_iter()
        .partition(|r| r.kind == "thread" && r.running && r.marker != "input");
    if !working.is_empty() {
        rest.push(recents::header(
            "section",
            &format!("Working · {}", working.len()),
            "working",
        ));
        if !closed {
            rest.extend(working);
        }
    }
    rest.extend(tail);
    rest
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
    fn branch_of(&self, s: &Session) -> Option<String> {
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
        let woken = self.snoozes.get(&id).is_some_and(|until| *until <= recents::now());
        let st = session.map(|s| status(s, woken, row.running, &row.age));
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
                    .child(label(&row.workspace)),
            );
        if let Some(st) = st {
            let (icon, color) = status_look(st.key);
            let key = st.key;
            let sid = id.clone();
            first = first.child(
                div()
                    .debug_selector(move || format!("thread-status-{key}-{sid}"))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap(px(3.))
                    .text_color(color)
                    .children(icon.map(|i| crate::icon::stroke(i, color, 11., 2.2)))
                    .child(st.label),
            );
        }
        let title = div()
            .whitespace_nowrap()
            .overflow_hidden()
            .text_ellipsis()
            .text_size(px(13.5))
            .font_weight(gpui::FontWeight::SEMIBOLD)
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
            let runtime = s.runtime.trim().to_owned();
            if !runtime.is_empty() {
                let color = match runtime.as_str() {
                    "claude-code" => crate::theme::brand_orange(),
                    "codex" => theme().accent,
                    _ => theme().text_muted,
                };
                let sid = id.clone();
                let tip: gpui::SharedString = runtime.into();
                third = third.child(
                    div()
                        .id(gpui::ElementId::Name(format!("thread-runtime-{sid}").into()))
                        .debug_selector(move || format!("thread-runtime-{sid}"))
                        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(tip.clone())).into())
                        .child(crate::icon::stroke(AGENT, color, 11., 2.)),
                );
            }
        }
        third = third
            .children(self.row_settle_control(row, keyboard, cx))
            .child(self.row_archive_control(row, keyboard, cx));
        div()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .gap(px(2.))
            .child(first)
            .child(title)
            .child(third)
            .into_any_element()
    }
}

