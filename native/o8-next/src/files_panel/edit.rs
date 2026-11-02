//! FileViewer's Edit/Read and Modified/Save states; drafts remain local until Save.
use super::editor::Editor;
use super::*;
pub(super) struct Buffer {
    pub editor: Entity<Editor>,
    pub original: String,
    pub text: String,
    pub editing: bool,
    pub saving: bool,
    pub error: Option<String>,
    pub conflict: bool,
    pub confirm_reload: bool,
    pub mtime: Option<f64>,
}
impl Buffer {
    pub(super) fn new(text: &str, mtime: Option<f64>, cx: &mut Context<FilesPanel>) -> Self {
        Self {
            editor: cx.new(|cx| Editor::new(text, cx)),
            original: text.into(),
            text: text.into(),
            editing: false,
            saving: false,
            error: None,
            conflict: false,
            confirm_reload: false,
            mtime,
        }
    }
    pub(super) fn dirty(&self) -> bool {
        self.text != self.original
    }
}
impl FilesPanel {
    pub(super) fn watch_editor(&mut self, cx: &mut Context<Self>) {
        self.editor_subscription = None;
        if let File::Loaded { buffer, .. } = &self.file {
            self.editor_subscription =
                Some(cx.observe(&buffer.editor, |this, _, cx| this.update_draft(cx)));
        }
    }
    fn update_draft(&mut self, cx: &mut Context<Self>) {
        let path = self.selected.clone().unwrap_or_default();
        let mut svg = false;
        if let File::Loaded {
            buffer,
            lines,
            source,
            markdown,
            ..
        } = &mut self.file
        {
            let text = buffer.editor.read(cx).text.clone();
            if buffer.text == text {
                return;
            }
            buffer.text = text;
            *lines = buffer
                .text
                .split('\n')
                .map(|line| SharedString::from(line.replace('\t', "  ")))
                .collect();
            *source = source::Source::new(lines.len(), cx);
            if viewer::is_markdown(&path) {
                *markdown = viewer::markdown(&buffer.text);
            }
            svg = media::is_svg(&path);
        }
        if svg {
            self.update_svg(cx);
        }
        cx.notify();
    }
    fn update_svg(&mut self, cx: &mut Context<Self>) {
        let File::Loaded { buffer, .. } = &self.file else {
            return;
        };
        let text = buffer.text.clone();
        let generation = self.file_generation;
        let path = media::svg_path();
        let decoder = <gpui::ImageAssetLoader as gpui::Asset>::load(
            gpui::Resource::Path(path.clone().into()),
            cx,
        );
        let draft = text.clone();
        let task = cx
            .background_executor()
            .spawn(async move { media::decode_svg(path, &draft, decoder).await });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.file_generation {
                    return;
                }
                if let File::Loaded { buffer, image, .. } = &mut this.file
                    && buffer.text == text
                {
                    *image = Some(result);
                    cx.notify();
                }
            });
        })
        .detach();
    }
    pub(super) fn toggle_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let File::Loaded {
            buffer,
            truncated: false,
            ..
        } = &mut self.file
        {
            buffer.editing = !buffer.editing;
            self.editing_path = buffer.editing.then(|| self.selected.clone()).flatten();
            if buffer.editing {
                if let Some(path) = &self.selected {
                    self.view_modes
                        .insert(path.clone(), viewer::ViewMode::Source);
                }
                buffer.editor.read(cx).focus.focus(window);
            } else {
                self.viewer_focus.focus(window);
            }
            cx.notify();
        }
    }
    pub(super) fn save_file(&mut self, cx: &mut Context<Self>) {
        let File::Loaded {
            buffer,
            truncated: false,
            ..
        } = &mut self.file
        else {
            return;
        };
        if buffer.saving || !buffer.dirty() {
            return;
        }
        let Some(path) = self.selected.clone() else {
            return;
        };
        buffer.saving = true;
        buffer.error = None;
        buffer.conflict = false;
        buffer.confirm_reload = false;
        let client = self.client.clone();
        let workspace = self.workspace.clone();
        let original = buffer.original.clone();
        let text = buffer.text.clone();
        let saved = text.clone();
        let mtime = buffer.mtime;
        let generation = self.file_generation;
        let task = cx.background_executor().spawn(async move {
            super::io::save(&client, &workspace, &path, &original, &text, mtime)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.file_generation {
                    return;
                }
                if let File::Loaded { buffer, .. } = &mut this.file {
                    buffer.saving = false;
                    match result {
                        Ok(mtime) => {
                            buffer.original = saved;
                            buffer.mtime = mtime;
                        }
                        Err(super::io::SaveError::Conflict) => {
                            buffer.conflict = true;
                            buffer.error =
                                Some("This file changed on disk. Your edits are kept.".into());
                        }
                        Err(super::io::SaveError::Message(error)) => buffer.error = Some(error),
                    }
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn edit_toggle(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let editing = matches!(&self.file,File::Loaded {buffer,..} if buffer.editing);
        control(
            "files-edit-toggle",
            if editing { "Read" } else { "Edit" },
            editing,
        )
        .tooltip(move |_, cx| {
            cx.new(|_| crate::icon::Tip(if editing { "Read file" } else { "Edit file" }.into()))
                .into()
        })
        .on_click(cx.listener(|this, _, window, cx| this.toggle_edit(window, cx)))
        .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                this.toggle_edit(window, cx);
                cx.stop_propagation();
            }
        }))
    }
    pub(super) fn edit_status(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let File::Loaded { buffer, .. } = &self.file else {
            return div().into_any_element();
        };
        #[cfg(test)]
        cx.set_global(super::tests::edit_tests::Controls {
            dirty: buffer.dirty(),
            saving: buffer.saving,
            error: buffer.error.clone(),
        });
        if !buffer.dirty() && buffer.error.is_none() {
            return div().into_any_element();
        }
        let label = if buffer.confirm_reload {
            "Discard edits and reload?"
        } else {
            buffer.error.as_deref().unwrap_or("Modified")
        };
        div()
            .debug_selector(|| "files-edit-status".into())
            .min_h(px(34.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(12.))
            .bg(theme().surface)
            .border_b_1()
            .border_color(theme().border)
            .font_family(theme().font_ui)
            .text_size(px(11.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_color(if buffer.error.is_some() {
                        theme().danger
                    } else {
                        theme().text_muted
                    })
                    .child(label.to_owned()),
            )
            .when(buffer.conflict && !buffer.confirm_reload, |d| {
                d.child(
                    control("files-reload", "Reload", false).on_click(cx.listener(
                        |this, _, _, cx| {
                            if let File::Loaded { buffer, .. } = &mut this.file {
                                buffer.confirm_reload = true;
                                cx.notify();
                            }
                        },
                    )),
                )
            })
            .when(buffer.confirm_reload, |d| {
                d.child(
                    control("files-confirm-reload", "Discard and reload", false)
                        .text_color(theme().danger)
                        .on_click(cx.listener(|this, _, _, cx| this.retry_file(cx))),
                )
                .child(
                    control("files-cancel-reload", "Cancel", false).on_click(cx.listener(
                        |this, _, _, cx| {
                            if let File::Loaded { buffer, .. } = &mut this.file {
                                buffer.confirm_reload = false;
                                cx.notify();
                            }
                        },
                    )),
                )
            })
            .when(buffer.dirty() && !buffer.confirm_reload, |d| {
                d.child(
                    control(
                        "files-save",
                        if buffer.saving { "Saving..." } else { "Save" },
                        true,
                    )
                    .when(!buffer.saving, |d| {
                        d.cursor_pointer()
                            .on_click(cx.listener(|this, _, _, cx| this.save_file(cx)))
                            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                    this.save_file(cx);
                                    cx.stop_propagation();
                                }
                            }))
                    })
                    .when(buffer.saving, |d| d.opacity(0.6)),
                )
            })
            .into_any_element()
    }
}
fn control(id: &'static str, label: &str, active: bool) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .focusable()
        .min_h(px(26.))
        .px(px(7.))
        .flex()
        .items_center()
        .rounded(px(6.))
        .font_family(theme().font_ui)
        .text_size(px(11.))
        .font_weight(gpui::FontWeight::LIGHT)
        .text_color(theme().text_secondary)
        .when(active, |d| d.bg(theme().selection))
        .hover(|d| d.bg(theme().hover))
        .active(|d| d.bg(theme().selection))
        .focus(|d| d.border_1().border_color(theme().accent))
        .cursor_pointer()
        .child(label.to_owned())
}
