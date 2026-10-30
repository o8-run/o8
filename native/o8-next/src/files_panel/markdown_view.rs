//! MarkdownRender's file typography and scrolling, separate from chat layout.
use super::*;
use crate::{
    model::Row,
    retained::RowState,
    text::{Node, Run},
};
use gpui::{FontStyle, FontWeight, Pixels, StyledText, TextAlign, TextRun, font};
use std::{cell::RefCell, rc::Rc};

fn runs(source: &[Run], weight: FontWeight, code: bool, muted: bool) -> Vec<TextRun> {
    source
        .iter()
        .map(|run| {
            let mono = code || run.style == "code";
            let mut face = font(if mono {
                theme().font_mono
            } else {
                theme().font_ui
            });
            face.weight = if run.style == "strong" {
                FontWeight::MEDIUM
            } else {
                weight
            };
            if run.style == "em" {
                face.style = FontStyle::Italic;
            }
            TextRun {
                len: run.text.len(),
                font: face,
                color: if run.style == "link" {
                    theme().accent
                } else if muted {
                    theme().text_muted
                } else {
                    theme().text
                }
                .into(),
                background_color: (run.style == "code" && !code).then(|| theme().surface.into()),
                underline: None,
                strikethrough: (run.style == "strike").then(|| gpui::StrikethroughStyle {
                    thickness: px(1.),
                    color: None,
                }),
            }
        })
        .collect()
}
fn rich_text(
    source: &[Run],
    kind: &str,
    weight: FontWeight,
    _cx: &mut Context<FilesPanel>,
) -> StyledText {
    let text = StyledText::new(source.iter().map(|r| r.text.as_str()).collect::<String>())
        .with_runs(runs(source, weight, kind == "code-block", kind == "quote"));
    #[cfg(test)]
    _cx.global_mut::<super::tests::markdown_tests::DocumentView>()
        .text
        .push((kind.into(), text.layout().clone()));
    text
}
fn intrinsic(source: &[Run], weight: FontWeight, code: bool, window: &Window) -> Pixels {
    let text = source.iter().map(|r| r.text.as_str()).collect::<String>();
    window
        .text_system()
        .shape_text(
            text.into(),
            px(if code { 12. } else { 13.5 }),
            &runs(source, weight, code, false),
            None,
            None,
        )
        .expect("file text runs")
        .iter()
        .map(|line| line.size(px(21.)).width)
        .max()
        .unwrap_or(px(0.))
        .ceil()
}
fn table(
    node: &Node,
    index: usize,
    generation: u64,
    window: &Window,
    cx: &mut Context<FilesPanel>,
) -> gpui::AnyElement {
    let data = node.data.as_ref().expect("table data");
    let headers: Vec<Vec<Run>> =
        serde_json::from_value(data["headers"].clone()).unwrap_or_default();
    let mut rows = vec![headers];
    rows.extend(
        serde_json::from_value::<Vec<Vec<Vec<Run>>>>(data["rows"].clone()).unwrap_or_default(),
    );
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let mut widths = vec![px(48.); columns];
    for (row_index, row) in rows.iter().enumerate() {
        let weight = if row_index == 0 {
            FontWeight::MEDIUM
        } else {
            FontWeight::LIGHT
        };
        for (column, cell) in row.iter().enumerate() {
            widths[column] = widths[column].max(intrinsic(cell, weight, false, window) + px(24.));
        }
    }
    let width: Pixels = widths
        .iter()
        .copied()
        .fold(px(0.), |total, width| total + width);
    let mut content = div().w(width).flex_shrink_0().flex().flex_col();
    for (row_index, row) in rows.iter().enumerate() {
        let mut element = div()
            .flex()
            .flex_shrink_0()
            .border_b_1()
            .border_color(theme().border);
        for (column, width) in widths.iter().enumerate() {
            let empty = Vec::new();
            let source = row.get(column).unwrap_or(&empty);
            let weight = if row_index == 0 {
                FontWeight::MEDIUM
            } else {
                FontWeight::LIGHT
            };
            let align = match data["aligns"][column].as_str() {
                Some("right") => TextAlign::Right,
                Some("center") => TextAlign::Center,
                _ => TextAlign::Left,
            };
            element = element.child(
                div()
                    .w(*width)
                    .flex_shrink_0()
                    .px(px(12.))
                    .py(px(6.))
                    .whitespace_nowrap()
                    .text_align(align)
                    .debug_selector(move || {
                        format!("files-markdown-table-{index}-cell-{row_index}-{column}")
                    })
                    .child(rich_text(source, "table-cell", weight, cx)),
            );
        }
        content = content.child(element);
    }
    div()
        .id(SharedString::from(format!(
            "files-markdown-table-{generation}-{index}"
        )))
        .debug_selector(move || format!("files-markdown-table-{index}"))
        .w_full()
        .min_w_0()
        .overflow_x_scroll()
        .child(content)
        .into_any_element()
}

pub(super) fn view(
    state: Rc<RefCell<RowState>>,
    generation: u64,
    window: &Window,
    cx: &mut Context<FilesPanel>,
) -> gpui::AnyElement {
    #[cfg(test)]
    cx.set_global(super::tests::markdown_tests::DocumentView::default());
    let state = state.borrow();
    let Row::Message { nodes, .. } = &state.row else {
        unreachable!("file document")
    };
    let mut content = div()
        .id("files-markdown")
        .debug_selector(move || format!("files-markdown-{generation}"))
        .flex_1()
        .min_w_0()
        .min_h_0()
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .px(px(22.))
        .pt(px(18.))
        .pb(px(22.))
        .font_family(theme().font_ui)
        .font_weight(FontWeight::LIGHT)
        .text_color(theme().text)
        .text_size(px(13.5))
        .line_height(px(13.5 * 1.55));
    let mut previous_bottom: f32 = 0.;
    for (index, node) in nodes.iter().enumerate() {
        let heading = node
            .kind
            .strip_prefix('h')
            .and_then(|s| s.parse::<u8>().ok());
        let (top, bottom) = if let Some(level) = heading {
            (if level == 1 { 4. } else { 18. }, 8.)
        } else if node.kind == "code-block" {
            (10., 10.)
        } else if node.kind == "ul" || node.kind.starts_with("ol:") {
            (4., 4.)
        } else {
            (0., 10.)
        };
        // CSS sibling margins collapse in classic. Use the larger gap here.
        let mut block = div()
            .debug_selector(move || format!("files-markdown-block-{index}"))
            .w_full()
            .min_w_0()
            .flex_shrink_0()
            .mt(px(previous_bottom.max(top)));
        previous_bottom = bottom;
        if let Some(level) = heading {
            let size = match level {
                1 => 22.,
                2 => 18.,
                3 => 15.,
                _ => 13.,
            };
            block = block
                .text_size(px(size))
                .line_height(px(size * 1.25))
                .font_weight(FontWeight::NORMAL)
                .child(rich_text(&node.runs, &node.kind, FontWeight::NORMAL, cx));
        } else if node.kind == "table" {
            block = block.child(table(node, index, generation, window, cx));
        } else if node.kind == "code-block" {
            let width = intrinsic(&node.runs, FontWeight::LIGHT, true, window) + px(24.);
            block = block
                .rounded(px(14.))
                .bg(theme().surface)
                .border_1()
                .border_color(theme().border)
                .text_size(px(12.))
                .line_height(px(12. * 1.55))
                .child(
                    div()
                        .id(("file-code", index))
                        .w_full()
                        .min_w_0()
                        .overflow_x_scroll()
                        .child(
                            div()
                                .w(width)
                                .min_w_full()
                                .px(px(12.))
                                .py(px(10.))
                                .whitespace_nowrap()
                                .child(rich_text(&node.runs, &node.kind, FontWeight::LIGHT, cx)),
                        ),
                );
        } else if node.kind == "rule" {
            block = block.h(px(1.)).bg(theme().border);
        } else {
            let text = rich_text(&node.runs, &node.kind, FontWeight::LIGHT, cx);
            if node.kind == "ul" || node.kind.starts_with("ol:") || node.kind == "li-p" {
                let depth = node
                    .data
                    .as_ref()
                    .and_then(|d| d["depth"].as_u64())
                    .unwrap_or(0);
                let marker = if node.kind == "ul" {
                    "•".to_owned()
                } else {
                    node.kind.strip_prefix("ol:").unwrap_or("").to_owned()
                };
                block = block
                    .pl(px(depth as f32 * 22.))
                    .flex()
                    .items_start()
                    .child(div().w(px(22.)).flex_shrink_0().child(marker))
                    .child(div().flex_1().min_w_0().child(text));
            } else {
                block = block
                    .when(node.kind == "quote", |b| {
                        b.px(px(10.))
                            .py(px(6.))
                            .rounded(px(12.))
                            .border_1()
                            .border_color(theme().border)
                            .bg(theme().surface)
                    })
                    .child(text);
            }
        }
        content = content.child(block);
    }
    content.into_any_element()
}
