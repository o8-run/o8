//! Rail choices use the existing revision-checked native Settings write path.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, prelude::*, px};

impl Settings {
    pub(super) fn bot_rows(&mut self, window: &Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut rows = vec![
            div().child("Bots").into_any_element(),
            div()
                .text_size(px(11.))
                .text_color(theme().text_muted)
                .child(
                    "Add local bots to the rail below PRs. Hiding a bot keeps its conversations.",
                )
                .into_any_element(),
        ];
        let candidates = self
            .snapshot
            .as_ref()
            .map(|s| s.bots.clone())
            .unwrap_or_default();
        let selected: Vec<String> = self
            .snapshot
            .as_ref()
            .and_then(|s| s.values.get("botRailEnabledIds"))
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let field = crate::settings_fields::fields()
            .find(|f| f.id == "botRailEnabledIds")
            .unwrap();
        if candidates.is_empty() && !self.busy {
            rows.push(
                div()
                    .text_color(theme().text_muted)
                    .child("No local bots are available. Set up a local bot, then refresh.")
                    .into_any_element(),
            );
        }
        let query = self.search.read(cx).text.trim().to_lowercase();
        for bot in candidates.into_iter().filter(|b| {
            format!("{} {}", b.name, b.house)
                .to_lowercase()
                .contains(&query)
        }) {
            let on = bot.selection_ids.iter().any(|id| selected.contains(id));
            let member = bot.clone();
            let button = self.button(
                format!("settings-bot-{}", bot.id),
                if on { "Hide from rail" } else { "Add to rail" }.into(),
                !self.locked(field),
                on,
                window,
                cx,
                move |this, _, cx| {
                    // Build from the current snapshot; another row can have
                    // saved successfully since this control was painted.
                    let mut next: Vec<String> = this
                        .snapshot
                        .as_ref()
                        .and_then(|s| s.values.get(field.id))
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let enabled = member.selection_ids.iter().any(|id| next.contains(id));
                    next.retain(|id| !member.selection_ids.contains(id));
                    if !enabled {
                        next.push(member.id.clone());
                    }
                    this.set(field, json!(next), cx);
                },
            );
            rows.push(
                div()
                    .flex()
                    .items_center()
                    .gap(px(16.))
                    .py(px(16.))
                    .border_b_1()
                    .border_color(theme().border)
                    .child(
                        div().flex_1().min_w_0().child(bot.name).child(
                            div()
                                .text_size(px(11.))
                                .text_color(theme().text_muted)
                                .child(bot.house),
                        ),
                    )
                    .child(button)
                    .into_any_element(),
            );
        }
        rows
    }
}
