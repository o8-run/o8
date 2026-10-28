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
                group: RenderGroup::Chrome,
                order: 300,
                render: |s, _, _, _| {
                    s.shortcuts.then(|| {
                        (div()
                            .debug_selector(|| "shortcut-reference".into())
                            .p(px(12.))
                            .children(
                                [
                                    "Ctrl+K / Cmd+K: Commands",
                                    "Ctrl+Tab: Next surface",
                                    "Ctrl+W: Close surface",
                                    "Enter: Send",
                                    "Shift+Enter: New line",
                                    "Ctrl+Shift+Enter: Switch send mode",
                                    "F6: Steer queued",
                                    "F7: Remove queued",
                                    "Escape: Close",
                                ]
                                .into_iter()
                                .map(|key| div().p(px(6.)).child(key)),
                            ))
                        .into_any_element()
                    })
                },
            },
        ]
    }
}
