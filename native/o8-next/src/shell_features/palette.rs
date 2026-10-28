use super::*;
struct Palette;
register_shell_feature!(Palette);
impl ShellFeature for Palette {
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot {
            group: RenderGroup::Chrome,
            order: 400,
            render,
        }]
    }
}
fn render(s: &mut Shell, _: &Frame, _: &mut Window, cx: &mut Context<Shell>) -> Option<AnyElement> {
    if !s.palette {
        return None;
    }
    if let Some(palette) = registry::extensions().find_map(|extension| extension.palette(s, cx)) {
        return Some(palette);
    }
    Some(
        (div()
            .id("command-palette")
            .debug_selector(|| "command-palette".into())
            .max_h(px(300.))
            .overflow_y_scroll()
            .track_scroll(&s.palette_scroll)
            .p(px(12.))
            .bg(theme().surface_raised)
            .child(format!("Commands: {}", s.query))
            .children(s.commands().into_iter().enumerate().map(|(i, command)| {
                div()
                    .id(("command", i))
                    .debug_selector(move || format!("command-{i}"))
                    .p(px(6.))
                    .cursor_pointer()
                    .bg(if i == s.choice {
                        theme().selection
                    } else {
                        theme().surface_raised
                    })
                    .child(command.label(&s.sessions))
                    .on_click(
                        cx.listener(move |this, _, window, cx| {
                            command.clone().run(this, window, cx)
                        }),
                    )
            })))
        .into_any_element(),
    )
}
