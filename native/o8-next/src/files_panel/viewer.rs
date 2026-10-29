//! FileViewer's preview/source contract, using the transcript's Markdown layout.
use super::*;
use crate::{
    model::Row,
    retained::{RetainedRow, RowState},
};
use std::{cell::RefCell, collections::BTreeSet, rc::Rc};

#[derive(Clone, Copy, PartialEq)]
pub(super) enum ViewMode {
    Preview,
    Source,
}

pub(super) fn is_markdown(path: &str) -> bool {
    path.rsplit('.')
        .next()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("mdx"))
}

pub(super) fn markdown(source: &str) -> Rc<RefCell<RowState>> {
    Rc::new(RefCell::new(RowState::new(Row::Message {
        id: "file-markdown".into(),
        role: "assistant".into(),
        nodes: crate::text::markdown(source),
    })))
}

pub(super) fn markdown_view(state: Rc<RefCell<RowState>>, generation: u64) -> gpui::AnyElement {
    div()
        .id("files-markdown")
        .debug_selector(move || format!("files-markdown-{generation}"))
        .flex_1()
        .min_w_0()
        .min_h_0()
        .overflow_y_scroll()
        .py(px(10.))
        .child(RetainedRow {
            state,
            index: 0,
            painted: Rc::new(RefCell::new(BTreeSet::new())),
        })
        .into_any_element()
}

impl FilesPanel {
    pub(super) fn view_mode(&self) -> ViewMode {
        self.selected
            .as_ref()
            .and_then(|path| self.view_modes.get(path).copied())
            .unwrap_or_else(|| {
                if self
                    .selected
                    .as_deref()
                    .is_some_and(|path| is_markdown(path) || super::media::is_svg(path))
                {
                    ViewMode::Preview
                } else {
                    ViewMode::Source
                }
            })
    }
    pub(super) fn preview_toggle(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .items_center()
            .gap(px(2.))
            .p(px(2.))
            .flex_shrink_0()
            .border_1()
            .border_color(theme().border)
            .rounded(px(8.))
            .bg(theme().surface)
            .children(
                [
                    (ViewMode::Preview, "Preview", "files-preview-toggle"),
                    (ViewMode::Source, "Source", "files-source-toggle"),
                ]
                .map(|(mode, label, id)| {
                    let active = self.view_mode() == mode;
                    div()
                        .id(id)
                        .debug_selector(move || id.into())
                        .focusable()
                        .h(px(22.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .rounded(px(6.))
                        .text_size(px(11.))
                        .font_weight(gpui::FontWeight::LIGHT)
                        .text_color(if active {
                            theme().accent
                        } else {
                            theme().text_muted
                        })
                        .when(active, |button| button.bg(theme().selection))
                        .hover(|button| button.bg(theme().hover))
                        .active(|button| button.bg(theme().selection))
                        .focus(|button| button.border_1().border_color(theme().accent))
                        .cursor_pointer()
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| this.set_view_mode(mode, cx)))
                        .on_key_down(cx.listener(move |this, event: &gpui::KeyDownEvent, _, cx| {
                            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                this.set_view_mode(mode, cx);
                                cx.stop_propagation();
                            }
                        }))
                }),
            )
    }
    fn set_view_mode(&mut self, mode: ViewMode, cx: &mut Context<Self>) {
        if let Some(path) = &self.selected {
            self.view_modes.insert(path.clone(), mode);
        }
        cx.notify();
    }
}

/// FileViewer's two-line title; each line gets the available width independently.
pub(super) fn file_heading(path: &str, _cx: &mut Context<FilesPanel>) -> impl IntoElement {
    let (folder, name) = path.rsplit_once('/').unwrap_or(("", path));
    let name_text = gpui::StyledText::new(name.to_owned());
    let folder_text = gpui::StyledText::new(if folder.is_empty() {
        "/".to_owned()
    } else {
        folder.to_owned()
    });
    #[cfg(test)]
    _cx.set_global(super::tests::HeadingLayouts {
        name: name_text.layout().clone(),
        folder: folder_text.layout().clone(),
    });
    div()
        .id("files-viewer-title")
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(3.))
        .tooltip({
            let path = path.to_owned();
            move |_, cx| cx.new(|_| crate::icon::Tip(path.clone().into())).into()
        })
        .child(
            div()
                .debug_selector(|| "files-viewer-name".into())
                .w_full()
                .min_w_0()
                .overflow_hidden()
                .whitespace_normal()
                .line_clamp(1)
                .text_ellipsis()
                .font_family(theme().font_ui)
                .text_size(px(13.5))
                .line_height(px(17.))
                .font_weight(gpui::FontWeight::LIGHT)
                .text_color(theme().text)
                .child(name_text),
        )
        .when(path.contains('/'), |heading| {
            heading.child(
                div()
                    .debug_selector(|| "files-viewer-folder".into())
                    .w_full()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_normal()
                    .line_clamp(1)
                    .text_ellipsis()
                    .font_family(theme().font_ui)
                    .text_size(px(9.5))
                    .line_height(px(12.))
                    .font_weight(gpui::FontWeight(260.))
                    .text_color(theme().text_muted)
                    .child(folder_text),
            )
        })
}

impl FilesPanel {
    pub(super) fn file_error(&self, error: &str, cx: &mut Context<Self>) -> gpui::AnyElement {
        let name = self
            .selected
            .as_deref()
            .unwrap_or("file")
            .rsplit('/')
            .next()
            .unwrap_or("file");
        div().debug_selector(|| "files-load-error".into()).p(px(20.)).flex().flex_col().gap(px(8.))
            .font_family(theme().font_ui).text_size(px(13.)).font_weight(gpui::FontWeight::LIGHT).text_color(theme().text)
            .child(format!("Could not load {name}"))
            .child(div().text_color(theme().text_muted).child(error.to_owned()))
            .child(div().text_size(px(11.)).text_color(theme().text_muted).child("Retry, or reopen the file from Search if it moved or its repository changed."))
            .child(div().id("files-retry").debug_selector(|| "files-retry".into()).focusable()
                .px(px(8.)).py(px(5.)).rounded(px(7.)).border_1().border_color(theme().border)
                .hover(|button| button.bg(theme().hover)).active(|button| button.bg(theme().selection))
                .focus(|button| button.border_color(theme().accent)).cursor_pointer().child("Retry")
                .on_click(cx.listener(|this, _, _, cx| this.retry_file(cx)))
                .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                    if matches!(event.keystroke.key.as_str(), "enter" | "space") { this.retry_file(cx); cx.stop_propagation(); }
                })))
            .into_any_element()
    }
    fn retry_file(&mut self, cx: &mut Context<Self>) {
        if self.mode == Mode::Spec {
            self.load_spec(cx);
        } else if let Some(path) = self.selected.clone() {
            self.open_file(path, cx);
        }
    }
}
