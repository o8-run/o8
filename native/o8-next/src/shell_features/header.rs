use super::*;
struct Header;
register_shell_feature!(Header);
impl ShellFeature for Header {
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot {
            group: RenderGroup::Chrome,
            order: 100,
            render,
        }]
    }
}
fn render(
    s: &mut Shell,
    frame: &Frame,
    _: &mut Window,
    cx: &mut Context<Shell>,
) -> Option<AnyElement> {
    // Surface entries and the brand live in the navigation rail (shell_rail.rs).
    Some(
        (div()
            .flex()
            .items_center()
            .flex_shrink_0()
            .gap(px(12.))
            .h(px(crate::theme::GEOMETRY.header))
            // Clears the traffic lights, which extend past the rail column.
            .pl(px(20.))
            .pr(px(8.))
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|_, _, window, _| window.prevent_default()),
            )
            .child(
                div()
                    .id("workspace-switcher")
                    .debug_selector(|| "workspace-switcher".into())
                    .max_w(px(220.))
                    .overflow_hidden()
                    .p(px(6.))
                    .cursor_pointer()
                    .child(
                        s.state
                            .selected
                            .as_deref()
                            .and_then(|path| std::path::Path::new(path).file_name())
                            .map(|name| name.to_string_lossy().to_string())
                            .unwrap_or_else(|| "Workspaces".into()),
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.capture(window, cx);
                        this.palette = true;
                        this.workspace_picker = true;
                        this.shortcuts = false;
                        this.query.clear();
                        this.choice = 0;
                        this.palette_scroll.scroll_to_item(1);
                        this.focus.focus(window);
                        cx.notify();
                    })),
            )
            .child(
                div()
                    .id("shell-palette")
                    .cursor_pointer()
                    .p(px(6.))
                    .child(
                        div()
                            .debug_selector(move || frame.commands.into())
                            .child(frame.commands),
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.capture(window, cx);
                        this.palette = true;
                        this.workspace_picker = false;
                        this.shortcuts = false;
                        this.query.clear();
                        this.choice = 0;
                        this.palette_scroll.scroll_to_item(1);
                        this.focus.focus(window);
                        this.revision += 1;
                        cx.notify();
                    })),
            )
            .when(frame.retry, |view| {
                view.child(
                    div()
                        .id("shell-retry")
                        .debug_selector(|| "shell-retry".into())
                        .cursor_pointer()
                        .p(px(6.))
                        .child("Retry")
                        .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
                )
            }))
        .into_any_element(),
    )
}
