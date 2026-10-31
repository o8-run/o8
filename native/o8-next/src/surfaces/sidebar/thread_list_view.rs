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
        if !cx.has_active_drag() {
            self.pin_drop = None;
            self.pin_bounds.clear();
        }
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
                        row.child(
                            div()
                                .relative()
                                .child(self.scope_trigger(cx))
                                .children(self.scope_picker(cx)),
                        )
                        .child(self.new_thread_button(cx))
                    }),
            )
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
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .on_drag_move(cx.listener(
                        |this, event: &gpui::DragMoveEvent<pins::PinDrag>, _, cx| this.pin_tail_move(event, cx),
                    ))
                    .on_drop(cx.listener(|this, drag: &pins::PinDrag, _, cx| this.drop_pin(drag, cx)))
                    .child(
                if self.detailed {
                    // Detailed rows vary: 66px threads under 28px headings.
                    let view = cx.entity();
                    div().debug_selector(|| "thread-list".into()).flex().flex_col().flex_1().min_h_0().child(
                    gpui::list(self.detailed_list.clone(), move |i, window, cx| {
                        view.update(cx, |this, cx| {
                            let keyboard = this.focus.is_focused(window);
                            this.materialized.set(this.materialized.get().max(i + 1));
                            this.render_row(i, keyboard, cx).into_any_element()
                        })
                    })
                    .flex_1()
                    .size_full(),
                    )
                    .into_any_element()
                } else {
                    uniform_list(
                        "native-threads",
                        self.rows.len(),
                        cx.processor(|this, range: std::ops::Range<usize>, window, cx| {
                            this.materialized.set(range.len());
                            let keyboard = this.focus.is_focused(window);
                            range.map(|i| this.render_row(i, keyboard, cx)).collect()
                        }),
                    )
                    .debug_selector(|| "thread-list".into())
                    .track_scroll(self.scroll.clone())
                    .flex_1()
                    .min_h_0()
                    .into_any_element()
                },
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
            .children(self.pr_hover_list(cx))
    }
}

impl ThreadList {
    fn render_row(
        &mut self,
        i: usize,
        keyboard: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let this = self;
                    let row = this.rows[i].clone();
                    if let Some(folder) = &row.folder {
                        return this.folder_row(&row, folder, cx);
                    }
                    let thread = row.id.is_some();
                    let detailed = this.detailed;
                    let detailed_thread = detailed && thread;
                    let detailed_content = detailed_thread
                        .then(|| this.detailed_content(&row, keyboard, cx));
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
                    div()
                        .id(gpui::ElementId::Name(identity.into()))
                        .debug_selector(move || format!("thread-row-{i}"))
                        .group("thread-row")
                        .w_full()
                        .min_w_0()
                        .h(px(if detailed_thread {
                            detailed::ROW_HEIGHT
                        } else {
                            28.
                        }))
                        .flex()
                        .items_center()
                        // Detailed headings keep the compact height, with a
                        // little air above so they read as section breaks.
                        .when(detailed && !thread && i > 0, |v| v.items_end().pb(px(2.)))
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
                            view.on_drag(dragged, |drag, _, _, cx| cx.new(|_| drag.clone()))
                        })
                        .when_some(detailed_content, |v, content| v.child(content))
                        .when(!detailed_thread, |v| v.child(
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
                                .when(!row.marker.is_empty(), |view| {
                                    let (text, color) = if row.marker == "input" {
                                        ("Needs input", theme().warning)
                                    } else {
                                        ("Back", theme().accent)
                                    };
                                    let marker = row.marker;
                                    view.child(
                                        div()
                                            .debug_selector(move || {
                                                format!("sidebar-marker-{marker}")
                                            })
                                            .flex_shrink_0()
                                            .px(px(5.))
                                            .rounded(px(4.))
                                            .border_1()
                                            .border_color(color)
                                            .text_size(px(9.5))
                                            .text_color(color)
                                            .child(text),
                                    )
                                })
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
                                            .children(row.id.as_deref().and_then(|id| this.pin_mark(id)))
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
                                    .children(row.id.as_deref().and_then(|id| {
                                        this.pr_badge(id, cx)
                                    }))
                                    .children(
                                        this.row_settle_control(&row, keyboard, cx),
                                    )
                                    .child(this.row_archive_control(&row, keyboard, cx))
                                }),
                        ))
                        .when(row.kind == "section" && row.status == "working", |view| {
                            view.debug_selector(|| "sidebar-working-header".into())
                                .cursor_pointer()
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.toggle_working_closed(cx);
                                }))
                        })
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
                        .when(
                            thread && row.id.as_deref().is_some_and(|id| {
                                this.pinned(id) && row.status != "archived"
                            }),
                            |view| {
                                let id = row.id.clone().unwrap_or_default();
                                let over = id.clone();
                                // The row's pane drag (above) doubles as the reorder drag.
                                view.relative()
                                    .on_drag_move(cx.listener(
                                        move |this, event: &gpui::DragMoveEvent<pins::PinDrag>, _, cx| {
                                            this.pin_drag_move(&over, None, event, cx);
                                        },
                                    ))
                                    .on_drop(cx.listener(move |this, drag: &pins::PinDrag, _, cx| {
                                        this.drop_pin(drag, cx);
                                    }))
                                    .children(this.pin_drop_line(&id))
                            },
                        )
                        .when_some(this.pin_zone(i).filter(|_| !thread || !this.pinned(row.id.as_deref().unwrap_or_default())), |view, (target, after)| {
                            // Header above / heading below the shelf: drop first or last.
                            view.on_drag_move(cx.listener(
                                move |this, event: &gpui::DragMoveEvent<pins::PinDrag>, _, cx| {
                                    this.pin_drag_move(&target, Some(after), event, cx);
                                },
                            ))
                            .on_drop(cx.listener(move |this, drag: &pins::PinDrag, _, cx| {
                                this.drop_pin(drag, cx);
                            }))
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
    }
}
