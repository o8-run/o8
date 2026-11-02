//! Settings › Limits: a read-only page of each provider account's 5-hour and
//! weekly windows. It reads the same `/api/runtime/capacity` snapshot as the
//! rail gauge and classic o8's capacity rows, and renders it with the rail
//! card's sections, so the two never disagree.
use crate::client::Client;
use crate::theme::current as theme;
use gpui::{Context, IntoElement, Render, Window, div, prelude::*, px};
use serde_json::Value;

pub(crate) const CAPACITY: &str = "/api/runtime/capacity";

pub(crate) struct Limits {
    client: Client,
    pub snapshot: Option<Value>,
    /// The shown snapshot is the last good one, not this read's.
    pub stale: bool,
    pub error: Option<String>,
    pub loading: bool,
    generation: u64,
}

/// What a read produced, given the last good snapshot.
pub(crate) fn settle(
    result: Result<Value, String>,
    last: Option<Value>,
) -> (Option<Value>, bool, Option<String>) {
    match result {
        Ok(snapshot) if snapshot["capacities"].is_array() => (Some(snapshot), false, None),
        Ok(_) => (last.clone(), last.is_some(), Some("Usage response was malformed.".into())),
        Err(error) => (last.clone(), last.is_some(), Some(error)),
    }
}

impl Limits {
    pub fn new(client: Client, cx: &mut Context<Self>) -> Self {
        let _ = cx;
        // Nothing is read until the Limits page is first shown.
        Self {
            client,
            snapshot: None,
            stale: false,
            error: None,
            loading: false,
            generation: 0,
        }
    }

    pub fn load(&mut self, fresh: bool, cx: &mut Context<Self>) {
        self.loading = true;
        self.generation += 1;
        let generation = self.generation;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let query: &[(&str, &str)] = if fresh { &[("fresh", "1")] } else { &[] };
            client.get::<Value>(CAPACITY, query)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                let last = this
                    .snapshot
                    .clone()
                    .or_else(crate::shell::rail::last_usage_snapshot);
                (this.snapshot, this.stale, this.error) = settle(result, last);
                this.loading = false;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

impl Render for Limits {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.generation == 0 {
            self.load(false, cx);
        }
        let muted = |text: String| {
            div()
                .text_size(px(11.))
                .text_color(theme().text_muted)
                .child(text)
        };
        let status = if self.loading {
            "Reading connected runtimes…".to_string()
        } else if self.stale {
            "Showing the last reading · stale".to_string()
        } else {
            "5-hour and weekly windows per account. Read-only.".to_string()
        };
        let sections = self
            .snapshot
            .as_ref()
            .map(crate::shell::rail::usage_sections)
            .unwrap_or_default();
        let empty = self.snapshot.as_ref().is_some_and(|s| {
            s["capacities"].as_array().is_none_or(|all| all.is_empty())
        });
        div()
            .id("settings-limits")
            .debug_selector(|| "settings-limits".into())
            .flex()
            .flex_col()
            .gap(px(14.))
            .max_w(px(520.))
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_baseline()
                    .gap(px(8.))
                    .child("Limits")
                    .child(
                        div()
                            .id("settings-limits-refresh")
                            .debug_selector(|| "settings-limits-refresh".into())
                            .px(px(8.))
                            .py(px(2.))
                            .rounded(px(6.))
                            .text_size(px(11.))
                            .border_1()
                            .border_color(theme().border)
                            .cursor_pointer()
                            .child("Refresh")
                            .on_click(cx.listener(|this, _, _, cx| this.load(true, cx))),
                    ),
            )
            .child(muted(status))
            .when_some(self.error.clone(), |v, error| {
                v.child(
                    div()
                        .debug_selector(|| "settings-limits-error".into())
                        .text_size(px(11.))
                        .text_color(if self.stale { theme().warning } else { theme().danger })
                        .child(error),
                )
            })
            .when(empty, |v| v.child(muted("No connected runtime reports usage yet.".into())))
            .children(sections)
    }
}

#[cfg(test)]
mod tests {
    use super::settle;
    use serde_json::json;

    fn fixture() -> serde_json::Value {
        json!({
            "schema": "o8/runtime-capacity-control/v1",
            "generatedAt": 1,
            "capacities": [
                {"runtime": "codex", "identityId": "c1", "status": "available", "reason": null,
                 "observedAt": "2026-11-01T17:00:00.000Z", "source": "codex-session-log", "confidence": "exact",
                 "buckets": [
                    {"id": "primary", "label": "5-hour", "usedRatio": 0.42, "used": null, "unit": null, "remaining": null, "resetsAt": "2026-11-01T20:00:00.000Z", "expiresAt": null},
                    {"id": "secondary", "label": "Weekly", "usedRatio": 0.81, "used": null, "unit": null, "remaining": null, "resetsAt": "2026-11-05T15:00:00.000Z", "expiresAt": null}
                 ]},
                {"runtime": "claude-code", "identityId": null, "status": "unavailable", "reason": "not_observed",
                 "observedAt": null, "source": null, "confidence": null, "buckets": []}
            ],
            "identities": [{"id": "c1", "runtime": "codex", "label": "Work", "selected": true}],
            "runtimes": []
        })
    }

    #[test]
    fn fresh_read_replaces_snapshot() {
        let (snapshot, stale, error) = settle(Ok(fixture()), None);
        assert_eq!(snapshot.unwrap()["capacities"][0]["buckets"][1]["label"], "Weekly");
        assert!(!stale);
        assert!(error.is_none());
    }

    #[test]
    fn failed_read_keeps_last_good_marked_stale() {
        let (snapshot, stale, error) = settle(Err("Request timed out".into()), Some(fixture()));
        assert!(snapshot.is_some());
        assert!(stale);
        assert_eq!(error.as_deref(), Some("Request timed out"));
    }

    #[test]
    fn failed_first_read_shows_error_only() {
        let (snapshot, stale, error) = settle(Ok(json!({"ok": false})), None);
        assert!(snapshot.is_none() && !stale && error.is_some());
    }
}
