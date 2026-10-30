//! File textarea layout; the gutter shares the text viewport's vertical offset.
use super::*;
impl Render for Editor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.focus.is_focused(window) {
            self.selecting = false;
            self.typing = None;
        }
        let input = cx.entity();
        let height = self.height;
        let width = self
            .text
            .split('\n')
            .map(|part| {
                let part = part.replace('\t', "  ");
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
            })
            .max()
            .unwrap_or(px(0.))
            + px(1.);
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
                            (editor.text.split('\n').count(), editor.scroll.offset().y)
                        };
                        for line in 0..count {
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
        div()
            .id("files-editor")
            .debug_selector(|| "files-editor".into())
            .flex_1()
            .min_w_0()
            .min_h_0()
            .flex()
            .text_color(theme().text)
            .font_family(theme().font_mono)
            .text_size(px(12.))
            .line_height(px(19.))
            .track_focus(&self.focus)
            .key_context(self.context)
            .tab_stop(true)
            .cursor(CursorStyle::IBeam)
            .on_key_down(cx.listener(Self::key))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    this.focus.focus(window);
                    this.selecting = true;
                    this.typing = None;
                    let cursor = this.index_at(event.position);
                    let range = match event.click_count {
                        2 => this
                            .text
                            .split_word_bound_indices()
                            .find(|(i, word)| *i <= cursor && cursor < i + word.len())
                            .map(|(i, word)| i..i + word.len()),
                        3.. => Some(
                            this.text[..cursor].rfind('\n').map(|i| i + 1).unwrap_or(0)
                                ..this.text[cursor..]
                                    .find('\n')
                                    .map(|i| cursor + i + 1)
                                    .unwrap_or(this.text.len()),
                        ),
                        _ => None,
                    };
                    if let Some(range) = range {
                        this.anchor = range.start;
                        this.selection = range;
                        this.changed(cx);
                    } else {
                        this.move_to(cursor, event.modifiers.shift, cx);
                    }
                }),
            )
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                if this.selecting
                    && this.focus.is_focused(window)
                    && event.pressed_button == Some(MouseButton::Left)
                {
                    this.move_to(this.index_at(event.position), true, cx);
                } else {
                    this.selecting = false;
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.selecting = false),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.selecting = false),
            )
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
                                let (text, marked, selection, cursor, focus) = {
                                    let i = input.read(cx);
                                    (
                                        i.text.clone(),
                                        i.marked.clone(),
                                        i.selection.clone(),
                                        i.cursor(),
                                        i.focus.clone(),
                                    )
                                };
                                window.handle_input(
                                    &focus,
                                    ElementInputHandler::new(bounds, input.clone()),
                                    cx,
                                );
                                let style = window.text_style();
                                let mut offset = 0;
                                let mut y = bounds.top();
                                let mut layouts = vec![];
                                // Hard lines retain their byte offsets; wrapped positions stay native.
                                let display_text = text.as_str();
                                for part in display_text.split('\n') {
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
                                                color: if text.is_empty() {
                                                    theme().text_muted.into()
                                                } else {
                                                    style.color
                                                },
                                                background_color: (!text.is_empty()
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
                                        });
                                    }
                                    offset += part.len() + 1;
                                }
                                input.update(cx, |input, cx| {
                                    let height = (y - bounds.top()).max(px(19.));
                                    if input.height != height {
                                        input.height = height;
                                        cx.notify();
                                    }
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
                                            input.scroll.set_offset(point(next_x, next));
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
    }
}
