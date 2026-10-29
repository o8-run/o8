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
    let content = div()
        .flex_1()
        .min_h_0()
        .child(content.unwrap_or_else(|| div().p(px(24.)).child(frame.empty).into_any_element()))
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
    Some(
        registrations()
            .iter()
            .fold(content, |content, registration| {
                (registration.decorate)(s, content)
            }),
    )
}
