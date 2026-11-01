use super::*;

/// An icon-only footer control: a 28px target with the label as its tooltip.
fn icon_only(button: Stateful<Div>, path: &str, color: gpui::Rgba, label: String) -> Stateful<Div> {
    let label = SharedString::from(label);
    button
        .w(px(28.))
        .h(px(28.))
        .px(px(0.))
        .justify_center()
        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(label.clone())).into())
        .child(crate::icon::stroke(path, color, 18., 1.6))
}

impl Surface {
    pub(crate) fn network_can_reply(&self) -> bool {
        self.routing.as_ref().is_none_or(|r| {
            r["source"] != "bot-network"
                || (r["network"]["canReply"] == true
                    && r["network"]["closed"] != true
                    && r["network"]["projectionError"].is_null())
        })
    }
    pub(crate) fn composer_footer(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let routing = self.composer_routing(cx).unwrap_or(Value::Null);
        if routing["source"] == "bot-network" {
            let label = if !routing["network"]["projectionError"].is_null() {
                "Transcript unavailable · refresh to retry".to_owned()
            } else if routing["network"]["canReply"] != true {
                "Peer exchange · read only".to_owned()
            } else if routing["network"]["closed"] == true {
                "Exchange closed".to_owned()
            } else {
                let target = self
                    .sessions
                    .iter()
                    .find(|s| Some(&s.id) == self.selected.as_ref());
                format!(
                    "Reply to {}",
                    target.map(|s| s.title.as_str()).unwrap_or("bot")
                )
            };
            return div()
                .id("network-composer-footer")
                .debug_selector(|| "network-composer-footer".into())
                .flex()
                .items_center()
                .justify_between()
                .w_full()
                .min_h(px(36.))
                .px(px(8.))
                .pb(px(8.))
                .text_size(px(12.))
                .text_color(theme().text_secondary)
                .child(label)
                .child(div().w(px(self.primary_width())).h(px(28.)).flex_shrink_0())
                .into_any_element();
        }
        let picked = routing["pickedMode"].as_str().unwrap_or("fast");
        let enabled = self.queue_ready
            && !self.saving
            && !self.composer.read(cx).controls.busy
            && self.composer.read(cx).controls.pending_images == 0;
        let leading = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(6.))
            // One attachments control (Q 2026-10-31): files, screenshots,
            // prompts, the worker checkout and permission all live in its
            // drawer, so the composer keeps only what you type with.
            .child(icon_only(
                self.track_prompt_anchor(
                    self.composer_button("composer-attach", "", enabled, cx, |s, w, cx| {
                        s.open_composer_picker("attach", w, cx)
                    }),
                    "attach",
                ),
                PAPERCLIP,
                theme().text_secondary,
                format!(
                    "Attach and settings · {}",
                    crate::composer::controls::mode_label(picked)
                ),
            ));
        let trailing = div()
            .flex()
            .items_center()
            .gap(px(6.))
            // The bars sit against the model name, one quiet group.
            .child(
                div()
                    .flex()
                    .items_center()
                    .child(self.track_prompt_anchor(self.lead_chip(&routing, enabled, cx), "model"))
                    .children(
                        self.thinking_chip(&routing, enabled, cx)
                            .map(|chip| self.track_prompt_anchor(chip, "effort")),
                    ),
            )
            // The round primary button sits over this slot from the card, so
            // the emptiness flip never re-renders the footer region.
            .child(div().w(px(self.primary_width())).h(px(28.)).flex_shrink_0());
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_end()
            .gap(px(6.))
            .min_h(px(36.))
            .pt(px(4.))
            .px(px(8.))
            .pb(px(8.))
            .child(leading)
            .child(self.context_meter(window, cx))
            .child(trailing)
            .into_any_element()
    }
}
