//! Read-only shipped-feature audit. Account probes and developer authorization stay separate.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, prelude::*, px};

#[derive(Default)]
pub(super) struct State {
    busy: bool,
    audit: Option<Audit>,
    error: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    shipped_dark_audit: Audit,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Audit {
    status: String,
    checked_at: String,
    current_release: Option<String>,
    threshold_releases: u64,
    checked_flag_count: u64,
    attention_flag_count: u64,
    flags: Vec<Flag>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Flag {
    toml_key: String,
    operator_value_source: String,
    landed_release: Option<String>,
    dark_for_releases: Option<u64>,
    lifecycle: Option<String>,
    lifecycle_rationale: Option<String>,
    needs_attention: bool,
}
impl Settings {
    pub(super) fn load_diagnostics(&mut self, force: bool, cx: &mut Context<Self>) {
        if self.diagnostics.busy
            || !force && (self.diagnostics.audit.is_some() || self.diagnostics.error.is_some())
        {
            return;
        }
        self.diagnostics.busy = true;
        self.diagnostics.audit = None;
        self.diagnostics.error = None;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            client.settings_request::<Status>("GET", "/api/panel/status", Value::Null)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.diagnostics.busy = false;
                match result {
                    Ok(status)
                        if matches!(
                            status.shipped_dark_audit.status.as_str(),
                            "current" | "unverified" | "attention"
                        ) =>
                    {
                        this.diagnostics.audit = Some(status.shipped_dark_audit)
                    }
                    _ => {
                        this.diagnostics.error =
                            Some("Feature diagnostics are unavailable. Refresh to retry.".into())
                    }
                }
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    pub(super) fn diagnostics_view(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut content = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child("Shipped feature audit")
            .child(
                self.button(
                    "setting-diagnostics-refresh".into(),
                    if self.diagnostics.busy {
                        "Checking…"
                    } else {
                        "Refresh audit"
                    }
                    .into(),
                    !self.diagnostics.busy,
                    false,
                    window,
                    cx,
                    |this, _, cx| this.load_diagnostics(true, cx),
                ),
            );
        if let Some(error) = &self.diagnostics.error {
            content = content.child(div().text_color(theme().danger).child(error.clone()));
        }
        if let Some(audit) = &self.diagnostics.audit {
            let state = match audit.status.as_str() {
                "current" => "Current",
                "attention" => "Needs attention",
                _ => "Unverified",
            };
            content = content.child(panels::fact("settings-audit-status", "Default-off feature flags", state))
                .child(panels::fact("settings-audit-checked", "Last checked", if audit.status == "unverified" { "Not yet recorded" } else { &audit.checked_at }))
                .child(panels::fact("settings-audit-release", "Release", audit.current_release.as_deref().unwrap_or("Unknown")))
                .child(panels::fact("settings-audit-count", "Flags checked / needing attention", &format!("{} / {}", audit.checked_flag_count, audit.attention_flag_count)))
                .child(div().text_size(px(11.)).text_color(theme().text_muted).child(format!("Promotion candidates are flagged after {} releases. Features off by design remain listed without warning.", audit.threshold_releases)));
            for flag in &audit.flags {
                let lifecycle = match flag.lifecycle.as_deref() {
                    Some("promotion-candidate") => "Awaiting promotion review",
                    Some("deliberate-default-off") => "Off by design",
                    Some("promoted") => "Promoted",
                    _ => "Lifecycle unknown",
                };
                let age = flag
                    .dark_for_releases
                    .map(|age| format!("{age} releases"))
                    .unwrap_or("Age unknown".into());
                content = content.child(
                    div()
                        .debug_selector({
                            let key = flag.toml_key.clone();
                            move || format!("settings-audit-flag-{key}")
                        })
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .py(px(12.))
                        .border_b_1()
                        .border_color(theme().border)
                        .child(
                            div()
                                .text_color(if flag.needs_attention {
                                    theme().warning
                                } else {
                                    theme().text
                                })
                                .child(flag.toml_key.clone()),
                        )
                        .child(
                            div()
                                .text_size(px(11.))
                                .text_color(theme().text_muted)
                                .child(format!(
                                    "{lifecycle} · {age} · landed {} · {}",
                                    flag.landed_release.as_deref().unwrap_or("unknown"),
                                    flag.operator_value_source
                                )),
                        )
                        .when_some(flag.lifecycle_rationale.clone(), |row, why| {
                            row.child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(theme().text_muted)
                                    .child(why),
                            )
                        }),
                );
            }
        } else if self.diagnostics.busy {
            content = content.child("Reading feature diagnostics…");
        }
        content
            .child("Maintenance")
            .child(panels::fact(
                "settings-transcript-retention",
                "Archive old Codex sessions",
                "Managed by the provider",
            ))
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child("External transcript retention uses the provider's supported controls."),
            )
            .into_any_element()
    }
}
#[cfg(test)]
#[path = "settings_diagnostics_tests.rs"]
mod tests;
