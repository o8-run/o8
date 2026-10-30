//! Source rows use measured heights. GPUI's list remeasures on width changes.
use super::*;
use gpui::{ListAlignment, ListState, Pixels, TextRun, font, list};
use std::cell::Cell;

pub(super) struct Source {
    list: ListState,
    width: Cell<Option<Pixels>>,
    colors: super::syntax::Colors,
}
impl Source {
    pub(super) fn new(count: usize) -> Self {
        Self {
            list: ListState::new(count, ListAlignment::Top, px(300.)),
            width: Cell::new(None),
            colors: super::syntax::Colors::default(),
        }
    }
    pub(super) fn view(
        &self,
        lines: &[SharedString],
        path: &str,
        wrap: bool,
        generation: u64,
        window: &mut Window,
        cx: &mut Context<FilesPanel>,
    ) -> gpui::AnyElement {
        let gutter = ((lines.len().max(1).to_string().len() as f32) * 7.5 + 16.).max(36.);
        let colors = self.colors.rows(path, lines, cx);
        #[cfg(test)]
        cx.set_global(super::tests::source_tests::Painted(
            vec![],
            self.colors.failed(),
        ));
        let width = if wrap {
            px(0.)
        } else {
            self.width.get().unwrap_or_else(|| {
                let width = lines
                    .iter()
                    .map(|line| {
                        window
                            .text_system()
                            .shape_line(
                                line.clone(),
                                px(12.),
                                &[TextRun {
                                    len: line.len(),
                                    font: font(theme().font_mono),
                                    color: theme().text.into(),
                                    background_color: None,
                                    underline: None,
                                    strikethrough: None,
                                }],
                                None,
                            )
                            .width
                    })
                    .max()
                    .unwrap_or(px(0.))
                    + px(gutter + 16.);
                self.width.set(Some(width));
                width
            })
        };
        let lines = lines.to_vec();
        div()
            .id("files-source")
            .debug_selector(move || format!("files-source-{generation}"))
            .flex_1()
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .overflow_x_scroll()
            .when(self.colors.failed(), |view| {
                view.child(self.colors.notice(cx))
            })
            .child(
                list(self.list.clone(), move |i, _, cx| {
                    let spans = colors.get(i).cloned().unwrap_or_default();
                    #[cfg(test)]
                    cx.global_mut::<super::tests::source_tests::Painted>()
                        .0
                        .push((lines[i].to_string(), spans.clone()));
                    let _ = cx;
                    let text = gpui::StyledText::new(lines[i].clone()).with_highlights(
                        spans.into_iter().map(|(range, color)| {
                            (
                                range,
                                gpui::HighlightStyle {
                                    color: Some(color.into()),
                                    ..Default::default()
                                },
                            )
                        }),
                    );
                    div()
                        .w_full()
                        .min_w_0()
                        .min_h(px(19.))
                        .flex()
                        .items_start()
                        .debug_selector(move || format!("files-source-line-{generation}-{i}"))
                        .font_family(theme().font_mono)
                        .text_size(px(12.))
                        .line_height(px(19.))
                        .child(
                            div()
                                .debug_selector(move || {
                                    format!("files-source-number-{generation}-{i}")
                                })
                                .w(px(gutter))
                                .flex_shrink_0()
                                .pr(px(12.))
                                .text_align(gpui::TextAlign::Right)
                                .text_color(theme().text_faint)
                                .child((i + 1).to_string()),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .ml(px(12.))
                                .pr(px(12.))
                                .debug_selector(move || {
                                    format!("files-source-code-{generation}-{i}")
                                })
                                .text_color(theme().text)
                                .when(!wrap, |text| text.whitespace_nowrap())
                                .child(text),
                        )
                        .into_any_element()
                })
                .flex_1()
                .w_full()
                .min_w(width)
                .min_h_0()
                .py(px(8.)),
            )
            .into_any_element()
    }
}
impl FilesPanel {
    fn toggle_wrap(&mut self, cx: &mut Context<Self>) {
        self.wrap_lines = !self.wrap_lines;
        if let File::Loaded { lines, source, .. } = &self.file {
            source.list.reset(lines.len());
        }
        cx.notify();
    }
    pub(super) fn wrap_toggle(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let label = if self.wrap_lines {
            "Turn word wrap off"
        } else {
            "Turn word wrap on"
        };
        div()
            .id("files-wrap-toggle")
            .debug_selector(|| "files-wrap-toggle".into())
            .focusable()
            .size(px(26.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .cursor_pointer()
            .when(self.wrap_lines, |button| button.bg(theme().hover))
            .hover(|button| button.bg(theme().hover))
            .active(|button| button.bg(theme().selection))
            .focus(|button| button.border_1().border_color(theme().accent))
            .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(label.into())).into())
            .child(crate::icon::stroke(
                "M4 5h16 M4 10h12a4 4 0 0 1 0 8h-5 m3-3-3 3 3 3 M4 15h3 M4 20h3",
                if self.wrap_lines {
                    theme().text_secondary
                } else {
                    theme().text_muted
                },
                15.,
                1.6,
            ))
            .on_click(cx.listener(|this, _, _, cx| this.toggle_wrap(cx)))
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    this.toggle_wrap(cx);
                    cx.stop_propagation();
                }
            }))
    }
}
