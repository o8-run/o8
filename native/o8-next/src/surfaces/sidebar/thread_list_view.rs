use super::*;
use crate::theme::current as theme;
use gpui::{Render, canvas, div, px, uniform_list};

// Use the shared semantic tokens for the workspace sidebar.

impl Render for ThreadList {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.editing && self.editor.read(cx).focus.is_focused(window) {
            self.focus.focus(window);
        }
        let _keep_subscriptions = &self.subscriptions;
        let saved_chat = self
            .choice_row()
            .and_then(|r| r.id.as_ref())
            .is_some_and(|id| !id.contains(':'));
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
            .group("thread-sidebar")
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
            .child(self.project_header(window, cx))
            .child(
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
                        row.child(self.scope_trigger(cx))
                    }),
            )
            .children(self.scope_picker(cx))
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
                                let thread = row.id.is_some();
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
                                div()
                                    .id(gpui::ElementId::Name(identity.into()))
                                    .debug_selector(move || format!("thread-row-{i}"))
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
                                            .when(thread, |view| {
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
            .child(
                div()
                    .flex()
                    .gap(px(12.))
                    .px(px(12.))
                    .py(px(6.))
                    .text_size(px(10.))
                    .when(!self.focus.is_focused(window), |view| {
                        view.invisible()
                            .group_hover("thread-sidebar", |style| style.visible())
                    })
                    .when(saved_chat, |view| {
                        view.child(
                            div()
                                .id("thread-rename")
                                .debug_selector(|| "thread-rename".into())
                                .cursor_pointer()
                                .child("Rename")
                                .on_click(
                                    cx.listener(|this, _, window, cx| {
                                        this.start_rename(window, cx)
                                    }),
                                ),
                        )
                    })
                    .child(
                        div()
                            .id("thread-archive")
                            .debug_selector(|| "thread-archive".into())
                            .cursor_pointer()
                            .child(if this_archived(self) {
                                "Restore"
                            } else {
                                "Archive"
                            })
                            .on_click(cx.listener(|this, _, _, cx| this.archive(cx))),
                    ),
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

fn this_archived(this: &ThreadList) -> bool {
    this.choice_row().is_some_and(|r| r.status == "archived")
}
