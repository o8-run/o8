use super::*;
use crate::theme::current as theme;
use gpui::{Render, Styled, canvas, div, px, uniform_list};
use std::time::Duration;

// Use the shared semantic tokens for the workspace sidebar.

/// The open stagger (Q 2026-10-31, after a sidebar demo): each row starts
/// this long after the one above, fades over ROW_FADE and settles from a few
/// pixels left. Rows past STAGGER_ROWS start together.
const STAGGER: Duration = Duration::from_millis(28);
const ROW_FADE: Duration = Duration::from_millis(170);
const STAGGER_ROWS: usize = 10;
const SETTLE_PX: f32 = 6.;

impl ThreadList {
    /// Fades the rows in top-down, as the column opens.
    pub(crate) fn stagger_in(&mut self, cx: &mut Context<Self>) {
        self.reveal = Some(std::time::Instant::now());
        cx.notify();
    }

    /// How far row `slot` (header 0, search 1, then the list) has arrived.
    fn arrived(&self, slot: usize) -> f32 {
        let Some(start) = self.reveal else {
            return 1.;
        };
        let delay = STAGGER * slot.min(STAGGER_ROWS) as u32;
        let t = start.elapsed().saturating_sub(delay).as_secs_f32() / ROW_FADE.as_secs_f32();
        crate::motion::ease_out(t.min(1.))
    }
}

/// A row on its way in: faded and a few pixels short of its place.
fn arriving<E: Styled + gpui::ParentElement>(row: E, arrived: f32) -> E {
    row.opacity(arrived).relative().left(px(-SETTLE_PX * (1. - arrived)))
}

impl Render for ThreadList {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(start) = self.reveal {
            if start.elapsed() < STAGGER * STAGGER_ROWS as u32 + ROW_FADE {
                cx.on_next_frame(window, |_, _, cx| cx.notify());
            } else {
                self.reveal = None;
            }
        }
        if !self.editing && self.editor.read(cx).focus.is_focused(window) {
            self.focus.focus(window);
        }
        let _keep_subscriptions = &self.subscriptions;
        let status = if self.saving {
            "Saving…".to_string()
        } else if self.loading && self.rows.is_empty() {
            // Background refreshes keep the current list without a status flash.
            "Refreshing…".to_string()
        } else if self.search_running || self.search_pending.is_some() {
            "Searching messages…".to_string()
        } else if self.notice.is_empty() {
            if !self.search_error.is_empty() {
                self.search_error.clone()
            } else if !self.query.trim().is_empty() && self.rows.is_empty() {
                "No matching threads".into()
            } else {
                String::new()
            }
        } else {
            self.notice.clone()
        };
        div()
            .id("thread-sidebar")
            .debug_selector(|| "thread-sidebar".into())
            .w_full()
            .h_full()
            .flex_shrink_0()
            .min_h_0()
            .flex()
            .flex_col()
            .bg(theme().surface)
            .text_color(theme().text)
            .font_weight(gpui::FontWeight::LIGHT)
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(Self::key))
            .child(arriving(
                div().child(self.project_header(window, cx)),
                self.arrived(0),
            ))
            .child(arriving(
                div()
                    .mx(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .child(
                        // A desktop-style nav row: search glyph and muted label, filled on hover.
                        div()
                            .id("thread-search")
                            .debug_selector(|| "thread-search".into())
                            .cursor_pointer()
                            .flex_1()
                            .min_w_0()
                            .h(px(28.))
                            .px(px(6.))
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .rounded(px(8.))
                            .hover(|style| style.bg(theme().hover))
                            .text_size(px(12.5))
                            .text_color(theme().text_secondary)
                            .child(crate::icon::stroke(
                                "M11 4a7 7 0 1 0 0 14 7 7 0 1 0 0-14Z M20 20l-3.5-3.5",
                                theme().text_muted,
                                15.,
                                1.7,
                            ))
                            .child(if self.rename.is_some() {
                                "Rename thread"
                            } else {
                                "Search"
                            })
                            .on_click(cx.listener(|this, _, window, cx| this.search(window, cx))),
                    )
                    .when(!self.scope_repos().is_empty(), |row| {
                        row.child(
                            div()
                                .relative()
                                .child(self.scope_trigger(cx))
                                .children(self.scope_picker(cx)),
                        )
                        .child(self.new_thread_button(cx))
                    }),
                self.arrived(1),
            ))
            .when(self.editing || !self.query.is_empty(), |view| {
                view.child(self.editor.clone())
            })
            .when(!status.is_empty(), |view| {
                view.child(
                    div()
                        .text_size(px(10.))
                        .text_color(theme().text_muted)
                        .px(px(12.))
                        .child(status),
                )
            })
            .child(
                uniform_list(
                    "native-threads",
                    self.rows.len(),
                    cx.processor(|this, range: std::ops::Range<usize>, window, cx| {
                        this.materialized.set(range.len());
                        let keyboard = this.focus.is_focused(window);
                        range
                            .map(|i| {
                                let row = this.rows[i].clone();
                                if let Some(folder) = &row.folder {
                                    return this.folder_row(&row, folder, cx);
                                }
                                let thread = row.id.is_some();
                                let by_repo = this.view() == folders::View::Repo;
                                let title =
                                    gpui::StyledText::new(crate::text::sanitize(&row.title));
                                #[cfg(test)]
                                if let Some(id) = &row.id {
                                    this.title_layouts
                                        .insert(id.clone(), title.layout().clone());
                                }
                                let selected = row.id.as_ref() == this.selected.as_ref() && thread;
                                let painted = this.painted.clone();
                                let identity = row
                                    .id
                                    .as_ref()
                                    .map(|id| format!("thread:{id}"))
                                    .unwrap_or_else(|| {
                                        format!("{}:{}:{}", row.kind, row.workspace, row.title)
                                    });
                                let arrived = this.arrived(i + 2);
                                div()
                                    .id(gpui::ElementId::Name(identity.into()))
                                    .debug_selector(move || format!("thread-row-{i}"))
                                    .opacity(arrived)
                                    .relative()
                                    .left(px(-SETTLE_PX * (1. - arrived)))
                                    .group("thread-row")
                                    .w_full()
                                    .min_w_0()
                                    .h(px(28.))
                                    .flex()
                                    .items_center()
                                    .px(px(12.))
                                    .rounded(px(8.))
                                    .overflow_hidden()
                                    .bg(if selected || thread && row.id == this.choice {
                                        theme().selection
                                    } else {
                                        theme().surface
                                    })
                                    .when(thread, |view| {
                                        view.cursor_pointer().hover(|style| style.bg(theme().hover))
                                    })
                                    // Dragged onto the workspace, a thread opens as a split pane.
                                    .when_some(row.id.clone(), |view, id| {
                                        let dragged = crate::shell::features::RailPane::Thread {
                                            id,
                                            title: crate::text::sanitize(&row.title).into(),
                                        };
                                        view.on_drag(dragged, |drag, _, _, cx| {
                                            cx.new(|_| drag.clone())
                                        })
                                    })
                                    .child(
                                        div()
                                            .flex()
                                            .w_full()
                                            .min_w_0()
                                            .items_center()
                                            .justify_between()
                                            .gap(px(6.))
                                            .child(
                                                div()
                                                    .flex_1()
                                                    .min_w_0()
                                                    // Recompute truncation when flex assigns the final width.
                                                    .whitespace_normal()
                                                    .line_clamp(1)
                                                    .text_ellipsis()
                                                    .text_size(px(if thread { 13.5 } else { 12. }))
                                                    .text_color(if thread {
                                                        theme().text
                                                    } else {
                                                        theme().text_muted
                                                    })
                                                    .child(title),
                                            )
                                            .when(!thread && i == 0, |view| {
                                                view.child(this.view_picker(cx))
                                            })
                                            .when(thread, |view| {
                                                // A folder already names its threads' repository.
                                                view.when(!by_repo, |view| {
                                                    view.child(
                                                        div()
                                                            .max_w(px(65.))
                                                            .min_w_0()
                                                            .text_ellipsis()
                                                            .font_weight(gpui::FontWeight(260.))
                                                            .text_size(px(11.5))
                                                            .text_color(theme().text_faint)
                                                            .child(label(&row.workspace)),
                                                    )
                                                })
                                                .child(
                                                    div()
                                                        .flex_shrink_0()
                                                        .flex()
                                                        .items_center()
                                                        .gap(px(6.))
                                                        .font_weight(gpui::FontWeight(260.))
                                                        .text_size(px(9.5))
                                                        .text_color(theme().text_faint)
                                                        .child(row.age.clone())
                                                        .when(row.branch, |v| v.child("⑂"))
                                                        .when(row.attention || row.running, |v| {
                                                            v.child(
                                                                div()
                                                                    .size(px(6.))
                                                                    .rounded_full()
                                                                    .bg(if row.attention {
                                                                        theme().warning
                                                                    } else {
                                                                        theme().success
                                                                    }),
                                                            )
                                                        }),
                                                )
                                                .children(
                                                    this.row_settle_control(&row, keyboard, cx),
                                                )
                                                .child(this.row_archive_control(&row, keyboard, cx))
                                            }),
                                    )
                                    .when(
                                        row.kind == "section" && row.title == "Archived",
                                        |view| {
                                            view.debug_selector(|| "sidebar-archived-header".into())
                                                .track_focus(&this.archived_focus)
                                                .focus(|style| {
                                                    style
                                                        .bg(theme().selection)
                                                        .text_color(theme().text)
                                                })
                                                .cursor_pointer()
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.archived_focus.focus(window);
                                                    this.toggle_archived(cx);
                                                }))
                                        },
                                    )
                                    .when(row.kind == "more", |view| {
                                        let group = row.status.clone();
                                        view.cursor_pointer().on_click(cx.listener(
                                            move |this, _, _, cx| {
                                                this.expanded.insert(group.clone());
                                                this.rebuild();
                                                cx.notify();
                                            },
                                        ))
                                    })
                                    .when(thread, |view| {
                                        let id = row.id.clone().unwrap_or_default();
                                        view.on_mouse_down(
                                            gpui::MouseButton::Right,
                                            cx.listener(
                                                move |this, event: &gpui::MouseDownEvent, _, cx| {
                                                    this.open_row_menu(&id, event.position, cx);
                                                    cx.stop_propagation();
                                                },
                                            ),
                                        )
                                    })
                                    .when(thread, |view| {
                                        view.on_click(cx.listener(move |this, _, window, cx| {
                                            let id = row.id.clone().unwrap();
                                            if this.rows.iter().any(|r| r.id.as_ref() == Some(&id))
                                            {
                                                this.focus.focus(window);
                                                this.choose(id.clone(), cx);
                                                let generation = this.edit_generation;
                                                // Opening another workspace can restore its content
                                                // focus while handling Selected. Keep row navigation
                                                // focused after that event, unless a newer edit won.
                                                cx.defer_in(window, move |this, window, _| {
                                                    if this.edit_generation == generation
                                                        && this.choice.as_ref() == Some(&id)
                                                        && !this.editing
                                                    {
                                                        this.focus.focus(window);
                                                    }
                                                });
                                            }
                                        }))
                                    })
                                    .child(
                                        canvas(
                                            |_, _, _| (),
                                            move |_, _, _, _| {
                                                if thread {
                                                    painted.set(i);
                                                }
                                            },
                                        )
                                        .size(px(1.)),
                                    )
                            })
                            .collect()
                    }),
                )
                .debug_selector(|| "thread-list".into())
                .track_scroll(self.scroll.clone())
                .flex_1()
                .min_h_0(),
            )
            .when(
                self.query.is_empty()
                    && (!self.archived_open
                        || !self
                            .rows
                            .iter()
                            .any(|r| r.kind == "section" && r.title == "Archived")),
                |view| view.child(self.archived_control(cx)),
            )
            .children(self.row_menu(cx))
    }
}
