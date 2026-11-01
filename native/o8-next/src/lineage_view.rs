//! The thread's lineage above the composer: "Started by <thread>" on a child,
//! and "Waiting on N subagents · Stop" with the helpers it started.
use super::*;
use crate::{lineage, model::Row, theme::current as theme};
use gpui::{AnyElement, MouseButton, SharedString};

const BRANCH: &str = "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9";
const STARTED_BY: &str = "M9 6v6a3 3 0 0 0 3 3h6M15 12l3 3-3 3";

thread_local! {
    static TICKING: Cell<bool> = const { Cell::new(false) };
}

impl Surface {
    /// The open thread's helpers: its trace's delegate calls, then the
    /// threads the server lists under it.
    pub(super) fn lineage_children(&self) -> Vec<lineage::Child> {
        let Some(thread) = self.selected.as_deref() else {
            return vec![];
        };
        let mut trace = vec![];
        for row in self.rows.iter() {
            if let Row::Activity { steps, trace: t, .. } = &row.borrow().row {
                let mut children = lineage::trace_children(steps);
                if !t.live {
                    children.iter_mut().for_each(|c| c.working = false);
                }
                trace.extend(children);
            }
        }
        lineage::merge(trace, lineage::server_children(&self.sessions, thread))
    }

    pub(super) fn lineage_strip(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let thread = self.selected.clone()?;
        let children = self.lineage_children();
        lineage::set_shown(children.clone());
        let session = self.sessions.iter().find(|s| s.id == thread);
        let parent = session.and_then(|s| lineage::parent(s).map(str::to_owned));
        let branch = session.and_then(|s| lineage::worktree_badge(s.branch.as_deref()));
        if children.is_empty() && parent.is_none() && branch.is_none() {
            return None;
        }
        let now = lineage::now_ms();
        if children.iter().any(|c| c.working) && !TICKING.with(Cell::get) {
            // Elapsed times count up once a second while helpers work.
            TICKING.with(|t| t.set(true));
            cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(1))
                    .await;
                TICKING.with(|t| t.set(false));
                let _ = this.update(cx, |_, cx| cx.notify());
            })
            .detach();
        }
        let started_by = parent.map(|id| {
            let title = self
                .sessions
                .iter()
                .find(|s| s.id == id)
                .map(|s| crate::text::sanitize(&s.title))
                .unwrap_or_else(|| id.clone());
            div()
                .id("lineage-started-by")
                .debug_selector(|| "lineage-started-by".into())
                .h(px(24.))
                .px(px(8.))
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(px(7.))
                .text_size(px(12.))
                .text_color(theme().text_muted)
                .cursor_pointer()
                .hover(|s| s.bg(theme().hover))
                .child(crate::icon::stroke(STARTED_BY, theme().text_muted, 12., 1.8))
                .child("Started by")
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_color(theme().text_secondary)
                        .child(title),
                )
                .on_click(move |_, window, cx| lineage::open(&id, window, cx))
        });
        let badge = branch.map(|branch| {
            div()
                .debug_selector(|| "lineage-worktree".into())
                .h(px(22.))
                .px(px(8.))
                .flex()
                .items_center()
                .gap(px(5.))
                .rounded(px(6.))
                .border_1()
                .border_color(theme().border)
                .text_size(px(11.5))
                .text_color(theme().text_muted)
                .child(crate::icon::stroke(BRANCH, theme().text_muted, 11., 1.8))
                .child(div().max_w(px(220.)).overflow_hidden().whitespace_nowrap().text_ellipsis().child(branch))
        });
        let context = (badge.is_some() || started_by.is_some()).then(|| {
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .children(badge)
                .children(started_by)
        });
        let key = format!("strip:{thread}");
        let open = lineage::is_open(&key);
        let waiting = lineage::waiting(&children);
        let summary = lineage::card_label(&children).map(|(count, _)| {
            let (label, names) = waiting
                .clone()
                .unwrap_or_else(|| (count, String::new()));
            let toggle_key = key.clone();
            div()
                .id("lineage-strip")
                .debug_selector(|| "lineage-strip".into())
                .h(px(28.))
                .px(px(8.))
                .flex()
                .items_center()
                .gap(px(8.))
                .text_size(px(12.5))
                .cursor_pointer()
                .on_click(cx.listener(move |_, _, _, cx| {
                    lineage::toggle(&toggle_key);
                    cx.notify();
                }))
                .child(
                    div()
                        .size(px(7.))
                        .rounded_full()
                        .flex_shrink_0()
                        .bg(if waiting.is_some() {
                            theme().accent
                        } else {
                            theme().text_muted
                        }),
                )
                .child(div().flex_shrink_0().text_color(theme().text).child(label))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_color(theme().text_muted)
                        .child(crate::text::sanitize(&names)),
                )
                .when(waiting.is_some(), |row| {
                    row.child(
                        div()
                            .id("lineage-stop")
                            .debug_selector(|| "lineage-stop".into())
                            .px(px(8.))
                            .h(px(22.))
                            .flex()
                            .items_center()
                            .rounded(px(6.))
                            .border_1()
                            .border_color(theme().border)
                            .hover(|s| s.bg(theme().hover))
                            .child("Stop")
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(cx.listener(|this, _, _, cx| {
                                cx.stop_propagation();
                                this.stop_turn(cx);
                            })),
                    )
                })
        });
        Some(
            div()
                .id(SharedString::from("lineage"))
                .mb(px(6.))
                .flex()
                .flex_col()
                .children(context)
                .children(summary)
                .when(open, |view| {
                    view.children(children.iter().enumerate().map(|(n, child)| {
                        lineage::child_row(child, now, format!("lineage-row-{n}"))
                    }))
                })
                .into_any_element(),
        )
    }
}
