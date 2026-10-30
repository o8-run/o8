//! Native equivalents of the classic buttons, including pointer/keyboard focus.
use crate::theme::current as theme;
use gpui::{prelude::*, *};
use std::rc::Rc;
pub(in crate::files_panel) fn control<T: 'static>(
    id: impl Into<SharedString>,
    label: &str,
    cx: &mut Context<T>,
    action: impl Fn(&mut T, &mut Window, &mut Context<T>) + 'static,
) -> Stateful<Div> {
    let id = id.into();
    let debug = id.clone();
    let action = Rc::new(action);
    let keys = action.clone();
    div()
        .id(ElementId::Name(id))
        .debug_selector(move || debug.to_string())
        .focusable()
        .tab_stop(true)
        .min_h(px(24.))
        .px(px(8.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(7.))
        .text_size(px(11.))
        .font_weight(FontWeight::LIGHT)
        .text_color(theme().text_muted)
        .cursor_pointer()
        .hover(|d| d.bg(theme().hover))
        .active(|d| d.bg(theme().selection))
        .focus(|d| d.border_1().border_color(theme().accent))
        .child(label.to_owned())
        .on_click(cx.listener(move |this, _, window, cx| action(this, window, cx)))
        .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                keys(this, window, cx);
                cx.stop_propagation();
            }
        }))
}
pub(super) fn focused<T: 'static>(
    id: impl Into<SharedString>,
    label: &str,
    focus: FocusHandle,
    cx: &mut Context<T>,
    action: impl Fn(&mut T, &mut Window, &mut Context<T>) + 'static,
) -> Stateful<Div> {
    let id = id.into();
    let debug = id.clone();
    let action = Rc::new(action);
    let keys = action.clone();
    let mouse = focus.clone();
    div()
        .id(ElementId::Name(id))
        .debug_selector(move || debug.to_string())
        .track_focus(&focus)
        .tab_stop(true)
        .min_h(px(24.))
        .px(px(8.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(7.))
        .text_size(px(11.))
        .font_weight(FontWeight::LIGHT)
        .text_color(theme().text_muted)
        .cursor_pointer()
        .hover(|d| d.bg(theme().hover))
        .active(|d| d.bg(theme().selection))
        .focus(|d| d.border_1().border_color(theme().accent))
        .child(label.to_owned())
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |_, _, window, cx| {
                mouse.focus(window);
                cx.stop_propagation();
            }),
        )
        .on_click(cx.listener(move |this, _, window, cx| action(this, window, cx)))
        .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                keys(this, window, cx);
                cx.stop_propagation();
            }
        }))
}
