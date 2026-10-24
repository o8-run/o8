//! The desktop bindings currently reachable in the opt-in native shell.
use super::*;
use crate::theme::current as theme;

const ROWS: &[(&str, &str, &str)] = &[
    ("Navigation", "Command palette", "⌘ K"),
    ("Navigation", "Cycle tabs", "⌘ ⌥ ← / ⌘ ⌥ →"),
    ("Navigation", "Jump to tab 1–9", "⌘ 1–9"),
    ("Tabs", "Close active tab", "⌘ W"),
    ("General", "Show this help", "⌘ / · ?"),
    ("General", "Dismiss / close", "Esc"),
];

impl Shell {
    pub(super) fn set_help(&mut self, open: bool, window: &mut Window, cx: &mut Context<Self>) {
        if open == self.help {
            return;
        }
        if open {
            self.capture(window, cx);
            self.help_return = window.focused(cx);
            self.help_close_focus.focus(window);
        } else if let Some(focus) = self.help_return.take() {
            focus.focus(window);
        } else {
            self.restore_focus(window, cx);
        }
        self.help = open;
        self.revision += 1;
        cx.notify();
    }
    pub(super) fn shortcuts(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("shortcuts-backdrop")
            .absolute()
            .inset_0()
            .size_full()
            .p(px(24.))
            .flex()
            .items_center()
            .justify_center()
            .bg(theme().surface)
            .on_click(cx.listener(|this, _, window, cx| this.set_help(false, window, cx)))
            .child(
                div()
                    .id("keyboard-shortcuts")
                    .debug_selector(|| "keyboard-shortcuts".into())
                    .w_full()
                    .max_w(px(520.))
                    .h_full()
                    .max_h(px(520.))
                    .flex()
                    .flex_col()
                    .min_h_0()
                    .rounded(px(12.))
                    .border_1()
                    .border_color(theme().border)
                    .bg(theme().background)
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .p(px(12.))
                            .child("Keyboard shortcuts")
                            .child(
                                div()
                                    .id("shortcuts-close")
                                    .debug_selector(|| "shortcuts-close".into())
                                    .track_focus(&self.help_close_focus)
                                    .p(px(8.))
                                    .cursor_pointer()
                                    .child("Close")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.set_help(false, window, cx);
                                        cx.stop_propagation();
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .id("shortcuts-list")
                            .debug_selector(|| "shortcuts-list".into())
                            .track_focus(&self.help_list_focus)
                            .track_scroll(&self.help_scroll)
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .p(px(12.))
                            .on_mouse_down(
                                gpui::MouseButton::Left,
                                cx.listener(|this, _, window, _| {
                                    this.help_list_focus.focus(window)
                                }),
                            )
                            .children(["Navigation", "Tabs", "General"].into_iter().map(
                                |section| {
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap(px(10.))
                                        .pb(px(16.))
                                        .child(
                                            div().text_color(theme().text_secondary).child(section),
                                        )
                                        .children(
                                            ROWS.iter().filter(move |(s, _, _)| *s == section).map(
                                                |(_, label, chord)| {
                                                    div()
                                                        .flex()
                                                        .justify_between()
                                                        .gap(px(12.))
                                                        .child(*label)
                                                        .child(
                                                            div()
                                                                .font_family(theme().font_mono)
                                                                .text_color(theme().text_secondary)
                                                                .child(*chord),
                                                        )
                                                },
                                            ),
                                        )
                                },
                            )),
                    ),
            )
    }
}
