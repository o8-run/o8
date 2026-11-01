//! Adapter declarations for configured workers, without account or key inventory.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, prelude::*, px};

#[derive(Default)]
pub(super) struct State {
    runtime: Option<String>,
    busy: bool,
    reply: Option<Reply>,
    error: Option<String>,
}
#[derive(Deserialize)]
struct Reply {
    id: String,
    capabilities: Option<Capabilities>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    resume: Option<bool>,
    interrupt: Option<bool>,
    streaming: Option<bool>,
    review_diffs: Option<bool>,
    cost_telemetry: Option<bool>,
    session_transforms: Option<BTreeMap<String, bool>>,
    capacity: Option<Capacity>,
}
#[derive(Deserialize)]
struct Capacity {
    observe: Option<bool>,
}
impl Settings {
    fn configured_runtimes(&self) -> Vec<String> {
        let mut ids = vec![];
        if let Some(snapshot) = &self.snapshot {
            if let Some(preferred) = snapshot
                .values
                .get("defaultDispatchRuntime")
                .and_then(Value::as_str)
            {
                ids.push(preferred.to_owned());
            }
            for id in snapshot
                .values
                .get("workerRuntimes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if !ids.iter().any(|existing| existing == id) {
                    ids.push(id.to_owned());
                }
            }
        }
        ids
    }
    pub(super) fn load_connections(&mut self, force: bool, cx: &mut Context<Self>) {
        let ids = self.configured_runtimes();
        let id = self
            .connections
            .runtime
            .as_ref()
            .filter(|id| ids.contains(id))
            .cloned()
            .or_else(|| ids.first().cloned());
        let Some(id) = id else {
            return;
        };
        if self.connections.busy
            || !force
                && self.connections.runtime.as_ref() == Some(&id)
                && (self.connections.reply.is_some() || self.connections.error.is_some())
        {
            return;
        }
        self.connections.runtime = Some(id.clone());
        self.connections.busy = true;
        self.connections.error = None;
        self.connections.reply = None;
        let client = self.client.clone();
        let encoded: String = url::form_urlencoded::byte_serialize(id.as_bytes()).collect();
        let task = cx.background_executor().spawn(async move {
            client.settings_request::<Reply>(
                "GET",
                &format!("/api/runtime/capabilities?id={encoded}"),
                Value::Null,
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.connections.runtime.as_ref() != Some(&id) {
                    return;
                }
                this.connections.busy = false;
                match result {
                    Ok(reply) if reply.id == id => this.connections.reply = Some(reply),
                    _ => {
                        this.connections.error =
                            Some("Could not read the adapter. Refresh to retry.".into())
                    }
                }
                this.load_connections(false, cx);
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    pub(super) fn connections_view(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut content = div().flex().flex_col().gap(px(16.)).child("Adapter capabilities")
            .child(div().text_size(px(11.)).text_color(theme().text_muted).child("Inspect the configured workers' declared actions. Capabilities do not prove a connected session or remaining allowance."));
        let ids = self.configured_runtimes();
        if ids.is_empty() {
            return content
                .child("No configured workers were reported. Refresh settings to try again.")
                .into_any_element();
        }
        let mut choices = div().flex().flex_wrap().gap(px(8.));
        for id in ids {
            let selected = self.connections.runtime.as_ref() == Some(&id);
            let label = if id == "claude-code" {
                "Claude Code"
            } else if id == "codex" {
                "Codex"
            } else {
                id.as_str()
            }
            .to_owned();
            choices = choices.child(self.button(
                format!("setting-connection-{id}"),
                label,
                !self.connections.busy,
                selected,
                window,
                cx,
                move |this, _, cx| {
                    this.connections.runtime = Some(id.clone());
                    this.load_connections(true, cx);
                },
            ));
        }
        content = content.child(choices).child(
            self.button(
                "setting-connections-refresh".into(),
                if self.connections.busy {
                    "Checking…"
                } else {
                    "Refresh capabilities"
                }
                .into(),
                !self.connections.busy,
                false,
                window,
                cx,
                |this, _, cx| this.load_connections(true, cx),
            ),
        );
        if let Some(error) = &self.connections.error {
            content = content.child(div().text_color(theme().danger).child(error.clone()));
        }
        let caps = self
            .connections
            .reply
            .as_ref()
            .and_then(|reply| reply.capabilities.as_ref());
        let actions = caps
            .map(|caps| {
                [
                    (caps.resume, "Follow-up messages"),
                    (caps.interrupt, "Stop"),
                    (caps.streaming, "Live output"),
                    (caps.review_diffs, "Changes"),
                ]
                .into_iter()
                .filter_map(|(yes, label)| (yes == Some(true)).then_some(label))
                .collect::<Vec<_>>()
                .join(", ")
            })
            .unwrap_or_default();
        let transforms = caps
            .and_then(|caps| caps.session_transforms.as_ref())
            .map(|actions| {
                actions
                    .iter()
                    .filter_map(|(label, enabled)| enabled.then_some(label.as_str()))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        let unknown = if self.connections.busy {
            "Checking…"
        } else {
            "Not reported"
        };
        content
            .child(panels::fact(
                "settings-capability-actions",
                "Worker actions",
                if actions.is_empty() {
                    unknown
                } else {
                    &actions
                },
            ))
            .child(panels::fact(
                "settings-capability-transforms",
                "Session transforms",
                if transforms.is_empty() {
                    unknown
                } else {
                    &transforms
                },
            ))
            .child(panels::fact(
                "settings-capability-usage",
                "Usage",
                if caps.and_then(|c| c.cost_telemetry) == Some(true) {
                    "Reported when available"
                } else {
                    unknown
                },
            ))
            .child(panels::fact(
                "settings-capability-limits",
                "Account limits",
                if caps
                    .and_then(|c| c.capacity.as_ref())
                    .and_then(|c| c.observe)
                    == Some(true)
                {
                    "Provider observations supported"
                } else {
                    unknown
                },
            ))
            .into_any_element()
    }
}
#[cfg(test)]
#[path = "settings_connections_tests.rs"]
mod tests;
