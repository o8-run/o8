use super::*;
struct ContentSlot;
register_shell_feature!(ContentSlot);
impl ShellFeature for ContentSlot {
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot {
            group: RenderGroup::Content,
            order: 600,
            render,
        }]
    }
}
fn render(
    s: &mut Shell,
    frame: &Frame,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Option<AnyElement> {
    let active = s.active();
    let content = registrations()
        .iter()
        .find_map(|r| (r.overlay)(s))
        .or_else(|| registry::extensions().find_map(|extension| extension.overlay(s)))
        .or_else(|| {
            active
                .as_ref()
                .and_then(|t| s.content.get(&s.key(t)))
                .map(Content::element)
        });
    // The Activity Dock floats at the top right of the chat column.
    let content = div()
        .flex_1()
        .min_h_0()
        .relative()
        .child(content.unwrap_or_else(|| div().p(px(24.)).child(frame.empty).into_any_element()))
        .children(super::activity_dock::element(s, window, cx))
        .into_any_element();
    // The right panel sits inside the sidebar decoration, beside the content.
    let content = match super::right_panel::element(s, window, cx) {
        Some((panel, _, shown)) => div()
            .flex()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .child(div().flex().flex_col().flex_1().min_w_0().child(content))
            .child(
                div()
                    .w(px(shown))
                    .h_full()
                    .flex_shrink_0()
                    .overflow_hidden()
                    .border_l_1()
                    .border_color(theme().border)
                    .child(panel),
            )
            .into_any_element(),
        None => content,
    };
    // The width saves once, when the edge is let go.
    if s.surfaces.sidebar.resizing && !cx.has_active_drag() {
        s.surfaces.sidebar.resizing = false;
        s.persist();
    }
    let content = registrations()
        .iter()
        .fold(content, |content, registration| {
            (registration.decorate)(s, content)
        });
    Some(
        div()
            .flex()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .on_drag_move(cx.listener(
                |s, event: &gpui::DragMoveEvent<super::super::sidebar::Resize>, _, cx| {
                    super::super::sidebar::resize(s, event, cx);
                    cx.notify();
                },
            ))
            .child(content)
            .into_any_element(),
    )
}
