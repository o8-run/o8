//! Retained session regions keep transcript layout out of editor frames.
use super::*;
use gpui::StyleRefinement;

pub(super) fn header_style() -> StyleRefinement {
    let mut style = StyleRefinement::default();
    style.size.width = Some(gpui::relative(1.).into());
    style.size.height = Some(px(crate::theme::GEOMETRY.header).into());
    style.flex_shrink = Some(0.);
    style
}

pub(super) fn sidebar_style(width: gpui::Pixels) -> StyleRefinement {
    let mut style = StyleRefinement::default();
    style.size.width = Some(width.into());
    style.flex_shrink = Some(0.);
    style
}

pub(super) fn transcript_style() -> StyleRefinement {
    let mut style = StyleRefinement::default();
    style.size.width = Some(gpui::relative(1.).into());
    style.flex_grow = Some(1.);
    style.flex_basis = Some(px(0.).into());
    style.min_size.height = Some(px(0.).into());
    style
}

impl Surface {
    pub(super) fn session_header(
        &mut self,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        div()
            .h(px(crate::theme::GEOMETRY.header))
            .px(px(16.))
            .flex()
            .items_center()
            .gap(px(16.))
            .child("o8 next")
            .child(self.brain_control(cx))
            .child(
                div()
                    .id("refresh")
                    .debug_selector(|| "session-refresh".into())
                    .px(px(8.))
                    .py(px(4.))
                    .rounded(px(5.))
                    .cursor_pointer()
                    .bg(theme().surface_raised)
                    .child("Refresh")
                    .on_click(cx.listener(|this, _, _, cx| this.load_sessions(cx))),
            )
            .into_any_element()
    }
    pub(super) fn session_sidebar_region(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let width = (f32::from(window.viewport_size().width) * 0.25)
            .min(crate::theme::GEOMETRY.sidebar_width);
        self.session_sidebar(px(width), cx)
    }
    pub(super) fn session_transcript(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let rows = self.rows.clone();
        // Waiting messages ride as the list's last item, so they scroll with
        // the turns as in classic.
        let queued = Rc::new(self.queued_items());
        let tail = usize::from(!queued.is_empty());
        let count = self.list.item_count();
        if count != rows.len() + tail && (count == rows.len() || count == rows.len() + 1) {
            self.list.splice(rows.len()..count, tail);
        }
        // After the tail is in the list, so a just-sent message is revealed.
        self.follow_frame();
        let queue_enabled = self.queue_ready && !self.saving;
        let steerable = Rc::new(self.queue["steerableIds"].clone());
        let painted_rows = self.painted_rows.clone();
        let file_root: Option<gpui::SharedString> = self
            .selected
            .as_ref()
            .and_then(|id| self.sessions.iter().find(|s| s.id == *id))
            .and_then(|s| s.repo_path.clone())
            .map(Into::into);
        // Play and Copy under each finished turn's answer; a row that gains or
        // loses them is measured again.
        let ends = Rc::new(crate::transcript_actions::turn_ends(&rows));
        let prompts = Rc::new(self.prompt_action_rows(window, cx));
        let marked: BTreeSet<usize> = ends.keys().chain(prompts.keys()).copied().collect();
        for index in marked.symmetric_difference(&self.action_rows) {
            if *index < rows.len() {
                self.remeasure_action_row(*index);
            }
        }
        self.action_rows = marked;
        let (view, client, feedback) = (
            cx.entity(),
            self.client.clone(),
            self.action_feedback.clone(),
        );
        div()
            .debug_selector(|| "transcript-viewport".into())
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .on_scroll_wheel(cx.listener(|this, _: &gpui::ScrollWheelEvent, _, _| {
                this.following = None;
                this.pinned = false;
            }))
            .when(!self.notice.is_empty(), |view| {
                view.child(
                    div()
                        .px(px(24.))
                        .py(px(8.))
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child(self.notice.clone()),
                )
            })
            .child(
                list(self.list.clone(), {
                    let list_state = self.list.clone();
                    let view = view.clone();
                    move |index, window, _| {
                        if index >= rows.len() {
                            return super::conversation::queue_tail(
                                &queued,
                                queue_enabled,
                                &steerable,
                                view.clone(),
                            );
                        }
                        if rows[index].borrow().file_root != file_root {
                            rows[index].borrow_mut().file_root = file_root.clone();
                        }
                        let row = RetainedRow {
                            state: rows[index].clone(),
                            index,
                            painted: painted_rows.clone(),
                        }
                        .interactive(&list_state);
                        if let Some(prompt) = prompts.get(&index) {
                            return super::prompt_actions::container(view.clone(), prompt)
                                .debug_selector(move || format!("transcript-row-{index}"))
                                .w_full()
                                .flex()
                                .flex_col()
                                .child(row)
                                .child(super::prompt_actions::row(&view, prompt, window))
                                .into_any_element();
                        }
                        match ends.get(&index) {
                            Some(text) => div()
                                .debug_selector(move || format!("transcript-row-{index}"))
                                .w_full()
                                .flex()
                                .flex_col()
                                .child(row)
                                .child(crate::transcript_actions::row(
                                    view.clone(),
                                    client.clone(),
                                    feedback.clone(),
                                    index,
                                    text.clone(),
                                ))
                                .into_any_element(),
                            None => div()
                                .debug_selector(move || format!("transcript-row-{index}"))
                                .w_full()
                                .child(row)
                                .into_any_element(),
                        }
                    }
                })
                .flex_1()
                .min_h_0(),
            )
            .child(self.history_control(cx))
            .when(self.away_from_end, |d| d.child(self.jump_to_end(cx)))
            .into_any_element()
    }
    /// Classic's round jump-to-latest button, centred over the transcript's
    /// bottom edge while the reader is scrolled up.
    fn jump_to_end(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .absolute()
            .bottom(px(12.))
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .child(
                div()
                    .id("transcript-jump-to-end")
                    .debug_selector(|| "transcript-jump-to-end".into())
                    .size(px(40.))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .bg(theme().surface_raised)
                    .border_1()
                    .border_color(theme().border)
                    .shadow_md()
                    .hover(|d| d.bg(theme().hover))
                    .tooltip(|_, cx| cx.new(|_| crate::icon::Tip("Jump to latest".into())).into())
                    .on_click(cx.listener(|this, _, _, cx| {
                        let last = this.list.item_count().saturating_sub(1);
                        this.list.scroll_to_reveal_item(last);
                        this.pinned = true;
                        this.away_from_end = false;
                        cx.notify();
                    }))
                    .child(crate::icon::stroke(
                        "M12 5v14M5 12l7 7 7-7",
                        theme().text,
                        18.,
                        2.,
                    )),
            )
    }
}

pub(super) fn footer_style() -> StyleRefinement {
    let mut style = header_style();
    style.size.height = None;
    style
}
