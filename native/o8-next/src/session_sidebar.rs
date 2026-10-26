//! Compact saved-session navigation in the existing session surface.
use super::*;
impl Surface {
    pub(super) fn session_sidebar(
        &self,
        width: gpui::Pixels,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let typography = &crate::theme::TYPE;
        let geometry = &crate::theme::GEOMETRY;
        div()
            .id("sessions")
            .debug_selector(|| "session-sidebar".into())
            .w(width)
            .rounded(px(geometry.card_radius))
            .border_1()
            .border_color(theme().border)
            .flex_shrink_0()
            .overflow_y_scroll()
            .px(px(8.))
            .children(
                sidebar::tree(&self.sessions, self.selected.as_deref())
                    .into_iter()
                    .map(|group| {
                        div()
                            .mt(px(16.))
                            .child(
                                div()
                                    .px(px(12.))
                                    .mb(px(6.))
                                    .text_size(px(typography.section))
                                    .text_color(theme().text_muted)
                                    .child(match group.kind {
                                        "working" => "Working",
                                        "review" => "Review",
                                        _ => "Recent",
                                    }),
                            )
                            .children(group.rows.into_iter().map(|session| {
                                let id = session.id.clone();
                                let selector = id.clone();
                                let status =
                                    self.sessions.iter().find(|item| item.id == id).unwrap();
                                let color = match sidebar::rank(status) {
                                    4.. => theme().danger,
                                    2..=3 => theme().warning,
                                    1 => theme().success,
                                    _ if sidebar::working(status) => theme().success,
                                    _ => theme().text_faint,
                                };
                                div()
                                    .id(gpui::ElementId::Name(id.clone().into()))
                                    .debug_selector(move || format!("session-{selector}"))
                                    .px(px(12.))
                                    .h(px(geometry.row_height))
                                    .flex()
                                    .items_center()
                                    .gap(px(geometry.gap))
                                    .rounded(px(geometry.row_radius))
                                    .cursor_pointer()
                                    .bg(if session.selected {
                                        theme().selection
                                    } else {
                                        theme().background
                                    })
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .truncate()
                                            .text_size(px(typography.row_title))
                                            .child(session.title),
                                    )
                                    .child(
                                        div().flex_shrink_0().size(px(6.)).rounded_full().bg(color),
                                    )
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.select(id.clone(), cx);
                                        this.focus.focus(window);
                                    }))
                            }))
                    }),
            )
            .into_any_element()
    }
}
