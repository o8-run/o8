//! O8SpecEditor's wrapped native input and classic prose metrics, without a gutter.
use super::*;
impl Editor {
    pub(super) fn notes_view(&mut self, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let input = cx.entity();
        let height = self.height;
        self.base(cx)
            .flex_col()
            .font_family(theme().font_ui)
            .font_weight(FontWeight::LIGHT)
            .text_size(px(13.5))
            .line_height(px(20.925))
            .child(
                div()
                    .id("spec-scroll")
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .child(
                        div()
                            .flex()
                            .pt(px(22.))
                            .pb(px(26.))
                            .pl(px(4.))
                            .pr(px(8.))
                            .child(
                                canvas(
                                    |_, _, _| (),
                                    move |bounds, _, window, cx| {
                                        let (text, selection, marked, cursor, focus, color) = {
                                            let i = input.read(cx);
                                            (
                                                i.text.clone(),
                                                i.selection.clone(),
                                                i.marked.clone(),
                                                i.cursor(),
                                                i.focus.clone(),
                                                i.note_color,
                                            )
                                        };
                                        window.handle_input(
                                            &focus,
                                            ElementInputHandler::new(bounds, input.clone()),
                                            cx,
                                        );
                                        let rows = super::super::spec_document::lines(
                                            &text,
                                            &selection,
                                            marked.as_ref(),
                                            color,
                                        );
                                        #[cfg(test)]
                                        cx.set_global(super::super::tests::spec_tests::Painted(
                                            rows.iter()
                                                .map(|r| {
                                                    (
                                                        r.display.to_string(),
                                                        r.size,
                                                        r.runs
                                                            .first()
                                                            .map(|r| r.font.weight.0)
                                                            .unwrap_or(300.),
                                                    )
                                                })
                                                .collect(),
                                        ));
                                        let mut y = bounds.top();
                                        let mut layout = vec![];
                                        for row in rows {
                                            let shaped = window
                                                .text_system()
                                                .shape_text(
                                                    row.display,
                                                    px(row.size),
                                                    &row.runs,
                                                    Some(bounds.size.width.max(px(10.))),
                                                    None,
                                                )
                                                .expect("shape notes");
                                            for line in shaped {
                                                let origin = point(bounds.left(), y);
                                                line.paint_background(
                                                    origin,
                                                    px(row.height),
                                                    TextAlign::Left,
                                                    Some(bounds),
                                                    window,
                                                    cx,
                                                )
                                                .expect("notes selection");
                                                line.paint(
                                                    origin,
                                                    px(row.height),
                                                    TextAlign::Left,
                                                    Some(bounds),
                                                    window,
                                                    cx,
                                                )
                                                .expect("notes text");
                                                let mapped = EditorLine {
                                                    start: row.start,
                                                    len: row.len,
                                                    tabs: vec![],
                                                    map: Some(row.map.clone()),
                                                    line_height: px(row.height),
                                                    line,
                                                    origin,
                                                };
                                                if focus.is_focused(window)
                                                    && cursor >= row.start
                                                    && cursor <= row.start + row.len
                                                {
                                                    if let Some(p) =
                                                        mapped.position(cursor - row.start)
                                                    {
                                                        window.paint_quad(fill(
                                                            Bounds::new(
                                                                origin + p,
                                                                size(px(1.5), px(row.height)),
                                                            ),
                                                            color,
                                                        ));
                                                    }
                                                }
                                                y += px(row.height)
                                                    * (mapped.line.wrap_boundaries.len() + 1)
                                                        as f32;
                                                layout.push(mapped);
                                            }
                                        }
                                        input.update(cx, |input, cx| {
                                            let h = (y - bounds.top()).max(px(20.925));
                                            if input.height != h {
                                                input.height = h;
                                                cx.notify();
                                            }
                                            if input.reveal_cursor {
                                                if let Some(p) = layout.iter().find_map(|r| {
                                                    (cursor >= r.start && cursor <= r.start + r.len)
                                                        .then(|| {
                                                            r.position(cursor - r.start)
                                                                .map(|p| r.origin + p)
                                                        })
                                                        .flatten()
                                                }) {
                                                    let offset = input.scroll.offset();
                                                    let top = -offset.y;
                                                    let visible =
                                                        (input.scroll.bounds().size.height
                                                            - px(48.))
                                                        .max(px(20.925));
                                                    let at = p.y - bounds.top();
                                                    input.scroll.set_offset(point(
                                                        px(0.),
                                                        if at < top {
                                                            -at
                                                        } else if at + px(20.925) > top + visible {
                                                            visible - at - px(20.925)
                                                        } else {
                                                            offset.y
                                                        },
                                                    ));
                                                }
                                                input.reveal_cursor = false;
                                            }
                                            input.layout = layout;
                                        });
                                    },
                                )
                                .flex_1()
                                .min_w_0()
                                .h(height)
                                .flex_shrink_0(),
                            )
                            .child(div().w(px(150.)).flex_shrink_0()),
                    ),
            )
            .into_any_element()
    }
}
