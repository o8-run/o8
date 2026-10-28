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
    _: &mut Window,
    _: &mut Context<Shell>,
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
        .debug_selector(|| "shell-content".into())
        .flex_1()
        .min_h_0()
        .child(content.unwrap_or_else(|| div().p(px(24.)).child(frame.empty).into_any_element()))
        .into_any_element();
    Some(
        registrations()
            .iter()
            .fold(content, |content, registration| {
                (registration.decorate)(s, content)
            }),
    )
}
