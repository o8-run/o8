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
        div()
            .id("thread-sidebar")
            .group("thread-sidebar")
            .w(px(280.))
            .h_full()
            .flex_shrink_0()
            .min_h_0()
            .flex()
            .flex_col()
            .bg(theme().surface)
            .text_color(theme().text)
            .font_weight(gpui::FontWeight::LIGHT)
            .track_focus(&self.focus)
            .map(|view| crate::keymap::sidebar_input(view, cx.listener(Self::key)))
            .child(self.project_header(window, cx))
            .child(
                div()
                    .id("thread-search")
                    .debug_selector(|| "thread-search".into())
                    .cursor_pointer()
                    .p(px(12.))
                    .text_size(px(11.))
                    .child(if self.rename.is_some() {
                        "Rename thread"
                    } else {
                        "Search"
                    })
                    .on_click(cx.listener(|this, _, window, cx| this.search(window, cx))),
            )
            .when(self.editing || !self.query.is_empty(), |view| {
                view.child(self.editor.clone())
            })
            .child(
                div()
                    .text_size(px(10.))
                    .text_color(theme().text_muted)
                    .px(px(12.))
                    .child(if self.saving {
                        "Saving…".to_string()
                    } else if self.loading {
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
                    }),
            )
            .child(
                uniform_list(
                    "native-threads",
                    self.rows.len(),
                    cx.processor(|this, range: std::ops::Range<usize>, _, cx| {
                        this.materialized.set(range.len());
                        range
                            .map(|i| {
                                let row = this.rows[i].clone();
                                let thread = row.id.is_some();
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
                                    .h(px(28.))
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
                                            .items_center()
                                            .justify_between()
                                            .gap(px(6.))
                                            .child(
                                                div()
                                                    .flex_1()
                                                    .overflow_hidden()
                                                    .whitespace_nowrap()
                                                    .text_size(px(if thread { 13.5 } else { 10. }))
                                                    .text_color(if thread {
                                                        theme().text
                                                    } else {
                                                        theme().text_muted
                                                    })
                                                    .child(crate::text::sanitize(&row.title)),
                                            )
                                            .when(thread, |view| {
                                                view.child(
                                                    div()
                                                        .text_size(px(9.5))
                                                        .text_color(
                                                            if matches!(
                                                                row.status.as_str(),
                                                                "failed"
                                                                    | "error"
                                                                    | "blocked"
                                                                    | "recovering"
                                                                    | "rejected"
                                                            ) {
                                                                theme().danger
                                                            } else if row.running {
                                                                theme().success
                                                            } else if row.unread
                                                                || matches!(
                                                                    row.status.as_str(),
                                                                    "approval"
                                                                        | "awaiting_review"
                                                                        | "review"
                                                                        | "reviewing"
                                                                        | "awaiting_human"
                                                                        | "awaiting_input"
                                                                        | "waiting"
                                                                )
                                                            {
                                                                theme().warning
                                                            } else {
                                                                theme().text_muted
                                                            },
                                                        )
                                                        .child(format!(
                                                            "{}{}{}",
                                                            if row.running { "● " } else { "" },
                                                            if row.unread {
                                                                "Unread · "
                                                            } else {
                                                                ""
                                                            },
                                                            row.status
                                                        )),
                                                )
                                            }),
                                    )
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
                                        canvas(|_, _, _| (), move |_, _, _, _| painted.set(i))
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
                                .child("Rename (F2)")
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
                            .child("Archive / Restore (Delete)")
                            .on_click(cx.listener(|this, _, _, cx| this.archive(cx))),
                    ),
            )
    }
}
