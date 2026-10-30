//! Shared native input events for the Files textarea and notes document.
use super::*;
impl Editor {
    pub(super) fn base(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        div()
            .id(if self.notes {
                "spec-editor"
            } else {
                "files-editor"
            })
            .debug_selector({
                let notes = self.notes;
                move || {
                    if notes {
                        "spec-editor".into()
                    } else {
                        "files-editor".into()
                    }
                }
            })
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
    }
}
