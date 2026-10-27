use super::*;
fn control(id: &'static str, label: &str) -> Stateful<Div> {
    div()
        .id(id)
        .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
        .debug_selector(move || id.into())
        .px(px(10.))
        .h(px(crate::theme::GEOMETRY.tab_height))
        .flex()
        .items_center()
        .rounded(px(crate::theme::GEOMETRY.tab_radius))
        .cursor_pointer()
        .text_size(px(crate::theme::TYPE.chrome))
        .child(label.to_owned())
}
impl Render for Brain {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.expanded {
            return div()
                .track_focus(&self.focus)
                .on_key_down(cx.listener(Self::key))
                .child(
                    control("brain-open", "Open Brain")
                        .on_click(cx.listener(|this, _, window, cx| this.toggle(window, cx))),
                )
                .into_any_element();
        }
        let rows = self.rows.clone();
        let painted_rows = self.painted_rows.clone();
        let revision = self.revision;
        let painted = self.painted.clone();
        let sources: Vec<_> = self
            .messages
            .iter()
            .flat_map(|m| m.sources.clone())
            .collect();
        let enabled =
            !self.busy && !self.composer.read(cx).text.trim().is_empty() && !self.repo.is_empty();
        div()
            .size_full()
            .flex()
            .flex_col()
            .min_h_0()
            .min_w_0()
            .bg(theme().background)
            .font_family(theme().font_ui)
            .font_weight(crate::theme::TYPE.weight)
            .text_size(px(crate::theme::TYPE.body))
            .text_color(theme().text)
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(Self::key))
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .px(px(16.))
                    .py(px(8.))
                    .items_center()
                    .flex_wrap()
                    .child("Brain")
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(theme().text_muted)
                            .child(
                                std::path::Path::new(&self.repo)
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .to_string(),
                            ),
                    )
                    .child(control("brain-find", "Search").on_click(cx.listener(
                        |this, _, window, cx| {
                            this.searching = !this.searching;
                            if this.searching {
                                this.search.read(cx).focus.focus(window);
                            } else {
                                this.search.update(cx, |editor, cx| editor.clear(cx));
                                this.focus(window, cx);
                            }
                            cx.notify();
                        },
                    )))
                    .child(
                        control("brain-minimize", "Close")
                            .on_click(cx.listener(|this, _, window, cx| this.toggle(window, cx))),
                    ),
            )
            .when(self.searching, |view| {
                view.child(
                    div()
                        .px(px(16.))
                        .child("Search conversation")
                        .child(self.search.clone()),
                )
            })
            .when(self.messages.is_empty(), |view| {
                view.child(div().debug_selector(|| "brain-empty".into()).p(px(16.)))
            })
            .when(!self.filter.is_empty() && self.rows.is_empty(), |view| {
                view.child(
                    div()
                        .debug_selector(|| "brain-no-results".into())
                        .p(px(16.))
                        .child("No matching messages or sources."),
                )
            })
            .child(
                list(self.list.clone(), {
                    let list_state = self.list.clone();
                    move |index, _, _| {
                        RetainedRow {
                            state: rows[index].clone(),
                            index,
                            painted: painted_rows.clone(),
                        }
                        .interactive(&list_state)
                    }
                })
                .flex_1()
                .min_h_0(),
            )
            .when(!sources.is_empty(), |view| {
                view.child(div().flex().flex_wrap().px(px(16.)).gap(px(8.)).children(
                    sources.into_iter().enumerate().map(|(i, source)| {
                        let title = source["title"]
                            .as_str()
                            .or(source["rowId"].as_str())
                            .unwrap_or("Source")
                            .to_owned();
                        let excerpt = source["excerpt"]
                            .as_str()
                            .unwrap_or("No excerpt available.")
                            .to_owned();
                        div()
                            .id(("brain-source", i))
                            .on_mouse_down(MouseButton::Left, |_, window, _| {
                                window.prevent_default()
                            })
                            .debug_selector(move || format!("brain-source-{i}"))
                            .px(px(6.))
                            .py(px(3.))
                            .rounded(px(6.))
                            .bg(theme().hover)
                            .text_size(px(10.))
                            .cursor_pointer()
                            .child(title)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.selected_source = Some(excerpt.clone());
                                this.revision += 1;
                                cx.notify();
                            }))
                    }),
                ))
            })
            .when_some(self.selected_source.clone(), |view, excerpt| {
                view.child(
                    div()
                        .debug_selector(|| "brain-source-excerpt".into())
                        .px(px(16.))
                        .py(px(8.))
                        .child(excerpt),
                )
            })
            .when_some(self.error.clone(), |view, error| {
                view.child(
                    div()
                        .debug_selector(|| "brain-error".into())
                        .px(px(16.))
                        .py(px(8.))
                        .text_color(theme().text_secondary)
                        .child(error),
                )
            })
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .p(px(10.))
                    .border_t_1()
                    .border_color(theme().border)
                    .child(div().flex_1().min_w_0().child(self.composer.clone()))
                    .child(
                        control("brain-send", "Send")
                            .bg(if enabled {
                                theme().accent
                            } else {
                                theme().hover
                            })
                            .text_color(if enabled {
                                theme().text
                            } else {
                                theme().text_faint
                            })
                            .on_click(cx.listener(|this, _, _, cx| this.ask(cx))),
                    ),
            )
            .child(
                div()
                    .flex()
                    .px(px(16.))
                    .pb(px(8.))
                    .gap(px(8.))
                    .text_size(px(crate::theme::TYPE.row_meta))
                    .font_weight(crate::theme::TYPE.meta_weight)
                    .text_color(theme().text_faint)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .child(self.route.clone()),
                    )
                    .when(!self.messages.is_empty(), |view| {
                        view.child(
                            control("brain-clear", "Clear conversation")
                                .on_click(cx.listener(|this, _, _, cx| this.clear(cx))),
                        )
                    }),
            )
            .child(canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision)).size(px(1.)))
            .into_any_element()
    }
}
