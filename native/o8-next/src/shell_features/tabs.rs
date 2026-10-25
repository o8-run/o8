use super::*;
struct Tabs;
register_shell_feature!(Tabs);
impl ShellFeature for Tabs {
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot { order: 500, render }]
    }
}
fn render(s: &mut Shell, _: &Frame, _: &mut Window, cx: &mut Context<Shell>) -> Option<AnyElement> {
    let active = s.active();
    Some(
        (div()
            .flex()
            .h(px(crate::theme::GEOMETRY.header))
            .items_center()
            .gap(px(crate::theme::GEOMETRY.gap))
            .id("surface-tabs")
            .overflow_x_scroll()
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|_, _, window, _| window.prevent_default()),
            )
            .children(
                s.current()
                    .map(|w| w.tabs.clone())
                    .unwrap_or_default()
                    .into_iter()
                    .enumerate()
                    .map(|(i, t)| {
                        div()
                            .id(("surface-tab", i))
                            .debug_selector(move || format!("surface-tab-{i}"))
                            .cursor_pointer()
                            .h(px(crate::theme::GEOMETRY.tab_height))
                            .px(px(crate::theme::GEOMETRY.gap))
                            .flex()
                            .items_center()
                            .flex_shrink_0()
                            .rounded(px(crate::theme::GEOMETRY.tab_radius))
                            .bg(if active.as_ref() == Some(&t) {
                                theme().selection
                            } else {
                                theme().surface_raised
                            })
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
            ))
        .into_any_element(),
    )
}
