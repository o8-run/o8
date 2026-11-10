use super::*;

/// The empty tab: one quiet list of tools, each with its key, sized to fit
/// the panel without scrolling (Q 2026-11-09, after T3 Code's "Open a
/// surface"). The description moved into each row's tooltip.
///
/// Adapted from T3 Code (https://github.com/pingdotgg/t3code, MIT),
/// apps/web/src/components/RightPanelTabs.tsx ("Open a surface") at commit
/// f58fad04162165653bf06f0c987bbfb0074a8a4b. Copyright (c) 2026 T3 Tools Inc.
/// Reimplemented in GPUI.
pub(in super::super) fn launcher(s: &Shell, cx: &mut Context<Shell>) -> AnyElement {
    let p = s.features.read::<Panel>().unwrap();
    let row = |tool: Tool, cx: &mut Context<Shell>| {
        let key = tool.key().map(|k| k.to_ascii_uppercase().to_string());
        button(
            s,
            format!("panel-tool-{}", tool.label().to_lowercase()),
            tool.description(),
            cx,
            move |s, w, cx| open(s, tool, w, cx),
        )
        .h(px(32.))
        .w_full()
        .justify_start()
        .gap(px(10.))
        .px(px(10.))
        .rounded(px(8.))
        .child(crate::icon::stroke(
            tool.icon(),
            theme().text_secondary,
            15.,
            1.6,
        ))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(13.))
                .font_weight(gpui::FontWeight::NORMAL)
                .text_color(theme().text)
                .child(tool.label()),
        )
        .children(key.map(|key| {
            div()
                .size(px(20.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(5.))
                .bg(theme().hover)
                .text_size(px(11.))
                .text_color(theme().text_muted)
                .child(key)
        }))
    };
    let mut list = div()
        .w_full()
        .max_w(px(300.))
        .mx_auto()
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(
            div()
                .debug_selector(|| "panel-launcher-heading".into())
                .pb(px(10.))
                .text_center()
                .text_size(px(13.5))
                .text_color(theme().text)
                .child("Open a tool"),
        );
    for (index, (_, tools)) in Tool::GROUPS.iter().enumerate() {
        if index == 1 {
            // Everyday tools first; a hairline before the rest.
            list = list.child(div().mx(px(10.)).my(px(5.)).h(px(1.)).bg(theme().border));
        }
        for tool in tools.iter().copied() {
            list = list.child(row(tool, cx));
        }
    }
    let focus = p.focus.get("panel-launcher").cloned();
    div()
        .id("panel-launcher")
        .debug_selector(|| "panel-launcher".into())
        .when_some(focus, |v, f| v.track_focus(&f))
        .on_mouse_down(
            gpui::MouseButton::Left,
            cx.listener(|s, _, w, _| super::layout::focus(s, "panel-launcher", w)),
        )
        .size_full()
        .overflow_y_scroll()
        .track_scroll(&p.launcher_scroll)
        // Centred by an inner column at least the panel's height: centring
        // the scroll root itself pushes the head of a tall list above the
        // top, where no scroll reaches it.
        .child(
            div()
                .min_h_full()
                .flex()
                .flex_col()
                .justify_center()
                .p(px(14.))
                .child(list),
        )
        .into_any_element()
}

/// Opens a tool from the empty tab, by click or by its key.
pub(in super::super) fn open(s: &mut Shell, tool: Tool, w: &mut Window, cx: &mut Context<Shell>) {
    if tool == Tool::Subagents {
        subagents::all(s, w, cx);
    }
    show(s, tool, w, cx)
}
