//! Classic Workspace Notes frame, toolbar status and conflict strip.
use super::*;
impl Render for Spec {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.start(window, cx);
        let status = self.status();
        let (add, del) = self.diff();
        #[cfg(test)]
        cx.set_global(super::super::tests::spec_tests::Status {
            text: status.clone(),
            content: self.content.clone(),
            pending: self.pending,
        });
        div()
            .id("spec-root")
            .debug_selector(|| "spec-root".into())
            .size_full()
            .min_w_0()
            .min_h_0()
            .flex()
            .flex_col()
            .font_family(theme().font_ui)
            .font_weight(FontWeight::LIGHT)
            .text_color(theme().text)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "s"
                    && (event.keystroke.modifiers.platform || event.keystroke.modifiers.control)
                {
                    this.edits += 1;
                    this.persist(false, cx);
                    cx.stop_propagation();
                }
            }))
            .child(
                div()
                    .debug_selector(|| "spec-header".into())
                    .h(px(58.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .pl(px(18.))
                    .pr(px(8.))
                    .border_b_1()
                    .border_color(theme().border)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(3.))
                            .child(
                                div()
                                    .flex()
                                    .items_baseline()
                                    .gap(px(10.))
                                    .min_w_0()
                                    .child(
                                        div()
                                            .text_size(px(13.5))
                                            .font_weight(FontWeight(350.))
                                            .line_height(px(16.875))
                                            .whitespace_nowrap()
                                            .overflow_hidden()
                                            .text_ellipsis()
                                            .child("Workspace Notes"),
                                    )
                                    .child(
                                        div()
                                            .debug_selector(|| "spec-diff-stats".into())
                                            .font_family(theme().font_mono)
                                            .text_size(px(9.5))
                                            .flex()
                                            .gap(px(6.))
                                            .when(add > 0, |d| {
                                                d.child(
                                                    div()
                                                        .text_color(theme().success)
                                                        .child(format!("+{add}")),
                                                )
                                            })
                                            .when(del > 0, |d| {
                                                d.child(
                                                    div()
                                                        .text_color(theme().danger)
                                                        .child(format!("-{del}")),
                                                )
                                            })
                                            .when(add == 0 && del == 0, |d| {
                                                d.child(
                                                    div().text_color(theme().text_faint).child("0"),
                                                )
                                            }),
                                    ),
                            )
                            .child(
                                div()
                                    .debug_selector(|| "spec-status".into())
                                    .text_size(px(9.5))
                                    .font_weight(FontWeight(260.))
                                    .text_color(if self.error.is_some() {
                                        theme().danger
                                    } else {
                                        theme().text_faint
                                    })
                                    .whitespace_nowrap()
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .child(status),
                            ),
                    )
                    .when(self.error.is_some() && !self.pending, |d| {
                        d.child(button("spec-retry", "Retry").on_click(cx.listener(
                            |this, _, _, cx| {
                                if this.content != this.server {
                                    this.persist(false, cx);
                                } else {
                                    this.load(false, cx);
                                }
                            },
                        )))
                    }),
            )
            .when(self.conflict.is_some(), |d| {
                d.child(
                    div()
                        .debug_selector(|| "spec-conflict".into())
                        .min_h(px(52.))
                        .flex_shrink_0()
                        .px(px(16.))
                        .py(px(4.))
                        .flex()
                        .items_center()
                        .gap(px(12.))
                        .bg(theme().surface)
                        .border_b_1()
                        .border_color(theme().border)
                        .text_size(px(11.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child("Changed on disk while you were editing"),
                        )
                        .child(
                            button("spec-conflict-reload", "Reload")
                                .min_h(px(44.))
                                .when(!self.saving, |d| {
                                    d.on_click(
                                        cx.listener(|this, _, _, cx| this.reload_conflict(cx)),
                                    )
                                })
                                .when(self.saving, |d| d.opacity(0.6)),
                        )
                        .child(
                            button(
                                "spec-conflict-overwrite",
                                if self.saving {
                                    "Overwriting…"
                                } else {
                                    "Overwrite"
                                },
                            )
                            .min_h(px(44.))
                            .text_color(theme().danger)
                            .when(!self.saving, |d| {
                                d.on_click(cx.listener(|this, _, _, cx| this.persist(true, cx)))
                            })
                            .when(self.saving, |d| d.opacity(0.6)),
                        ),
                )
            })
            .child(
                div().flex_1().min_w_0().min_h_0().flex().p(px(14.)).child(
                    div()
                        .debug_selector(|| "spec-frame".into())
                        .flex_1()
                        .min_w_0()
                        .min_h_0()
                        .max_w(px(920.))
                        .mx_auto()
                        .rounded(px(18.))
                        .border_1()
                        .border_color(theme().border)
                        .bg(theme().surface)
                        .overflow_hidden()
                        .flex()
                        .when(self.loading, |d| {
                            d.child(
                                div()
                                    .pt(px(18.))
                                    .pl(px(18.))
                                    .text_size(px(12.))
                                    .text_color(theme().text_muted)
                                    .child("Loading notes..."),
                            )
                        })
                        .when(!self.loading && !self.workspace.is_empty(), |d| {
                            d.child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .min_h_0()
                                    .flex()
                                    .m(px(7.))
                                    .pl(px(16.))
                                    .pr(px(8.))
                                    .child(self.editor.clone()),
                            )
                        })
                        .when(!self.loading && self.workspace.is_empty(), |d| {
                            d.child(
                                div()
                                    .p(px(18.))
                                    .text_size(px(12.))
                                    .text_color(theme().text_muted)
                                    .child("Select a repo to edit o8.md."),
                            )
                        }),
                ),
            )
    }
}
pub(super) fn button(id: &'static str, label: &str) -> Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .focusable()
        .min_h(px(24.))
        .px(px(8.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(7.))
        .text_size(px(11.))
        .font_weight(FontWeight::LIGHT)
        .text_color(theme().text_muted)
        .cursor_pointer()
        .hover(|d| d.bg(theme().hover))
        .active(|d| d.bg(theme().selection))
        .focus(|d| d.border_1().border_color(theme().accent))
        .child(label.to_owned())
}
