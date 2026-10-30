//! File textarea input, ported from the native composer's GPUI input contract.
use crate::theme::current as theme;
use gpui::{prelude::*, *};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

#[path = "editor_view.rs"]
mod view;

#[derive(Clone)]
struct Snapshot {
    text: String,
    selection: Range<usize>,
    anchor: usize,
}
struct EditorLine {
    start: usize,
    len: usize,
    tabs: Vec<usize>,
    line: WrappedLine,
    origin: Point<Pixels>,
}
impl EditorLine {
    fn display_index(&self, index: usize) -> usize {
        index + self.tabs.partition_point(|tab| *tab < index)
    }
    fn raw_index(&self, index: usize) -> usize {
        index
            .saturating_sub(
                self.tabs
                    .iter()
                    .enumerate()
                    .filter(|(n, tab)| index > **tab + *n)
                    .count(),
            )
            .min(self.len)
    }
    fn position(&self, index: usize) -> Option<Point<Pixels>> {
        self.line
            .position_for_index(self.display_index(index), px(19.))
    }
}
pub struct Editor {
    pub focus: FocusHandle,
    pub context: &'static str,
    pub text: String,
    selection: Range<usize>,
    anchor: usize,
    marked: Option<Range<usize>>,
    composition: Option<Snapshot>,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    layout: Vec<EditorLine>,
    selecting: bool,
    pub revision: u64,
    height: Pixels,
    scroll: ScrollHandle,
    reveal_cursor: bool,
    typing: Option<std::time::Instant>,
}
impl Editor {
    pub fn new(text: &str, cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            context: "FilesEditor",
            text: text.to_owned(),
            selection: 0..0,
            anchor: 0,
            marked: None,
            composition: None,
            undo: vec![],
            redo: vec![],
            layout: vec![],
            selecting: false,
            revision: 0,
            height: px(19.),
            scroll: ScrollHandle::new(),
            reveal_cursor: true,
            typing: None,
        }
    }
    pub(crate) fn select_all(&mut self, cx: &mut Context<Self>) {
        self.anchor = 0;
        self.selection = 0..self.text.len();
        self.changed(cx);
    }
    pub fn composing(&self) -> bool {
        self.marked.is_some()
    }
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            text: self.text.clone(),
            selection: self.selection.clone(),
            anchor: self.anchor,
        }
    }
    fn restore(&mut self, snapshot: Snapshot, cx: &mut Context<Self>) {
        self.text = snapshot.text;
        self.selection = snapshot.selection;
        self.anchor = snapshot.anchor;
        self.marked = None;
        self.composition = None;
        self.typing = None;
        self.changed(cx);
    }
    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.typing = None;
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
        self.typing = None;
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
    fn previous_word(&self, cursor: usize) -> usize {
        self.text[..cursor]
            .unicode_word_indices()
            .next_back()
            .map(|(i, _)| i)
            .unwrap_or(0)
    }
    fn next_word(&self, cursor: usize) -> usize {
        self.text[cursor..]
            .unicode_word_indices()
            .next()
            .map(|(i, word)| cursor + i + word.len())
            .unwrap_or(self.text.len())
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
        for row in &self.layout {
            if point.y < row.origin.y + px(19.) {
                let index = row
                    .line
                    .closest_index_for_position(point - row.origin, px(19.))
                    .unwrap_or_else(|i| i);
                return (row.start + row.raw_index(index)).min(self.text.len());
            }
        }
        self.text.len()
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.edit_key(&event.keystroke, window, cx);
    }
    fn edit_key(&mut self, key: &Keystroke, window: &mut Window, cx: &mut Context<Self>) {
        // IME owns confirmation, arrows and deletion while a marked range exists.
        if self.composing() {
            cx.stop_propagation();
            return;
        }
        let command = key.modifiers.control || key.modifiers.platform;
        if command || key.key.chars().count() != 1 {
            self.typing = None;
        }
        let mac_command = cfg!(target_os = "macos") && key.modifiers.platform;
        let word = if cfg!(target_os = "macos") {
            key.modifiers.alt
        } else {
            key.modifiers.control
        };
        let cursor = self.cursor();
        let line_start = self.text[..cursor].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let line_end = self.text[cursor..]
            .find('\n')
            .map(|i| cursor + i)
            .unwrap_or(self.text.len());
        match key.key.as_str() {
            "tab" => self.replace_text_in_range(None, "  ", window, cx),
            "enter" => self.replace_text_in_range(None, "\n", window, cx),
            "a" if command => {
                self.anchor = 0;
                self.selection = 0..self.text.len();
                self.changed(cx);
            }
            "c" | "x" if command => {
                if self.selection.is_empty() {
                    cx.stop_propagation();
                    return;
                }
                cx.write_to_clipboard(ClipboardItem::new_string(
                    self.text[self.selection.clone()].into(),
                ));
                if key.key == "x" {
                    self.replace_text_in_range(None, "", window, cx);
                }
            }
            "v" if command => {
                let item = cx.read_from_clipboard();
                if let Some(text) = item.and_then(|item| item.text()) {
                    self.replace_text_in_range(
                        None,
                        &text.replace("\r\n", "\n").replace('\r', "\n"),
                        window,
                        cx,
                    );
                }
            }
            "z" | "y" if command => {
                let redo = key.modifiers.shift || key.key == "y";
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
            "left" => self.move_to(
                if mac_command {
                    line_start
                } else if word {
                    self.previous_word(cursor)
                } else if !key.modifiers.shift && !self.selection.is_empty() {
                    self.selection.start
                } else {
                    self.previous(cursor)
                },
                key.modifiers.shift,
                cx,
            ),
            "right" => self.move_to(
                if mac_command {
                    line_end
                } else if word {
                    self.next_word(cursor)
                } else if !key.modifiers.shift && !self.selection.is_empty() {
                    self.selection.end
                } else {
                    self.next(cursor)
                },
                key.modifiers.shift,
                cx,
            ),
            "up" | "down" if mac_command => self.move_to(
                if key.key == "up" { 0 } else { self.text.len() },
                key.modifiers.shift,
                cx,
            ),
            "up" | "down" => {
                let position = self.layout.iter().find_map(|row| {
                    (cursor >= row.start && cursor <= row.start + row.len)
                        .then(|| row.position(cursor - row.start))
                        .flatten()
                        .map(|p| row.origin + p)
                });
                if let Some(position) = position {
                    let next = self.index_at(
                        position + point(px(0.), px(if key.key == "up" { -1. } else { 21. })),
                    );
                    self.move_to(next, key.modifiers.shift, cx);
                }
            }
            "home" => self.move_to(
                if command { 0 } else { line_start },
                key.modifiers.shift,
                cx,
            ),
            "end" => self.move_to(
                if command { self.text.len() } else { line_end },
                key.modifiers.shift,
                cx,
            ),
            "backspace" | "delete" => {
                if self.selection.is_empty() {
                    self.selection = if key.key == "backspace" {
                        (if mac_command {
                            line_start
                        } else if word {
                            self.previous_word(cursor)
                        } else {
                            self.previous(cursor)
                        })..cursor
                    } else {
                        cursor..(if mac_command {
                            line_end
                        } else if word {
                            self.next_word(cursor)
                        } else {
                            self.next(cursor)
                        })
                    };
                }
                self.replace_text_in_range(None, "", window, cx);
            }
            _ => return,
        }
        cx.stop_propagation();
    }
}
impl EntityInputHandler for Editor {
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
        let typing = self.marked.is_none() && text.chars().count() == 1 && text != "\n";
        let coalesce = range.is_empty()
            && typing
            && self
                .typing
                .is_some_and(|last| last.elapsed().as_secs_f32() < 1.);
        if !coalesce {
            let snapshot = self.composition.take().unwrap_or_else(|| self.snapshot());
            self.undo.push(snapshot);
        }
        self.typing = typing.then(std::time::Instant::now);
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
        self.typing = None;
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
        let range = self.range(range);
        let index = range.start;
        self.layout.iter().find_map(|row| {
            if index < row.start || index > row.start + row.len {
                return None;
            }
            let start = row.position(index - row.start)?;
            let end = row.position(range.end.min(row.start + row.len) - row.start)?;
            Some(Bounds::new(
                row.origin + point(start.x.min(end.x), start.y),
                size((end.x - start.x).abs().max(px(1.)), px(19.)),
            ))
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
