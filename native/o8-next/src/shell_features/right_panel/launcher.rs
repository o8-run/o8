use super::*;
pub(in super::super) fn launcher(s: &Shell, cx: &mut Context<Shell>) -> AnyElement {
    let p = s.features.read::<Panel>().unwrap();
    let measured = p.launcher_height.clone();
    let notify = measured.clone();
    let owner = cx.entity().entity_id();
    let height = measured.get().max(1.);
    let card = ((height - 28. - 36.) / 7.).clamp(52., 64.);
    let compact = card < 64.;
    let tools = Tool::GROUPS
        .iter()
        .take(if p.more { 3 } else { 1 })
        .flat_map(|(_, t)| t.iter())
        .copied();
    let cards = tools.map(|tool| {
        button(
            s,
            format!("panel-tool-{}", tool.label().to_lowercase()),
            tool.description(),
            cx,
            move |s, w, cx| show(s, tool, w, cx),
        )
        .min_h(px(card))
        .w_full()
        .justify_start()
        .gap(px(12.))
        .px(px(14.))
        .py(px(if compact { 8. } else { 12. }))
        .rounded(px(10.))
        .border_1()
        .border_color(theme().border)
        .bg(theme().background)
        .child(
            div()
                .size(px(if compact { 26. } else { 30. }))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(8.))
                .bg(theme().hover)
                .border_1()
                .border_color(theme().border)
                .child(crate::icon::stroke(
                    tool.icon(),
                    theme().text_secondary,
                    if compact { 14. } else { 16. },
                    1.6,
                )),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(3.))
                .child(
                    div()
                        .text_size(px(if compact { 12.5 } else { 13.5 }))
                        .line_height(gpui::relative(1.25))
                        .text_color(theme().text)
                        .child(tool.label()),
                )
                .child(
                    {
                        let mut metadata = div();
                        metadata
                            .style()
                            .text
                            .get_or_insert_with(Default::default)
                            .letter_spacing = Some(px(-0.4));
                        metadata
                    }
                    .text_size(px(11.))
                    .line_height(gpui::relative(1.25))
                    .font_weight(gpui::FontWeight(260.))
                    .text_color(theme().text_muted)
                    .child(tool.description()),
                ),
        )
    });
    div()
        .id("panel-launcher")
        .debug_selector(move || format!("panel-launcher-card-{card:.0}"))
        .relative()
        .size_full()
        .overflow_y_scroll()
        .track_scroll(&p.launcher_scroll)
        .p(px(14.))
        .child(
            div()
                .w_full()
                .max_w(px(460.))
                .mx_auto()
                .min_h_full()
                .flex()
                .flex_col()
                .justify_center()
                .gap(px(6.))
                .children(cards)
                .child(
                    button(
                        s,
                        "panel-launcher-more",
                        if p.more {
                            "Show everyday tools"
                        } else {
                            "More tools and diagnostics"
                        },
                        cx,
                        |s, _, cx| {
                            let p = s.features.get::<Panel>();
                            p.more = !p.more;
                            cx.notify()
                        },
                    )
                    .py(px(8.))
                    .w_full()
                    .text_size(px(11.))
                    .child(if p.more {
                        "Show everyday tools"
                    } else {
                        "More tools and diagnostics"
                    }),
                ),
        )
        .child(
            canvas(
                move |bounds, _, cx| {
                    if notify.replace(f32::from(bounds.size.height))
                        != f32::from(bounds.size.height)
                    {
                        cx.notify(owner)
                    }
                },
                |_, _, _, _| {},
            )
            .absolute()
            .inset_0(),
        )
        .into_any_element()
}
