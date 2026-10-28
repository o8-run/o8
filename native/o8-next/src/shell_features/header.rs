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
    // Surface entries and the brand live in the navigation rail (shell_rail.rs);
    // the open tabs share this band, as in the desktop workspace header.
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
            .child(tabs(s, cx))
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

/// The desktop header's pill strip: the active tab is a filled pill, the rest
/// are quiet labels that fill on hover.
fn tabs(s: &Shell, cx: &mut Context<Shell>) -> impl IntoElement {
    let active = s.active();
    let geometry = crate::theme::GEOMETRY;
    div()
        .flex()
        .flex_1()
        .min_w_0()
        .items_center()
        .gap(px(2.))
        .id("surface-tabs")
        .overflow_x_scroll()
        .children(
            s.current()
                .map(|w| w.tabs.clone())
                .unwrap_or_default()
                .into_iter()
                .enumerate()
                .map(|(i, t)| {
                    let selected = active.as_ref() == Some(&t);
                    div()
                        .id(("surface-tab", i))
                        .debug_selector(move || format!("surface-tab-{i}"))
                        .cursor_pointer()
                        .h(px(geometry.tab_height))
                        .max_w(px(200.))
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .flex_shrink_0()
                        .overflow_hidden()
                        .whitespace_normal()
                        .line_clamp(1)
                        .text_ellipsis()
                        .rounded(px(geometry.tab_radius))
                        .text_color(if selected {
                            theme().text
                        } else {
                            theme().text_muted
                        })
                        .when(selected, |pill| pill.bg(theme().selection))
                        .when(!selected, |pill| pill.hover(|pill| pill.bg(theme().hover)))
                        .child(match &t {
                            Tab::Session(id) => {
                                let selected = s
                                    .current()
                                    .and_then(|w| w.selections.get(id))
                                    .unwrap_or(id);
                                s.sessions
                                    .iter()
                                    .find(|s| &s.id == selected)
                                    .map(|s| s.title.clone())
                                    .unwrap_or_else(|| "Chat".into())
                            }
                            _ => t.label().into(),
                        })
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.capture(window, cx);
                            for registration in registrations() {
                                (registration.after_tab)(this);
                            }
                            this.state
                                .workspaces
                                .get_mut(this.state.selected.as_deref().unwrap_or(""))
                                .unwrap()
                                .active = i;
                            this.ensure(window, cx);
                            this.restore_focus(window, cx);
                            this.persist();
                            cx.notify();
                        }))
                }),
        )
}
