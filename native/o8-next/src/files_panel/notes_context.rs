//! Ordinary text editing menu using the Files editor's existing keyboard actions.
use super::super::spec::controls::control;
use super::*;
impl Editor {
    pub(super) fn text_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let at = self.rail.context?;
        Some(
            deferred(
                anchored()
                    .position(at)
                    .snap_to_window_with_margin(px(10.))
                    .child(
                        div()
                            .id("notes-text-menu")
                            .debug_selector(|| "notes-text-menu".into())
                            .w(px(170.))
                            .p(px(5.))
                            .rounded(px(10.))
                            .bg(theme().surface_raised)
                            .border_1()
                            .border_color(theme().border)
                            .shadow_md()
                            .occlude()
                            .flex()
                            .flex_col()
                            .on_mouse_down_out(cx.listener(|this, _, window, cx| {
                                this.rail.context = None;
                                this.focus.focus(window);
                                cx.notify();
                            }))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|_, _, _, cx| cx.stop_propagation()),
                            )
                            .children(
                                [
                                    ("undo", "Undo", "z"),
                                    ("redo", "Redo", "shift-z"),
                                    ("cut", "Cut", "x"),
                                    ("copy", "Copy", "c"),
                                    ("paste", "Paste", "v"),
                                    ("select-all", "Select All", "a"),
                                ]
                                .into_iter()
                                .map(|(id, label, key)| {
                                    control(
                                        format!("notes-text-{id}"),
                                        label,
                                        cx,
                                        move |this, window, cx| {
                                            this.rail.context = None;
                                            this.focus.focus(window);
                                            let key = Keystroke::parse(&format!(
                                                "{}-{key}",
                                                if cfg!(target_os = "macos") {
                                                    "cmd"
                                                } else {
                                                    "ctrl"
                                                }
                                            ))
                                            .unwrap();
                                            this.edit_key(&key, window, cx);
                                            cx.notify();
                                        },
                                    )
                                    .justify_start()
                                    .min_h(px(28.))
                                }),
                            ),
                    ),
            )
            .with_priority(3)
            .into_any_element(),
        )
    }
}
