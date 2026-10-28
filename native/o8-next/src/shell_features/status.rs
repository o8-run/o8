use super::*;
struct Status;
register_shell_feature!(Status);
impl ShellFeature for Status {
    fn slots(&self) -> &'static [RenderSlot] {
        &[
            RenderSlot {
                group: RenderGroup::Chrome,
                order: 200,
                render: |s, frame, _, _| {
                    frame.status.then(|| {
                        div()
                            .debug_selector(|| "shell-status".into())
                            .p(px(8.))
                            .child(s.notice.clone())
                            .into_any_element()
                    })
                },
            },
            RenderSlot {
                group: RenderGroup::Content,
                order: 550,
                render: |s, _, _, _| {
                    s.shortcuts.then(|| {
                        div()
                            .id("shortcut-reference")
                            .track_focus(&s.shortcuts_focus)
                            .key_context("Shortcuts Modal")
                            .debug_selector(|| "shortcut-reference".into())
                            .max_h(px(300.))
                            .overflow_y_scroll()
                            .p(px(12.))
                            .child("Shortcuts (? to close)")
                            .children(
                                crate::keymap::reference()
                                    .into_iter()
                                    .map(|row| div().child(row)),
                            )
                            .into_any_element()
                    })
                },
            },
        ]
    }
}
