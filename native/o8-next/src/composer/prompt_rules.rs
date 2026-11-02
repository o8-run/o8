//! The classic Session / Repo / Global rule tiers, using their existing routes.
use super::prompt_view::small;
use super::*;
use gpui::{AnyElement, SharedString};

impl Surface {
    pub(super) fn rules_view(&self, cx: &mut Context<Self>) -> AnyElement {
        let state = &self.composer.read(cx).controls.prompt;
        let mut view = div().flex().flex_col().gap(px(6.));
        if let Some(query) = state.query.clone() {
            view = view.child(
                div()
                    .id("composer-rule-input")
                    .debug_selector(|| "composer-rule-input".into())
                    .child(query),
            );
        }
        let loading = state.loading;
        let error = state.error.clone();
        let rows = state.rows.clone();
        let remove = state.remove_rule.clone();
        let expanded = state.expanded_tiers.clone();
        view = view.child(self.composer_button(
            "composer-rule-add",
            "Add rule",
            !loading,
            cx,
            |s, _, cx| s.mutate_prompt_rule(None, cx),
        ));
        if loading {
            view = view.child(small("Loading rules…"));
        }
        if !error.is_empty() {
            view = view.child(small(error)).child(self.composer_button(
                "composer-rule-retry",
                "Retry",
                !loading,
                cx,
                |s, _, cx| s.load_prompt_rows("rules", cx),
            ));
        }
        let mut list = div()
            .id("composer-rule-list")
            .max_h(px(280.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(6.));
        for tier in ["Session", "Repo", "Global"] {
            let items: Vec<_> = rows.iter().filter(|r| r["tier"] == tier).collect();
            if tier != "Session" {
                let name = tier.to_owned();
                list = list.child(self.composer_button(
                    &format!("composer-rules-{tier}"),
                    &format!("{tier} · {} directives", items.len()),
                    !loading,
                    cx,
                    move |s, _, cx| {
                        s.composer.update(cx, |i, _| {
                            if !i.controls.prompt.expanded_tiers.remove(&name) {
                                i.controls.prompt.expanded_tiers.insert(name.clone());
                            }
                        });
                        cx.notify();
                    },
                ));
                if !expanded.contains(tier) {
                    continue;
                }
            } else {
                list = list.child(small("Session"));
                if items.is_empty() && !loading {
                    list = list.child(small("No session rules."));
                }
            }
            for row in items {
                let Some(id) = row["id"].as_str() else {
                    continue;
                };
                let id = id.to_owned();
                let row_key = SharedString::from(format!("composer-rule-{id}"));
                let mut line = div().p(px(6.)).flex().flex_col().gap(px(4.)).child(
                    div().text_size(px(12.)).child(
                        row[if tier == "Session" { "text" } else { "title" }]
                            .as_str()
                            .unwrap_or("")
                            .to_owned(),
                    ),
                );
                if tier == "Session" {
                    let confirming = remove.as_deref() == Some(&id);
                    let key = format!(
                        "composer-rule-{}-{id}",
                        if confirming { "confirm" } else { "remove" }
                    );
                    line = line.child(self.composer_button(
                        &key,
                        if confirming {
                            "Confirm remove"
                        } else {
                            "Remove"
                        },
                        !loading,
                        cx,
                        move |s, _, cx| {
                            if confirming {
                                s.mutate_prompt_rule(Some(id.clone()), cx);
                            } else {
                                s.composer.update(cx, |i, _| {
                                    i.controls.prompt.remove_rule = Some(id.clone())
                                });
                                cx.notify();
                            }
                        },
                    ));
                    if confirming {
                        line = line.child(self.composer_button(
                            "composer-rule-cancel",
                            "Cancel",
                            !loading,
                            cx,
                            |s, _, cx| {
                                s.composer
                                    .update(cx, |i, _| i.controls.prompt.remove_rule = None);
                                cx.notify();
                            },
                        ));
                    }
                }
                list = list.child(line.id(row_key));
            }
        }
        view.child(list).into_any_element()
    }

    pub(super) fn mutate_prompt_rule(&mut self, remove: Option<String>, cx: &mut Context<Self>) {
        let editor = self.composer.clone();
        if editor.read(cx).controls.prompt.loading {
            return;
        }
        let text = editor
            .read(cx)
            .controls
            .prompt
            .query
            .as_ref()
            .map(|q| q.read(cx).text.trim().to_owned())
            .unwrap_or_default();
        if remove.is_none() && text.is_empty() {
            return;
        }
        let Some(thread) = self.selected.clone() else {
            return;
        };
        let generation = editor.update(cx, |i, _| {
            i.controls.prompt.loading = true;
            i.controls.prompt.error.clear();
            i.controls.prompt.generation += 1;
            i.controls.prompt.generation
        });
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            if let Some(id) = remove {
                let mut url = client
                    .url("/api/orchestrator/session-rules")
                    .map_err(|e| e.to_string())?;
                url.query_pairs_mut().append_pair("id", &id);
                let value: Value = Client::read(
                    client
                        .request("DELETE", &url)
                        .call()
                        .map_err(|e| e.to_string())?,
                )?;
                if value["ok"] != true || value["result"]["removed"] != true {
                    return Err("The server did not confirm removal.".into());
                }
            } else {
                super::prompt_actions::post(
                    &client,
                    "/api/orchestrator/session-rules",
                    json!({"threadId":thread,"text":text}),
                )?;
            }
            Ok::<_, String>(())
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let apply = editor
                .update(cx, |i, cx| {
                    if i.controls.open != Some("rules")
                        || i.controls.prompt.generation != generation
                    {
                        return false;
                    }
                    i.controls.prompt.loading = false;
                    i.controls.prompt.remove_rule = None;
                    if let Err(error) = &result {
                        i.controls.prompt.error = error.clone();
                    } else if let Some(query) = &i.controls.prompt.query {
                        query.update(cx, |q, cx| q.clear(cx));
                    }
                    cx.notify();
                    true
                })
                .unwrap_or(false);
            let _ = this.update(cx, |s, cx| {
                if apply && result.is_ok() && s.composer == editor {
                    s.load_prompt_rows("rules", cx);
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}
