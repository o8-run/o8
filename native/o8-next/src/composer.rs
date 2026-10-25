//! Original Apache-2.0 editor using only GPUI's platform input contract.
use crate::theme::current as theme;
use gpui::{prelude::*, *};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone)]
struct Snapshot {
    text: String,
    selection: Range<usize>,
}
pub struct Submit(pub bool);
impl EventEmitter<Submit> for Composer {}
pub struct Composer {
    pub focus: FocusHandle,
    pub context: &'static str,
    pub text: String,
    selection: Range<usize>,
    anchor: usize,
    marked: Option<Range<usize>>,
    composition: Option<Snapshot>,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    layout: Vec<(usize, WrappedLine, Point<Pixels>)>,
    selecting: bool,
    pub revision: u64,
    pub painted: u64,
    height: Pixels,
    scroll: ScrollHandle,
    reveal_cursor: bool,
}
impl Composer {
    pub fn new(cx: &mut Context<Self>) -> Self {
        crate::keymap::install(cx);
        Self {
            context: "TextInput",
            focus: cx.focus_handle(),
            text: String::new(),
            selection: 0..0,
            anchor: 0,
            marked: None,
            composition: None,
            undo: vec![],
            redo: vec![],
            layout: vec![],
            selecting: false,
            revision: 0,
            painted: 0,
            height: px(crate::theme::TYPE.body_line),
            scroll: ScrollHandle::new(),
            reveal_cursor: true,
        }
    }
    pub fn composing(&self) -> bool {
        self.marked.is_some()
    }
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            text: self.text.clone(),
            selection: self.selection.clone(),
        }
    }
    fn restore(&mut self, snapshot: Snapshot, cx: &mut Context<Self>) {
        self.text = snapshot.text;
        self.selection = snapshot.selection;
        self.anchor = self.selection.start;
        self.marked = None;
        self.composition = None;
        self.changed(cx);
    }
    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.text.clear();
        self.selection = 0..0;
        self.anchor = 0;
        self.undo.clear();
        self.redo.clear();
        self.marked = None;
        self.composition = None;
        self.changed(cx);
    }
    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.undo.push(self.snapshot());
        self.redo.clear();
        self.text = text.to_owned();
        self.selection = self.text.len()..self.text.len();
        self.anchor = self.text.len();
        self.marked = None;
        self.composition = None;
        self.changed(cx);
    }
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.revision += 1;
        self.reveal_cursor = true;
        cx.notify();
    }
    fn byte(text: &str, utf16: usize) -> usize {
        let mut units = 0;
        for (index, ch) in text.char_indices() {
            if units >= utf16 {
                return index;
            }
            units += ch.len_utf16();
        }
        text.len()
    }
    fn utf16(&self, bytes: usize) -> usize {
        self.text[..bytes].encode_utf16().count()
    }
    fn range(&self, range: Range<usize>) -> Range<usize> {
        Self::byte(&self.text, range.start)..Self::byte(&self.text, range.end.max(range.start))
    }
    fn replace(&mut self, range: Range<usize>, text: &str) {
        self.text.replace_range(range.clone(), text);
        let cursor = range.start + text.len();
        self.selection = cursor..cursor;
        self.anchor = cursor;
    }
    fn move_to(&mut self, cursor: usize, shift: bool, cx: &mut Context<Self>) {
        if !shift {
            self.anchor = cursor;
        }
        self.selection = self.anchor.min(cursor)..self.anchor.max(cursor);
        self.changed(cx);
    }
    fn cursor(&self) -> usize {
        if self.anchor == self.selection.end {
            self.selection.start
        } else {
            self.selection.end
        }
    }
    fn previous(&self, cursor: usize) -> usize {
        self.text[..cursor]
            .grapheme_indices(true)
            .next_back()
            .map(|(i, _)| i)
            .unwrap_or(0)
    }
    fn next(&self, cursor: usize) -> usize {
        cursor
            + self.text[cursor..]
                .graphemes(true)
                .next()
                .map(str::len)
                .unwrap_or(0)
    }
    fn index_at(&self, point: Point<Pixels>) -> usize {
        for (offset, line, origin) in &self.layout {
            let height = px(crate::theme::TYPE.body_line)
                * line.wrap_boundaries.len().saturating_add(1) as f32;
            if point.y < origin.y + height {
                return (offset
                    + line
                        .closest_index_for_position(
                            point - *origin,
                            px(crate::theme::TYPE.body_line),
                        )
                        .unwrap_or_else(|i| i))
                .min(offset + line.len())
                .min(self.text.len());
            }
        }
        self.text.len()
    }
    pub(crate) fn action(
        &mut self,
        action: &crate::keymap::Shortcut,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        use crate::keymap::{Edit, Shortcut};
        if self.composing() && matches!(action, Shortcut::Edit { .. } | Shortcut::IssueRemoveLabel)
        {
            return;
        }
        let Shortcut::Edit {
            operation,
            select,
            boundary,
        } = *action
        else {
            cx.propagate();
            return;
        };
        let mac_command = boundary;
        let cursor = self.cursor();
        let line_start = self.text[..cursor].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let line_end = self.text[cursor..]
            .find('\n')
            .map(|i| cursor + i)
            .unwrap_or(self.text.len());
        match operation {
            Edit::Steer => cx.emit(Submit(true)),
            Edit::Submit => cx.emit(Submit(false)),
            Edit::Newline => self.replace_text_in_range(None, "\n", window, cx),
            Edit::SelectAll => {
                self.anchor = 0;
                self.selection = 0..self.text.len();
                self.changed(cx);
            }
            Edit::Copy | Edit::Cut => {
                cx.write_to_clipboard(ClipboardItem::new_string(
                    self.text[self.selection.clone()].into(),
                ));
                if operation == Edit::Cut {
                    self.replace_text_in_range(None, "", window, cx);
                }
            }
            Edit::Paste => {
                if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                    self.replace_text_in_range(
                        None,
                        &text.replace("\r\n", "\n").replace('\r', "\n"),
                        window,
                        cx,
                    );
                }
            }
            Edit::Undo | Edit::Redo => {
                let redo = operation == Edit::Redo;
                let snapshot = if redo {
                    self.redo.pop()
                } else {
                    self.undo.pop()
                };
                if let Some(snapshot) = snapshot {
                    let current = self.snapshot();
                    if redo {
                        self.undo.push(current);
                    } else {
                        self.redo.push(current);
                    }
                    self.restore(snapshot, cx);
                }
            }
            Edit::Left => self.move_to(
                if mac_command {
                    line_start
                } else if !select && !self.selection.is_empty() {
                    self.selection.start
                } else {
                    self.previous(cursor)
                },
                select,
                cx,
            ),
            Edit::Right => self.move_to(
                if mac_command {
                    line_end
                } else if !select && !self.selection.is_empty() {
                    self.selection.end
                } else {
                    self.next(cursor)
                },
                select,
                cx,
            ),
            Edit::Up | Edit::Down if mac_command => self.move_to(
                if operation == Edit::Up {
                    0
                } else {
                    self.text.len()
                },
                select,
                cx,
            ),
            Edit::Up | Edit::Down => {
                let position = self.layout.iter().find_map(|(offset, line, origin)| {
                    (cursor >= *offset && cursor <= offset + line.len())
                        .then(|| {
                            line.position_for_index(
                                cursor - offset,
                                px(crate::theme::TYPE.body_line),
                            )
                        })
                        .flatten()
                        .map(|p| *origin + p)
                });
                if let Some(position) = position {
                    let next = self.index_at(
                        position + point(px(0.), px(if operation == Edit::Up { -1. } else { 21. })),
                    );
                    self.move_to(next, select, cx);
                }
            }
            Edit::Home => self.move_to(if boundary { 0 } else { line_start }, select, cx),
            Edit::End => self.move_to(
                if boundary { self.text.len() } else { line_end },
                select,
                cx,
            ),
            Edit::Backspace | Edit::Delete => {
                if self.selection.is_empty() {
                    self.selection = if operation == Edit::Backspace {
                        (if mac_command {
                            line_start
                        } else {
                            self.previous(cursor)
                        })..cursor
                    } else {
                        cursor..(if mac_command {
                            line_end
                        } else {
                            self.next(cursor)
                        })
                    };
                }
                self.replace_text_in_range(None, "", window, cx);
            }
        }
        cx.stop_propagation();
    }
}
impl EntityInputHandler for Composer {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range(range);
        *adjusted = Some(self.utf16(range.start)..self.utf16(range.end));
        Some(self.text[range].into())
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.utf16(self.selection.start)..self.utf16(self.selection.end),
            reversed: self.anchor == self.selection.end,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked
            .as_ref()
            .map(|r| self.utf16(r.start)..self.utf16(r.end))
    }
    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(snapshot) = self.composition.take() {
            self.undo.push(snapshot);
            self.redo.clear();
        }
        self.marked = None;
        self.changed(cx);
    }
    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .map(|r| self.range(r))
            .or(self.marked.clone())
            .unwrap_or(self.selection.clone());
        let snapshot = self.composition.take().unwrap_or_else(|| self.snapshot());
        self.undo.push(snapshot);
        self.redo.clear();
        self.replace(range, text);
        self.marked = None;
        self.changed(cx);
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.composition.is_none() {
            self.composition = Some(self.snapshot());
        }
        let range = range
            .map(|r| self.range(r))
            .or(self.marked.clone())
            .unwrap_or(self.selection.clone());
        let start = range.start;
        self.replace(range, text);
        self.marked = Some(start..start + text.len());
        if let Some(range) = selected {
            self.selection =
                start + Self::byte(text, range.start)..start + Self::byte(text, range.end);
            self.anchor = self.selection.start;
        }
        self.changed(cx);
    }
    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let index = self.range(range).start;
        self.layout.iter().find_map(|(offset, line, origin)| {
            (index >= *offset && index <= offset + line.len())
                .then(|| line.position_for_index(index - offset, px(crate::theme::TYPE.body_line)))
                .flatten()
                .map(|position| {
                    Bounds::new(
                        *origin + position,
                        size(px(1.), px(crate::theme::TYPE.body_line)),
                    )
                })
        })
    }
    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.utf16(self.index_at(point)))
    }
}
impl Render for Composer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let input = cx.entity();
        let height = self.height;
        div()
            .id("composer-input")
            .debug_selector(|| "composer-input".into())
            .track_focus(&self.focus)
            .key_context(self.context)
            .cursor(CursorStyle::IBeam)
            .max_h(px(176.))
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .border_1()
            .border_color(theme().border)
            .rounded(px(crate::theme::GEOMETRY.row_radius))
            .p(px(8.))
            .on_action(cx.listener(Self::action))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    this.focus.focus(window);
                    this.selecting = true;
                    this.move_to(this.index_at(event.position), event.modifiers.shift, cx);
                }),
            )
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                if this.selecting {
                    this.move_to(this.index_at(event.position), true, cx);
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
                        for part in text.split('\n') {
                            let display: SharedString = if part.is_empty() {
                                " ".into()
                            } else {
                                part.to_owned().into()
                            };
                            let run = TextRun {
                                len: display.len(),
                                font: style.font(),
                                color: style.color,
                                background_color: None,
                                underline: None,
                                strikethrough: None,
                            };
                            let lines = window
                                .text_system()
                                .shape_text(
                                    display,
                                    px(crate::theme::TYPE.body),
                                    &[run],
                                    Some(bounds.size.width),
                                    None,
                                )
                                .expect("shape input");
                            for line in lines {
                                let origin = point(bounds.left(), y);
                                let end = offset + part.len();
                                for index in part.char_indices().map(|(i, _)| offset + i) {
                                    if selection.contains(&index)
                                        || marked.as_ref().is_some_and(|r| r.contains(&index))
                                    {
                                        if let Some(position) = line.position_for_index(
                                            index - offset,
                                            px(crate::theme::TYPE.body_line),
                                        ) {
                                            let next = text[index..]
                                                .chars()
                                                .next()
                                                .map(char::len_utf8)
                                                .unwrap_or(0);
                                            let right = line
                                                .position_for_index(
                                                    index + next - offset,
                                                    px(crate::theme::TYPE.body_line),
                                                )
                                                .unwrap_or(position + point(px(8.), px(0.)));
                                            window.paint_quad(fill(
                                                Bounds::new(
                                                    origin + position,
                                                    size(
                                                        (right.x - position.x).max(px(2.)),
                                                        px(crate::theme::TYPE.body_line),
                                                    ),
                                                ),
                                                theme().selection,
                                            ));
                                        }
                                    }
                                }
                                line.paint(
                                    origin,
                                    px(crate::theme::TYPE.body_line),
                                    TextAlign::Left,
                                    Some(bounds),
                                    window,
                                    cx,
                                )
                                .expect("paint input");
                                if focus.is_focused(window) && cursor >= offset && cursor <= end {
                                    if let Some(position) = line.position_for_index(
                                        cursor - offset,
                                        px(crate::theme::TYPE.body_line),
                                    ) {
                                        window.paint_quad(fill(
                                            Bounds::new(
                                                origin + position,
                                                size(px(1.), px(crate::theme::TYPE.body_line)),
                                            ),
                                            theme().accent,
                                        ));
                                    }
                                }
                                y += px(crate::theme::TYPE.body_line)
                                    * (line.wrap_boundaries.len() + 1) as f32;
                                layouts.push((offset, line, origin));
                            }
                            offset += part.len() + 1;
                        }
                        input.update(cx, |input, cx| {
                            let height = (y - bounds.top()).max(px(crate::theme::TYPE.body_line));
                            if input.height != height {
                                input.height = height;
                                cx.notify();
                            }
                            if input.reveal_cursor {
                                if let Some(position) =
                                    layouts.iter().find_map(|(offset, line, origin)| {
                                        (cursor >= *offset && cursor <= offset + line.len())
                                            .then(|| {
                                                line.position_for_index(
                                                    cursor - offset,
                                                    px(crate::theme::TYPE.body_line),
                                                )
                                            })
                                            .flatten()
                                            .map(|p| *origin + p)
                                    })
                                {
                                    let scroll = input.scroll.offset();
                                    let cursor_y = position.y - bounds.top();
                                    let top = -scroll.y;
                                    // The viewport excludes the input's padding and border.
                                    let visible = height.min(px(158.));
                                    let bottom = top + visible;
                                    let next = if cursor_y < top {
                                        -cursor_y
                                    } else if cursor_y + px(crate::theme::TYPE.body_line) > bottom {
                                        visible - px(crate::theme::TYPE.body_line) - cursor_y
                                    } else {
                                        scroll.y
                                    };
                                    input.scroll.set_offset(point(px(0.), next));
                                }
                                input.reveal_cursor = false;
                            }
                            input.layout = layouts;
                            input.painted = input.revision;
                        });
                    },
                )
                .w_full()
                .h(height)
                .flex_shrink_0(),
            )
    }
}

#[cfg(test)]
#[path = "input_tests.rs"]
mod tests;
