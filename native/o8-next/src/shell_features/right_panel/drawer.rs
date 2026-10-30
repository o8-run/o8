use super::*;
pub(super) fn menu(s: &Shell, cx: &mut Context<Shell>) -> AnyElement {
    let p = s.features.read::<Panel>().unwrap();
    let lower = p.menu_lower;
    let selected = if lower {
        p.lower.unwrap_or(Tool::Spec)
    } else {
        p.selected
    };
    let selected = if matches!(selected, Tool::Prs | Tool::Compare) {
        Tool::Activity
    } else {
        selected
    };
    let appear = crate::motion::ease_out((p.menu.unwrap().elapsed().as_secs_f32() / 0.14).min(1.));
    let column = |groups: &[usize], cx: &mut Context<Shell>| {
        div()
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .children(groups.iter().map(|index| {
                let (label, tools) = Tool::GROUPS[*index];
                div()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_size(px(10.))
                            .font_weight(gpui::FontWeight::LIGHT)
                            .text_color(theme().text_muted)
                            .pt(px(5.))
                            .pb(px(3.))
                            .px(px(11.))
                            .child(label),
                    )
                    .children(tools.iter().map(|t| {
                        let t = *t;
                        button(
                            s,
                            format!("panel-add-{}", t.slug()),
                            t.description(),
                            cx,
                            move |s, w, cx| layout::choose(s, t, w, cx),
                        )
                        .w_full()
                        .justify_start()
                        .gap(px(9.))
                        .px(px(11.))
                        .py(px(6.))
                        .rounded_none()
                        .text_size(px(12.5))
                        .child(crate::icon::stroke(
                            t.icon(),
                            if selected == t {
                                theme().text
                            } else {
                                theme().text_muted
                            },
                            15.,
                            1.6,
                        ))
                        .child(div().flex_1().child(t.label()))
                        .when(selected == t, |v| {
                            v.child(crate::icon::stroke(
                                "m20 6-11 11-5-5",
                                theme().text,
                                12.,
                                2.6,
                            ))
                        })
                    }))
            }))
    };
    let body = div()
        .id("panel-add-menu")
        .debug_selector(|| "panel-add-menu".into())
        .occlude()
        .w(px(340.))
        .py(px(4.))
        .flex()
        .flex_col()
        .rounded(px(10.))
        .bg(crate::theme::popover_background())
        .border_1()
        .border_color(theme().border)
        .shadow_lg()
        .opacity(appear)
        .relative()
        .top(px(-4. * (1. - appear)))
        .when(!lower, |v| {
            v.child(
                button(
                    s,
                    "panel-add-browser-page",
                    "New browser page",
                    cx,
                    |s, w, cx| {
                        pages::new_page(s, w, cx);
                        s.features.get::<Panel>().menu = None;
                        layout::focus(s, "panel-more-views", w)
                    },
                )
                .w_full()
                .justify_start()
                .gap(px(9.))
                .px(px(11.))
                .py(px(7.))
                .text_size(px(12.5))
                .child(crate::icon::stroke(BROWSER, theme().text, 15., 1.6))
                .child("New browser page"),
            )
        })
        .child(
            div()
                .flex()
                .gap(px(4.))
                .child(column(&[0], cx))
                .child(column(&[1, 2], cx)),
        );
    div()
        .size_0()
        .child(
            gpui::deferred(
                gpui::anchored().position(point(px(0.), px(0.))).child(
                    div()
                        .w(px(p.viewport))
                        .h(px(10000.))
                        .id("panel-menu-backdrop")
                        .on_mouse_down(
                            gpui::MouseButton::Left,
                            cx.listener(|s, _, _, cx| {
                                s.features.get::<Panel>().menu = None;
                                cx.notify()
                            }),
                        ),
                ),
            )
            .with_priority(1),
        )
        .child(
            gpui::deferred(
                gpui::anchored()
                    .anchor(gpui::Corner::TopLeft)
                    .snap_to_window_with_margin(px(8.))
                    .child(body),
            )
            .with_priority(2),
        )
        .into_any_element()
}
