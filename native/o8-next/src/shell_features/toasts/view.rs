use super::*;
use gpui::{FontWeight, StatefulInteractiveElement};

struct Snapshot {
    id: ToastId,
    kind: Kind,
    text: SharedString,
    actions: Vec<SharedString>,
    expanded: bool,
    exiting: bool,
    opacity: f32,
}
fn button(
    id: String,
    text: impl Into<SharedString>,
    enabled: bool,
    callback: impl Fn(&mut Window, &mut App) + 'static,
) -> gpui::Stateful<gpui::Div> {
    let selector = id.clone();
    let callback = Rc::new(callback);
    let key_callback = callback.clone();
    div()
        .id(SharedString::from(id))
        .debug_selector(move || selector.clone())
        .flex_shrink_0()
        .min_h(px(26.))
        .px(px(7.))
        .rounded(px(6.))
        .flex()
        .items_center()
        .text_size(px(11.))
        .font_weight(FontWeight(300.))
        .border_1()
        .border_color(theme().border)
        .text_color(theme().text_secondary)
        .when(enabled, |v| {
            v.focusable()
                .cursor_pointer()
                .hover(|v| v.bg(theme().hover))
                .active(|v| v.bg(theme().selection))
                .focus(|v| v.border_color(theme().accent))
                .on_click(move |_, w, cx| callback(w, cx))
                .on_key_down(move |e, w, cx| {
                    if matches!(e.keystroke.key.as_str(), "enter" | "space") {
                        cx.stop_propagation();
                        key_callback(w, cx);
                    }
                })
        })
        .child(text.into())
}
fn card(t: Snapshot) -> impl IntoElement {
    let id = t.id;
    let tone = match &t.kind {
        Kind::Error { .. } | Kind::SpawnError { .. } => theme().danger,
        Kind::Success => theme().success,
        _ => theme().accent,
    };
    let glyph = match &t.kind {
        Kind::Error { .. } | Kind::SpawnError { .. } => {
            "M12 8v5 M12 16h.01 M10.3 3.9L2.5 17.4A1.7 1.7 0 0 0 4 20h16a1.7 1.7 0 0 0 1.5-2.6L13.7 3.9a2 2 0 0 0-3.4 0Z"
        }
        Kind::Success => "M20 6 9 17l-5-5",
        _ => "M12 8h.01 M12 11v6 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
    };
    let mut body = div()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .w_full()
                .whitespace_normal()
                .text_size(px(12.5))
                .font_weight(FontWeight(300.))
                .line_height(gpui::relative(1.4))
                .text_color(theme().text)
                .child(t.text),
        );
    let mut actions = div().flex().flex_wrap().gap(px(6.));
    let mut any = false;
    for (index, label) in t.actions.into_iter().enumerate() {
        any = true;
        actions = actions.child(button(
            format!("toast-{id}-action-{index}"),
            label,
            !t.exiting,
            move |w, cx| fire(id, index, w, cx),
        ));
    }
    if let Some(value) = t.kind.detail() {
        any = true;
        actions = actions.child(button(
            format!("toast-{id}-detail-toggle"),
            if t.expanded {
                "Hide details"
            } else {
                "Details"
            },
            !t.exiting,
            move |_, cx| detail(id, cx),
        ));
        if t.expanded {
            body = body.child(
                div()
                    .id(SharedString::from(format!("toast-{id}-detail")))
                    .debug_selector(move || format!("toast-{id}-detail"))
                    .max_h(px(180.))
                    .overflow_y_scroll()
                    .w_full()
                    .whitespace_normal()
                    .font_family(theme().font_mono)
                    .text_size(px(11.))
                    .line_height(gpui::relative(1.45))
                    .text_color(theme().text_secondary)
                    .child(value.clone()),
            );
        }
    }
    if any {
        body = body.child(actions);
    }
    div()
        .id(SharedString::from(format!("toast-{id}")))
        .debug_selector(move || format!("toast-{id}"))
        .w_full()
        .min_w_0()
        .flex_shrink_0()
        .flex()
        .items_start()
        .gap(px(10.))
        .p(px(12.))
        .rounded(px(13.))
        .border_1()
        .border_color(theme().border)
        .bg(crate::theme::popover_background())
        .shadow_lg()
        .relative()
        .left(px((1. - t.opacity) * crate::motion::TOAST_SLIDE_PX))
        .opacity(t.opacity)
        .occlude()
        .on_hover(move |hovered, _, cx| pause(id, *hovered, cx))
        .child(
            div()
                .mt(px(1.))
                .child(crate::icon::stroke(glyph, tone, 16., 1.8)),
        )
        .child(body)
        .child(
            button(
                format!("toast-{id}-dismiss"),
                "×",
                !t.exiting,
                move |_, cx| dismiss(id, cx),
            )
            .px(px(5.)),
        )
}
pub(super) fn render(
    s: &mut Shell,
    _: &Frame,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Option<AnyElement> {
    let center = cx.try_global::<Center>()?;
    if center.items.is_empty() {
        return None;
    }
    let now = cx.background_executor().now();
    let mut moving = false;
    let mut groups: [Vec<Snapshot>; 3] = std::array::from_fn(|_| vec![]);
    for toast in &center.items {
        let (opacity, active) = toast.opacity(now);
        moving |= active;
        groups[toast.kind.place() as usize].push(Snapshot {
            id: toast.id,
            kind: toast.kind.clone(),
            text: toast.text.clone(),
            actions: toast.actions.iter().map(|a| a.label.clone()).collect(),
            expanded: toast.expanded,
            exiting: toast.exiting.is_some(),
            opacity,
        });
    }
    if moving {
        window.request_animation_frame();
    }
    groups[0].sort_by_key(|t| (!t.kind.urgent(), t.id));
    let viewport = window.viewport_size();
    let card_width = (f32::from(viewport.width) - 32.).clamp(0., 340.);
    let mut host = div().absolute().top_0().left_0().size_full();
    for (place, items) in groups.into_iter().enumerate() {
        if items.is_empty() {
            continue;
        }
        let width = if place == 1 {
            (f32::from(viewport.width) - 32.).clamp(0., 520.)
        } else {
            card_width
        };
        // Keep shadow ink inside the scroll clip without moving the card edges.
        let frame_width = width + 16.;
        let mut stack = div()
            .id(SharedString::from(format!("toast-stack-{place}")))
            .absolute()
            .w(px(frame_width))
            .p(px(8.))
            .max_h((viewport.height - px(68.)).max(px(40.)))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(8.))
            .debug_selector(move || format!("toast-stack-{place}"));
        stack = match place {
            1 => stack
                .bottom(px(40.))
                .left((viewport.width - px(frame_width)) / 2.),
            2 => stack
                .bottom(px(140.))
                .right(px((super::super::right_panel::width(s, window)
                    .map_or(0., |(_, shown)| shown)
                    + 16.)
                    .min((f32::from(viewport.width) - width - 16.).max(16.))
                    - 8.)),
            _ => stack.top(px(44.)).right(px(8.)),
        };
        host = host.child(stack.children(items.into_iter().map(card)));
    }
    Some(host.into_any_element())
}
