//! Retained session regions keep transcript layout out of editor frames.
use super::*;
use gpui::StyleRefinement;

pub(super) fn header_style() -> StyleRefinement {
    let mut style = StyleRefinement::default();
    style.size.width = Some(gpui::relative(1.).into());
    style.size.height = Some(px(crate::theme::GEOMETRY.header).into());
    style.flex_shrink = Some(0.);
    style
}

pub(super) fn sidebar_style(width: gpui::Pixels) -> StyleRefinement {
    let mut style = StyleRefinement::default();
    style.size.width = Some(width.into());
    style.flex_shrink = Some(0.);
    style
}

pub(super) fn transcript_style() -> StyleRefinement {
    let mut style = StyleRefinement::default();
    style.size.width = Some(gpui::relative(1.).into());
    style.flex_grow = Some(1.);
    style.flex_basis = Some(px(0.).into());
    style.min_size.height = Some(px(0.).into());
    style
}

impl Surface {
    pub(super) fn session_header(
        &mut self,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        div()
            .h(px(crate::theme::GEOMETRY.header))
            .px(px(16.))
            .flex()
            .items_center()
            .gap(px(16.))
            .child("o8 next")
            .child(self.brain_control(cx))
            .child(
                div()
                    .id("refresh")
                    .debug_selector(|| "session-refresh".into())
                    .px(px(8.))
                    .py(px(4.))
                    .rounded(px(5.))
                    .cursor_pointer()
                    .bg(theme().surface_raised)
                    .child("Refresh")
                    .on_click(cx.listener(|this, _, _, cx| this.load_sessions(cx))),
            )
            .into_any_element()
    }
    pub(super) fn session_sidebar_region(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let width = (f32::from(window.viewport_size().width) * 0.25)
            .min(crate::theme::GEOMETRY.sidebar_width);
        self.session_sidebar(px(crate::theme::sidebar_width(width)), cx)
    }
    pub(super) fn session_transcript(
        &mut self,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let rows = self.rows.clone();
        let painted_rows = self.painted_rows.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .when(!self.notice.is_empty(), |view| {
                view.child(
                    div()
                        .px(px(24.))
                        .py(px(8.))
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child(self.notice.clone()),
                )
            })
            .child(self.history_control(cx))
            .child(
                list(self.list.clone(), {
                    let list_state = self.list.clone();
                    move |index, _, _| {
                        RetainedRow {
                            state: rows[index].clone(),
                            index,
                            painted: painted_rows.clone(),
                        }
                        .interactive(&list_state)
                    }
                })
                .flex_1()
                .min_h_0(),
            )
            .into_any_element()
    }
}

pub(super) fn footer_style() -> StyleRefinement {
    let mut style = header_style();
    style.size.height = None;
    style
}
