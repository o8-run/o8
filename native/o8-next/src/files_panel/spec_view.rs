//! Classic Workspace Notes header, document frame, menus and conflict strip.
use super::controls::{control, focused};
use super::*;
impl Render for Spec {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.start(window, cx);
        #[cfg(test)]
        cx.set_global(super::super::tests::spec_tests::Status {
            text: self.status(),
            content: self.content.clone(),
            pending: self.pending,
            reply: self
                .editor
                .read(cx)
                .rail
                .reply
                .as_ref()
                .map(|(_, input, _)| input.read(cx).text.clone()),
        });
        div()
            .id("spec-root")
            .debug_selector(|| "spec-root".into())
            .size_full()
            .track_focus(&self.focus)
            .min_w_0()
            .min_h_0()
            .relative()
            .flex()
            .flex_col()
            .font_family(theme().font_ui)
            .font_weight(FontWeight::LIGHT)
            .text_color(theme().text)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "s"
                    && (event.keystroke.modifiers.platform || event.keystroke.modifiers.control)
                {
                    this.edits += 1;
                    this.persist(false, cx);
                    cx.stop_propagation();
                }
                if event.keystroke.key == "escape" && (this.settings || this.target.open) {
                    this.close_menu(window, cx);
                    cx.stop_propagation();
                }
            }))
            .child(self.header(cx))
            .children(self.conflict_strip(cx))
            .child(self.frame())
            .when(self.target.open, |d| {
                d.child(
                    div()
                        .absolute()
                        .top(px(53.))
                        .right(px(65.))
                        .child(self.target_menu(cx)),
                )
            })
            .when(self.settings, |d| {
                d.child(
                    div().absolute().top(px(53.)).right(px(8.)).child(
                        deferred(
                            anchored()
                                .anchor(Corner::TopRight)
                                .snap_to_window_with_margin(px(12.))
                                .child(self.settings_menu(cx)),
                        )
                        .with_priority(1),
                    ),
                )
            })
    }
}
impl Spec {
    fn header(&self, cx: &mut Context<Self>) -> AnyElement {
        let status = self.status();
        let status_tip = status.clone();
        let (add, del) = self.diff();
        let name = if self.workspace.is_empty() {
            "Choose o8.md"
        } else {
            self.workspace
                .rsplit('/')
                .next()
                .filter(|s| !s.is_empty())
                .unwrap_or(&self.workspace)
        };
        let target_tip = if self.workspace.is_empty() {
            "Choose an o8.md target".to_owned()
        } else {
            self.workspace.clone()
        };
        div().debug_selector(||"spec-header".into()).h(px(58.)).flex_shrink_0().flex().items_center().gap(px(12.))
            .pl(px(18.)).pr(px(8.)).border_b_1().border_color(theme().border)
            .child(div().flex_1().min_w_0().flex().flex_col().gap(px(3.))
                .child(div().flex().items_baseline().gap(px(10.)).min_w_0()
                    .child(div().text_size(px(13.5)).font_weight(FontWeight(350.)).line_height(px(16.875)).whitespace_nowrap().overflow_hidden().text_ellipsis().child("Workspace Notes"))
                    .child(div().debug_selector(||"spec-diff-stats".into()).font_family(theme().font_mono).text_size(px(9.5)).flex().gap(px(6.))
                        .when(add>0,|d|d.child(div().text_color(theme().success).child(format!("+{add}"))))
                        .when(del>0,|d|d.child(div().text_color(theme().danger).child(format!("-{del}"))))
                        .when(add==0&&del==0,|d|d.child(div().text_color(theme().text_faint).child("0")))))
                .child(div().flex().items_center().min_w_0()
                    .child(div().id("spec-status").debug_selector(||"spec-status".into()).flex_1().min_w_0().text_size(px(9.5)).font_weight(FontWeight(260.))
                        .text_color(if self.error.is_some(){theme().danger}else if self.reviewing{self.preferences.ink()}else{theme().text_faint})
                        .whitespace_nowrap().overflow_hidden().text_ellipsis().child(status)
                        .tooltip(move|_,cx|cx.new(|_|crate::icon::Tip(status_tip.clone().into())).into()))
                    .when(self.error.is_some()&&!self.pending,|d|d.child(control("spec-retry","Retry",cx,|this,_,cx|{
                        if this.content!=this.server{this.persist(false,cx);}else{this.load(false,cx);}
                    })))))
            .child(focused("spec-target","",self.target.trigger.clone(),cx,|this,window,cx|this.target_toggle(window,cx))
                .max_w(px(170.)).h(px(24.)).min_w_0().px(px(7.)).gap(px(5.)).border_1().border_color(theme().border).font_weight(FontWeight(350.)).text_size(px(10.5))
                .when(self.pending||self.content!=self.server,|d|d.opacity(0.55).cursor_default())
                .child(div().min_w_0().whitespace_nowrap().overflow_hidden().text_ellipsis().child(name.to_owned()))
                .child(crate::icon::stroke("m6 9 6 6 6-6",theme().text_muted,10.,2.))
                .tooltip(move|_,cx|cx.new(|_|crate::icon::Tip(target_tip.clone().into())).into()))
            .child(control("spec-review","",cx,|this,_,cx|this.review(cx)).size(px(24.)).p_0()
                .child(crate::icon::stroke("m2 12 4 4 9-9m-5 5 4 4 9-9",self.preferences.ink(),15.,1.8))
                .tooltip(|_,cx|cx.new(|_|crate::icon::Tip("Ask o8 to review".into())).into())
                .when(self.reviewing,|d|d.opacity(0.5)))
            .child(focused("spec-settings","",self.settings_focus.clone(),cx,|this,window,cx|this.settings_toggle(window,cx)).size(px(24.)).p_0()
                .child(crate::icon::stroke("M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",theme().text_muted,14.,1.8))
                .tooltip(|_,cx|cx.new(|_|crate::icon::Tip("Notes settings".into())).into()))
            .into_any_element()
    }
    fn conflict_strip(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.conflict.as_ref()?;
        Some(
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
                    control("spec-conflict-reload", "Reload", cx, |this, _, cx| {
                        if !this.saving {
                            this.reload_conflict(cx);
                        }
                    })
                    .min_h(px(44.))
                    .when(self.saving, |d| d.opacity(0.6)),
                )
                .child(
                    control(
                        "spec-conflict-overwrite",
                        if self.saving {
                            "Overwriting…"
                        } else {
                            "Overwrite"
                        },
                        cx,
                        |this, _, cx| {
                            if !this.saving {
                                this.persist(true, cx);
                            }
                        },
                    )
                    .min_h(px(44.))
                    .text_color(theme().danger)
                    .when(self.saving, |d| d.opacity(0.6)),
                )
                .into_any_element(),
        )
    }
    fn frame(&self) -> AnyElement {
        div()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .flex()
            .p(px(14.))
            .child(
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
                    .when(
                        !self.loading && self.loaded_once && !self.workspace.is_empty(),
                        |d| {
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
                        },
                    )
                    .when(!self.loading && self.workspace.is_empty(), |d| {
                        d.child(
                            div()
                                .p(px(18.))
                                .text_size(px(12.))
                                .text_color(theme().text_muted)
                                .child("Select a repo to edit o8.md."),
                        )
                    })
                    .when(
                        !self.loading && !self.loaded_once && !self.workspace.is_empty(),
                        |d| {
                            d.child(
                                div()
                                    .p(px(18.))
                                    .text_size(px(12.))
                                    .text_color(theme().text_muted)
                                    .child("Unable to load notes. Retry to open the document."),
                            )
                        },
                    ),
            )
            .into_any_element()
    }
    pub(super) fn close_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings {
            self.settings_focus.focus(window);
        } else {
            self.target.trigger.focus(window);
        }
        self.settings = false;
        self.target.open = false;
        cx.notify();
    }
}
