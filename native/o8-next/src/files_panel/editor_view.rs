//! File textarea layout; the gutter shares the text viewport's vertical offset.
//! Rows are a fixed height, so only the lines in view (plus the cursor's) are
//! shaped and painted, whatever the file's length.
use super::*;
pub(super) const ROW: Pixels = px(19.);
/// Lines shaped beyond each edge of the viewport, so arrow keys stay exact.
const MARGIN: usize = 2;
fn shape_width(text: &str, window: &mut Window) -> Pixels {
    let part = text.replace('\t', "  ");
    window
        .text_system()
        .shape_line(
            part.clone().into(),
            px(12.),
            &[TextRun {
                len: part.len(),
                font: gpui::font(theme().font_mono),
                color: theme().text.into(),
                background_color: None,
                underline: None,
                strikethrough: None,
            }],
            None,
        )
        .width
}
impl Editor {
    /// The widest line, measured exactly for ordinary files. Large files
    /// measure their longest lines once, then only the lines each edit touched.
    fn text_width(&mut self, window: &mut Window) -> Pixels {
        let len = self.text.len();
        if let (Some(width), Some(dirty)) = (self.width, self.width_dirty.take()) {
            let first = self.lines.line_of(dirty.start.min(len));
            let last = self.lines.line_of(dirty.end.min(len));
            if self.lines.len() > lines::EXACT_WIDTH_LINES && last - first <= 256 {
                let width = (first..=last)
                    .map(|line| shape_width(&self.text[self.lines.range(line, len)], window))
                    .fold(width, Pixels::max);
                self.width = Some(width);
            } else {
                self.width = None;
            }
        }
        if let Some(width) = self.width {
            return width;
        }
        let width = self
            .lines
            .widest(len)
            .into_iter()
            .map(|line| shape_width(&self.text[self.lines.range(line, len)], window))
            .fold(px(0.), Pixels::max);
        self.width = Some(width);
        width
    }
}
impl Render for Editor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        if self.notes {
            return self.notes_view(window, cx);
        }
        if !self.focus.is_focused(window) {
            self.selecting = false;
            self.typing = None;
        }
        let input = cx.entity();
        let height = ROW * self.lines.len() as f32;
        let width = self.text_width(window) + px(1.);
        let gutter_input = input.clone();
        let gutter = div()
            .debug_selector(|| "files-editor-gutter".into())
            .w(px(50.))
            .flex_shrink_0()
            .h_full()
            .bg(theme().surface)
            .border_r_1()
            .border_color(theme().border)
            .overflow_hidden()
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, cx| {
                        let (count, offset) = {
                            let editor = gutter_input.read(cx);
                            (editor.lines.len(), editor.scroll.offset().y)
                        };
                        let first = (f32::from(-offset - px(8.)) / f32::from(ROW)).max(0.) as usize;
                        let shown =
                            (f32::from(bounds.size.height) / f32::from(ROW)).ceil() as usize;
                        for line in first.min(count)..(first + shown + 2).min(count) {
                            let y = bounds.top() + px(8.) + offset + px(line as f32 * 19.);
                            if y + px(19.) < bounds.top() || y > bounds.bottom() {
                                continue;
                            }
                            let number = (line + 1).to_string();
                            let line = window.text_system().shape_line(
                                number.clone().into(),
                                px(10.5),
                                &[TextRun {
                                    len: number.len(),
                                    font: gpui::font(theme().font_mono),
                                    color: theme().text_faint.into(),
                                    background_color: None,
                                    underline: None,
                                    strikethrough: None,
                                }],
                                None,
                            );
                            let x = bounds.right() - px(8.) - line.width;
                            let _ = line.paint(point(x, y), px(19.), window, cx);
                        }
                    },
                )
                .size_full(),
            );
        self.base(cx)
            .child(gutter)
            .child(
                div()
                    .id("files-editor-scroll")
                    .debug_selector(|| "files-editor-code".into())
                    .flex_1()
                    .min_w_0()
                    .min_h_0()
                    .overflow_scroll()
                    .track_scroll(&self.scroll)
                    .px(px(12.))
                    .py(px(8.))
                    .child(
                        canvas(
                            |_, _, _| (),
                            move |bounds, _, window, cx| {
                                // Only the lines inside the scroll viewport, plus the
                                // cursor's line for reveal and IME bounds.
                                let view = window.content_mask().bounds;
                                let (parts, empty, marked, selection, cursor, focus) = {
                                    let i = input.read(cx);
                                    let count = i.lines.len();
                                    let row =
                                        |y: Pixels| f32::from(y - bounds.top()) / f32::from(ROW);
                                    let first = (row(view.top()).max(0.) as usize)
                                        .saturating_sub(MARGIN)
                                        .min(count);
                                    let last = ((row(view.bottom()).max(0.).ceil() as usize)
                                        + MARGIN)
                                        .min(count);
                                    let cursor = i.cursor();
                                    let mut wanted: Vec<usize> = (first..last).collect();
                                    let cursor_line = i.lines.line_of(cursor);
                                    if !(first..last).contains(&cursor_line) {
                                        wanted.push(cursor_line);
                                        wanted.sort_unstable();
                                    }
                                    let parts: Vec<(usize, usize, String)> = wanted
                                        .into_iter()
                                        .map(|line| {
                                            let range = i.lines.range(line, i.text.len());
                                            (line, range.start, i.text[range].to_owned())
                                        })
                                        .collect();
                                    (
                                        parts,
                                        i.text.is_empty(),
                                        i.marked.clone(),
                                        i.selection.clone(),
                                        cursor,
                                        i.focus.clone(),
                                    )
                                };
                                window.handle_input(
                                    &focus,
                                    ElementInputHandler::new(bounds, input.clone()),
                                    cx,
                                );
                                let style = window.text_style();
                                let mut layouts = vec![];
                                // Hard lines retain their byte offsets; code rows never wrap.
                                for (line, offset, part) in &parts {
                                    let (offset, part) = (*offset, part.as_str());
                                    let mut y = bounds.top() + ROW * *line as f32;
                                    let tabs: Vec<usize> = part
                                        .bytes()
                                        .enumerate()
                                        .filter_map(|(i, b)| (b == b'\t').then_some(i))
                                        .collect();
                                    let to_display = |index: usize| {
                                        index + tabs.partition_point(|tab| *tab < index)
                                    };
                                    let to_raw = |index: usize| {
                                        index
                                            .saturating_sub(
                                                tabs.iter()
                                                    .enumerate()
                                                    .filter(|(n, tab)| index > **tab + *n)
                                                    .count(),
                                            )
                                            .min(part.len())
                                    };
                                    let display: SharedString = if part.is_empty() {
                                        " ".into()
                                    } else {
                                        part.replace('\t', "  ").into()
                                    };
                                    // Decorations belong to shaped runs. Looking up
                                    // every selected character's wrapped position is
                                    // quadratic for long single-line pastes and loses
                                    // the visual direction of right-to-left clusters.
                                    let mut boundaries = vec![0, display.len()];
                                    for range in
                                        [Some(&selection), marked.as_ref()].into_iter().flatten()
                                    {
                                        for endpoint in [range.start, range.end] {
                                            if endpoint > offset && endpoint < offset + part.len() {
                                                boundaries.push(to_display(endpoint - offset));
                                            }
                                        }
                                    }
                                    boundaries.sort_unstable();
                                    boundaries.dedup();
                                    let runs: Vec<_> = boundaries
                                        .windows(2)
                                        .map(|span| {
                                            let index = offset + to_raw(span[0]);
                                            TextRun {
                                                len: span[1] - span[0],
                                                font: style.font(),
                                                color: if empty {
                                                    theme().text_muted.into()
                                                } else {
                                                    style.color
                                                },
                                                background_color: (!empty
                                                    && selection.contains(&index))
                                                .then(|| theme().selection.into()),
                                                underline: marked
                                                    .as_ref()
                                                    .is_some_and(|r| r.contains(&index))
                                                    .then_some(UnderlineStyle {
                                                        thickness: px(1.),
                                                        color: None,
                                                        wavy: false,
                                                    }),
                                                strikethrough: None,
                                            }
                                        })
                                        .collect();
                                    let lines = window
                                        .text_system()
                                        .shape_text(display, px(12.), &runs, None, None)
                                        .expect("shape input");
                                    for line in lines {
                                        let origin = point(bounds.left(), y);
                                        let end = offset + part.len();
                                        line.paint_background(
                                            origin,
                                            px(19.),
                                            TextAlign::Left,
                                            Some(bounds),
                                            window,
                                            cx,
                                        )
                                        .expect("paint selection");
                                        line.paint(
                                            origin,
                                            px(19.),
                                            TextAlign::Left,
                                            Some(bounds),
                                            window,
                                            cx,
                                        )
                                        .expect("paint input");
                                        if focus.is_focused(window)
                                            && cursor >= offset
                                            && cursor <= end
                                        {
                                            if let Some(position) = line.position_for_index(
                                                to_display(cursor - offset),
                                                px(19.),
                                            ) {
                                                window.paint_quad(fill(
                                                    Bounds::new(
                                                        origin + position,
                                                        size(px(1.), px(19.)),
                                                    ),
                                                    theme().accent,
                                                ));
                                            }
                                        }
                                        y += px(19.) * (line.wrap_boundaries.len() + 1) as f32;
                                        layouts.push(EditorLine {
                                            start: offset,
                                            len: part.len(),
                                            line,
                                            origin,
                                            tabs: tabs.clone(),
                                            map: None,
                                            line_height: px(19.),
                                            rich: None,
                                        });
                                    }
                                }
                                input.update(cx, |input, cx| {
                                    input.canvas_top = bounds.top();
                                    if input.reveal_cursor {
                                        if let Some(position) =
                                            layouts.iter().find_map(|row: &EditorLine| {
                                                (cursor >= row.start
                                                    && cursor <= row.start + row.len)
                                                    .then(|| row.position(cursor - row.start))
                                                    .flatten()
                                                    .map(|p| row.origin + p)
                                            })
                                        {
                                            let scroll = input.scroll.offset();
                                            let cursor_y = position.y - bounds.top();
                                            let top = -scroll.y;
                                            // The viewport excludes the input's padding and border.
                                            let visible = (input.scroll.bounds().size.height
                                                - px(16.))
                                            .max(px(19.));
                                            let bottom = top + visible;
                                            let next = if cursor_y < top {
                                                -cursor_y
                                            } else if cursor_y + px(19.) > bottom {
                                                visible - px(19.) - cursor_y
                                            } else {
                                                scroll.y
                                            };
                                            let cursor_x = position.x - bounds.left();
                                            let visible_x = (input.scroll.bounds().size.width
                                                - px(24.))
                                            .max(px(20.));
                                            let left = -scroll.x;
                                            let next_x = if cursor_x < left {
                                                -cursor_x
                                            } else if cursor_x > left + visible_x {
                                                visible_x - cursor_x
                                            } else {
                                                scroll.x
                                            };
                                            if point(next_x, next) != scroll {
                                                input.scroll.set_offset(point(next_x, next));
                                                // The new lines in view paint next frame.
                                                cx.notify();
                                            }
                                        }
                                        input.reveal_cursor = false;
                                    }
                                    input.layout = layouts;
                                });
                            },
                        )
                        .w(width)
                        .min_w_full()
                        .h(height)
                        .flex_shrink_0(),
                    ),
            )
            .into_any_element()
    }
}
