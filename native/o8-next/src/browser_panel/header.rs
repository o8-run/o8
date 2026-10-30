//! Browser-only header controls from PanelHeaderStrip and O8HeaderTabs.
use super::*;

pub(crate) const MORE: &str = "M5 12h.001 M12 12h.001 M19 12h.001";

fn key_activation<V: 'static>(
    element: Stateful<Div>,
    action: impl Fn(&mut V, &mut Window, &mut Context<V>) + 'static,
    cx: &Context<V>,
) -> Stateful<Div> {
    element.focusable().tab_stop(true).on_key_down(cx.listener(
        move |this, event: &gpui::KeyDownEvent, window, cx| {
            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                action(this, window, cx);
                cx.stop_propagation();
            }
        },
    ))
}

pub(crate) fn launcher<V: 'static>(
    action: fn(&mut V, &mut Window, &mut Context<V>),
    cx: &Context<V>,
) -> Stateful<Div> {
    let button = div()
        .id("browser-open-launcher")
        .debug_selector(|| "browser-open-launcher".into())
        .size(px(28.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(7.))
        .cursor_pointer()
        .hover(|b| b.bg(theme().hover))
        .active(|b| b.bg(theme().selection))
        .focus(|b| b.bg(theme().selection))
        .tooltip(|_, cx| {
            cx.new(|_| crate::icon::Tip("Open right panel tab picker".into()))
                .into()
        })
        .child(crate::icon::stroke(
            "M12 5v14 M5 12h14",
            theme().text_muted,
            14.,
            2.,
        ));
    key_activation(button, action, cx)
        .on_click(cx.listener(move |this, _, window, cx| action(this, window, cx)))
}

pub(crate) fn more<V: 'static>(
    button: Stateful<Div>,
    action: fn(&mut V, &mut Window, &mut Context<V>),
    cx: &Context<V>,
) -> Stateful<Div> {
    key_activation(button.size(px(28.)).px_0(), action, cx)
}

pub(crate) fn new_page_item<V: 'static>(
    browser: Entity<BrowserPanel>,
    close: fn(&mut V, &mut Context<V>),
    cx: &Context<V>,
) -> AnyElement {
    let action = move |this: &mut V, window: &mut Window, cx: &mut Context<V>| {
        close(this, cx);
        browser.update(cx, |browser, cx| browser.new_page(window, cx));
        cx.notify();
    };
    let click = action.clone();
    let row = div()
        .id("browser-menu-new-page")
        .debug_selector(|| "browser-menu-new-page".into())
        .h(px(30.))
        .px(px(8.))
        .flex()
        .items_center()
        .gap(px(10.))
        .rounded(px(6.))
        .text_size(px(12.5))
        .text_color(theme().text)
        .cursor_pointer()
        .hover(|row| row.bg(theme().hover))
        .child(crate::icon::stroke(
            view::GLOBE,
            theme().text_secondary,
            15.,
            1.6,
        ))
        .child("New browser page");
    key_activation(row, action, cx)
        .on_click(cx.listener(move |this, _, window, cx| click(this, window, cx)))
        .into_any_element()
}
