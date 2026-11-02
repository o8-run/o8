//! Settings › MCP: connect other apps to o8, as classic's Clients group does.
//! Connect and Remove edit that app's own config, so each runs only on a click.
use super::providers::call;
use crate::client::Client;
use crate::theme::current as theme;
use gpui::{Context, IntoElement, Render, SharedString, Window, div, prelude::*, px};
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};

const CONFIG: &str = "/api/setup/mcp-config";
const CLAUDE: &str = "/api/setup/claude-desktop";
const EXTERNAL: &str = "/api/setup/external-client";
const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, PartialEq)]
struct Target {
    id: &'static str,
    label: &'static str,
    route: &'static str,
    restart: &'static str,
}

const TARGETS: [Target; 4] = [
    Target {
        id: "claude-desktop",
        label: "Claude Desktop",
        route: CLAUDE,
        restart: "Quit Claude Desktop and reopen it.",
    },
    Target {
        id: "claude-code",
        label: "Claude Code",
        route: CLAUDE,
        restart: "Restart Claude Code or run /mcp reload.",
    },
    Target {
        id: "hermes",
        label: "Hermes Agent",
        route: EXTERNAL,
        restart: "Run /reload-mcp inside Hermes to load the o8 tools.",
    },
    Target {
        id: "openclaw",
        label: "OpenClaw",
        route: EXTERNAL,
        restart: "Restart your OpenClaw gateway to pick up the new server.",
    },
];

#[derive(Debug, PartialEq)]
struct Row {
    line: String,
    /// The primary action, or None when there is nothing to do.
    action: Option<&'static str>,
    removable: bool,
}

/// What a client's status means, in classic's words.
fn row(target: Target, status: &Value) -> Row {
    if target.route == EXTERNAL {
        let installed = status["installed"] == true;
        let registered = status["registered"] == true;
        return Row {
            line: match (installed, registered) {
                (false, _) => format!("{} CLI not found.", target.label),
                (true, true) => format!("Connected. The o8 tools are wired into {}.", target.label),
                (true, false) => format!("Ready to connect. {} CLI detected.", target.label),
            },
            action: (installed && !registered).then_some("Connect"),
            removable: registered,
        };
    }
    let connected = status["alreadyUpToDate"] == true;
    let registered = status["alreadyRegistered"] == true;
    if status["setupReady"] == false {
        return Row {
            line: status["setupBlockedDetail"]
                .as_str()
                .unwrap_or("Finish first launch, then connect again.")
                .to_owned(),
            action: None,
            removable: registered,
        };
    }
    let others = status["otherServers"].as_array().map_or(0, Vec::len);
    Row {
        line: if connected {
            "Connected. o8 tools available in this client.".into()
        } else if registered {
            "Older o8 entry found. Update to the current config.".into()
        } else if status["fileExists"] == true && others > 0 {
            format!(
                "Ready to connect ({others} other server{})",
                if others == 1 { "" } else { "s" }
            )
        } else if status["fileExists"] == true {
            "Ready to connect".into()
        } else {
            "Not connected yet.".into()
        },
        action: (!connected).then_some(if registered { "Update" } else { "Connect" }),
        removable: registered,
    }
}

pub(crate) struct Mcp {
    client: Client,
    statuses: HashMap<&'static str, Value>,
    notes: HashMap<&'static str, String>,
    details: Vec<(&'static str, String)>,
    pub error: Option<String>,
    pub loading: bool,
    busy: Option<&'static str>,
    generation: u64,
}

impl Mcp {
    pub fn new(client: Client, cx: &mut Context<Self>) -> Self {
        let _ = cx;
        // Nothing is read until the page is first shown.
        Self {
            client,
            statuses: HashMap::new(),
            notes: HashMap::new(),
            details: vec![],
            error: None,
            loading: false,
            busy: None,
            generation: 0,
        }
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        self.generation += 1;
        let generation = self.generation;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let config = client.get::<Value>(CONFIG, &[]);
            let statuses: Vec<_> = TARGETS
                .iter()
                .map(|target| {
                    let status = client.get::<Value>(target.route, &[("target", target.id)]);
                    (target.id, status)
                })
                .collect();
            (config, statuses)
        });
        cx.spawn(async move |this, cx| {
            let (config, statuses) = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.loading = false;
                this.error = config.as_ref().err().cloned();
                if let Ok(config) = &config {
                    let facts = &config["diagnostics"];
                    let fact = |key: &str| {
                        facts[key]
                            .as_str()
                            .map(str::to_owned)
                            .or_else(|| facts[key].as_u64().map(|port| port.to_string()))
                    };
                    this.details = [
                        ("Platform", fact("platform")),
                        ("Data directory", fact("dataDir")),
                        ("API port", fact("apiPort")),
                        ("Live port", fact("wsPort")),
                    ]
                    .into_iter()
                    .filter_map(|(label, value)| Some((label, value?)))
                    .collect();
                }
                for (id, status) in statuses {
                    match status {
                        Ok(status) => {
                            this.statuses.insert(id, status);
                        }
                        Err(_) => {
                            this.statuses.remove(id);
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn change(&mut self, target: Target, remove: bool, cx: &mut Context<Self>) {
        if self.busy.is_some() {
            return;
        }
        self.busy = Some(target.id);
        self.notes.remove(target.id);
        let client = self.client.clone();
        let body = if remove {
            json!({"target": target.id, "remove": true})
        } else {
            json!({"target": target.id})
        };
        let task = cx
            .background_executor()
            .spawn(async move { call::<Value>(&client, "POST", target.route, body, TIMEOUT) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = None;
                let note = match result {
                    Ok(reply) if reply["ok"] == true => {
                        let done = reply["detail"].as_str().unwrap_or(if remove {
                            "Removed."
                        } else {
                            "Connected."
                        });
                        if remove {
                            done.to_owned()
                        } else {
                            format!("{done} {}", target.restart)
                        }
                    }
                    Ok(reply) => reply["error"]
                        .as_str()
                        .or(reply["detail"].as_str())
                        .unwrap_or("o8 could not change this client.")
                        .to_owned(),
                    Err(error) => error,
                };
                this.notes.insert(target.id, note);
                this.load(cx);
            });
        })
        .detach();
        cx.notify();
    }

    fn action(
        &self,
        id: String,
        label: &'static str,
        target: Target,
        remove: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let enabled = self.busy.is_none();
        let selector = id.clone();
        div()
            .id(SharedString::from(id))
            .debug_selector(move || selector.clone())
            .flex_none()
            .px(px(8.))
            .py(px(2.))
            .rounded(px(6.))
            .text_size(px(11.))
            .border_1()
            .border_color(theme().border)
            .when(!enabled, |v| v.opacity(0.45))
            .when(enabled, |v| {
                v.cursor_pointer().hover(|v| v.bg(theme().hover))
            })
            .child(label)
            .on_click(cx.listener(move |this, _, _, cx| this.change(target, remove, cx)))
    }
}

impl Render for Mcp {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.generation == 0 {
            self.load(cx);
        }
        let muted = |text: String| {
            div()
                .text_size(px(11.))
                .text_color(theme().text_muted)
                .child(text)
        };
        let mut rows = Vec::new();
        for target in TARGETS {
            let line = self
                .statuses
                .get(target.id)
                .map(|status| row(target, status));
            let note = self.notes.get(target.id).cloned();
            let summary = line.as_ref().map_or_else(
                || {
                    if self.loading {
                        "Checking...".to_string()
                    } else {
                        "Could not read this client.".to_string()
                    }
                },
                |row| row.line.clone(),
            );
            let primary = line.as_ref().and_then(|row| row.action);
            let removable = line.as_ref().is_some_and(|row| row.removable);
            let id = target.id;
            rows.push(
                div()
                    .debug_selector(move || format!("settings-mcp-{id}"))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .p(px(10.))
                    .rounded(px(10.))
                    .border_1()
                    .border_color(theme().border)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(div().text_size(px(13.)).child(target.label))
                            .child(muted(summary))
                            .children(note.map(muted)),
                    )
                    .children(primary.map(|label| {
                        self.action(
                            format!("settings-mcp-install-{id}"),
                            label,
                            target,
                            false,
                            cx,
                        )
                    }))
                    .when(removable, |v| {
                        v.child(self.action(
                            format!("settings-mcp-remove-{id}"),
                            "Remove",
                            target,
                            true,
                            cx,
                        ))
                    }),
            );
        }
        let details: Vec<_> = self
            .details
            .iter()
            .map(|(label, value)| muted(format!("{label}: {}", crate::text::sanitize(value))))
            .collect();
        div()
            .id("settings-mcp")
            .debug_selector(|| "settings-mcp".into())
            .flex()
            .flex_col()
            .gap(px(10.))
            .max_w(px(620.))
            .child("MCP")
            .child(muted("Connect compatible apps to o8.".to_string()))
            .children(self.error.clone().map(muted))
            .child(muted("Clients".to_string()))
            .children(rows)
            .when(!details.is_empty(), |v| {
                v.child(div().mt(px(8.)).child(muted("System details".to_string())))
                    .children(details)
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude() -> Target {
        TARGETS[0]
    }

    #[test]
    fn a_connected_client_offers_only_removal() {
        let row = row(
            claude(),
            &json!({"alreadyUpToDate":true,"alreadyRegistered":true,"fileExists":true}),
        );
        assert_eq!(row.action, None);
        assert!(row.removable);
    }

    #[test]
    fn an_old_entry_updates_and_a_blocked_setup_offers_nothing() {
        let old = row(
            claude(),
            &json!({"alreadyRegistered":true,"fileExists":true}),
        );
        assert_eq!(old.action, Some("Update"));
        let blocked = row(
            claude(),
            &json!({"setupReady":false,"setupBlockedDetail":"Wait."}),
        );
        assert_eq!(blocked.line, "Wait.");
        assert_eq!(blocked.action, None);
    }

    #[test]
    fn a_missing_cli_cannot_be_connected() {
        let row = row(TARGETS[2], &json!({"installed":false}));
        assert_eq!(row.line, "Hermes Agent CLI not found.");
        assert_eq!(row.action, None);
        assert!(!row.removable);
    }
}
