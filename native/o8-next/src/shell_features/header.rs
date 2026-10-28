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
    let before_workspaces = registrations()
        .iter()
        .flat_map(|r| (r.nav)(s, NavPosition::BeforeWorkspaces, cx))
        .collect::<Vec<_>>();
    let after_workspaces = registrations()
        .iter()
        .flat_map(|r| (r.nav)(s, NavPosition::AfterWorkspaces, cx))
        .collect::<Vec<_>>();
    Some(
        (div()
            .flex()
            .items_center()
            .flex_shrink_0()
            .gap(px(12.))
            .p(px(8.))
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|_, _, window, _| window.prevent_default()),
            )
            .children(
                frame
                    .brand
                    .map(|brand| div().debug_selector(move || brand.into()).child(brand)),
            )
            .children(before_workspaces)
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
            .children(after_workspaces)
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
