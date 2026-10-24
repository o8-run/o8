//! Write-only credential input. No copy, undo, text readback or persistence.
use crate::{composer::Submit, theme::current as theme};
use gpui::{
    Bounds, Context, ElementInputHandler, EntityInputHandler, EventEmitter, FocusHandle,
    KeyDownEvent, Render, UTF16Selection, Window, canvas, div, prelude::*, px,
};
use std::ops::Range;

pub struct Secret {
    pub focus: FocusHandle,
    text: String,
    all: bool,
}
impl Secret {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            text: String::new(),
            all: false,
        }
    }
    pub fn take(&mut self, cx: &mut Context<Self>) -> String {
        self.all = false;
        cx.notify();
        std::mem::take(&mut self.text)
    }
    fn key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let command = event.keystroke.modifiers.control || event.keystroke.modifiers.platform;
        match event.keystroke.key.as_str() {
            "enter" => cx.emit(Submit(false)),
            "a" if command => self.all = true,
            "c" | "z" if command => {}
            "x" if command => {
                self.text.clear();
                self.all = false;
            }
            "v" if command => {
                if let Some(text) = cx.read_from_clipboard().and_then(|v| v.text()) {
                    if self.all {
                        self.text.clear();
                    }
                    self.text.push_str(&text);
                    self.all = false;
                }
            }
            "backspace" | "delete" => {
                if self.all {
                    self.text.clear();
                } else {
                    self.text.pop();
                }
                self.all = false;
            }
            _ => return,
        }
        cx.notify();
        cx.stop_propagation();
    }
}
impl EventEmitter<Submit> for Secret {}
impl EntityInputHandler for Secret {
    fn text_for_range(
        &mut self,
        _: Range<usize>,
        _: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        None
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let end = self.text.encode_utf16().count();
        Some(UTF16Selection {
            range: if self.all { 0..end } else { end..end },
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        None
    }
    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {}
    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.all {
            self.text.clear();
        }
        if let Some(range) = range {
            let byte = |units| {
                self.text
                    .char_indices()
                    .scan(0, |count, (index, ch)| {
                        let before = *count;
                        *count += ch.len_utf16();
                        Some((before, index))
                    })
                    .find(|(before, _)| *before >= units)
                    .map(|(_, index)| index)
                    .unwrap_or(self.text.len())
            };
            let start = byte(range.start);
            let end = byte(range.end);
            self.text.replace_range(start..end, text);
        } else {
            self.text.push_str(text);
        }
        self.all = false;
        cx.notify();
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.replace_text_in_range(range, text, window, cx);
    }
    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        bounds: Bounds<gpui::Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<gpui::Pixels>> {
        Some(bounds)
    }
    fn character_index_for_point(
        &mut self,
        _: gpui::Point<gpui::Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(self.text.encode_utf16().count())
    }
}
impl Render for Secret {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let input = cx.entity();
        let empty = self.text.is_empty();
        div()
            .id("settings-secret")
            .track_focus(&self.focus)
            .p(px(8.))
            .rounded(px(8.))
            .border_1()
            .border_color(if self.focus.is_focused(window) {
                theme().accent
            } else {
                theme().border
            })
            .on_key_down(cx.listener(Self::key))
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    this.focus.focus(window);
                    cx.stop_propagation();
                }),
            )
            .child(
                div()
                    .debug_selector(move || {
                        if empty {
                            "settings-secret-empty".into()
                        } else {
                            "settings-secret-masked".into()
                        }
                    })
                    .child(if empty {
                        "Enter a new key"
                    } else {
                        "••••••••"
                    }),
            )
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, cx| {
                        let focus = input.read(cx).focus.clone();
                        window.handle_input(
                            &focus,
                            ElementInputHandler::new(bounds, input.clone()),
                            cx,
                        );
                    },
                )
                .w_full()
                .h(px(1.)),
            )
    }
}
