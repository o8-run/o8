//! Entry point for the requested legacy ChangesList and DiffViewer contracts.
use super::*;
impl FilesPanel {
    fn switch_files(&mut self, changes: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.show_changes = changes;
        if changes {
            if self.changes.is_none() {
                let client = self.client.clone();
                let workspace = self.workspace.clone();
                self.changes =
                    Some(cx.new(|cx| super::changes::Changes::new(client, workspace, cx)));
            } else if let Some(view) = &self.changes {
                view.update(cx, |view, cx| view.refresh(cx));
            }
            if let Some(view) = &self.changes {
                view.read(cx).focus.focus(window);
            }
        } else {
            self.focus(window);
            if let File::Loaded { buffer, .. } = &self.file
                && buffer.editing
            {
                buffer.editor.read(cx).focus.focus(window);
            }
        }
        cx.notify();
    }
    pub(super) fn frame(&self, body: gpui::AnyElement, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .track_focus(&self.focus)
            .size_full()
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .when(self.mode == Mode::Files, |d| {
                d.child(
                    div()
                        .h(px(30.))
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .gap(px(2.))
                        .px(px(7.))
                        .border_b_1()
                        .border_color(theme().border)
                        .children(
                            [
                                (false, "Files", "files-show-files"),
                                (true, "Changes", "files-show-changes"),
                            ]
                            .map(|(mode, label, id)| {
                                let active = self.show_changes == mode;
                                div()
                                    .id(id)
                                    .debug_selector(move || id.into())
                                    .focusable()
                                    .h(px(24.))
                                    .px(px(8.))
                                    .flex()
                                    .items_center()
                                    .rounded(px(6.))
                                    .font_family(theme().font_ui)
                                    .font_weight(gpui::FontWeight::LIGHT)
                                    .text_size(px(11.))
                                    .text_color(if active {
                                        theme().accent
                                    } else {
                                        theme().text_muted
                                    })
                                    .when(active, |d| d.bg(theme().selection))
                                    .cursor_pointer()
                                    .hover(|d| d.bg(theme().hover))
                                    .active(|d| d.bg(theme().selection))
                                    .focus(|d| d.border_1().border_color(theme().accent))
                                    .child(label)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.switch_files(mode, window, cx)
                                    }))
                                    .on_key_down(cx.listener(
                                        move |this, event: &gpui::KeyDownEvent, window, cx| {
                                            if matches!(
                                                event.keystroke.key.as_str(),
                                                "enter" | "space"
                                            ) {
                                                this.switch_files(mode, window, cx);
                                                cx.stop_propagation();
                                            }
                                        },
                                    ))
                            }),
                        ),
                )
            })
            .child(body)
    }
}
