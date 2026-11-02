//! Settings › Machines: this computer, saved SSH machines and machines linked
//! to the account, in one read-only list. It is the base for choosing where a
//! thread runs. Registry membership never claims a machine is reachable; only
//! Check reaches one.
use crate::client::Client;
use crate::theme::current as theme;
use gpui::{Context, IntoElement, Render, Window, div, prelude::*, px};
use serde_json::Value;
use std::collections::HashMap;

pub(crate) const SSH_MACHINES: &str = "/api/panel/ssh-machines";
pub(crate) const CONNECT: &str = "/api/panel/connect";

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Machine {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub ssh: bool,
    pub current: bool,
}

/// One list from both sources. The current machine leads, and a linked machine
/// that is this install is not repeated.
pub(crate) fn merged(ssh: &Value, connect: &Value) -> Vec<Machine> {
    let current = connect["currentMachineId"].as_str();
    let mut machines: Vec<Machine> = connect["devices"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|device| {
            let id = device["machineId"].as_str()?;
            let platform = device["platform"].as_str().unwrap_or("Unknown platform");
            let version = device["appVersion"].as_str().unwrap_or("unknown");
            Some(Machine {
                id: id.to_owned(),
                label: device["name"].as_str().unwrap_or(id).to_owned(),
                detail: format!("{platform} · o8 {version}"),
                ssh: false,
                current: Some(id) == current,
            })
        })
        .collect();
    if !machines.iter().any(|machine| machine.current) {
        machines.insert(
            0,
            Machine {
                id: "local".into(),
                label: "This computer".into(),
                detail: "Local".into(),
                ssh: false,
                current: true,
            },
        );
    }
    machines.sort_by_key(|machine| !machine.current);
    machines.extend(
        ssh["machines"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|machine| machine["enabled"] != false)
            .filter_map(|machine| {
                Some(Machine {
                    id: machine["id"].as_str()?.to_owned(),
                    label: machine["label"].as_str()?.to_owned(),
                    detail: format!("SSH · {}", machine["target"].as_str()?),
                    ssh: true,
                    current: false,
                })
            }),
    );
    machines
}

/// The answer to a Check: a machine that lists terminals is reachable.
pub(crate) fn check_result(result: Result<Value, String>) -> String {
    match result {
        Ok(reply) => {
            let count = reply["sessions"].as_array().map_or(0, Vec::len);
            format!(
                "Reachable · {count} terminal{}",
                if count == 1 { "" } else { "s" }
            )
        }
        Err(_) => "Could not reach this machine.".into(),
    }
}

pub(crate) struct Machines {
    client: Client,
    pub machines: Vec<Machine>,
    pub checks: HashMap<String, String>,
    pub note: Option<String>,
    pub loading: bool,
    generation: u64,
}

impl Machines {
    pub fn new(client: Client, cx: &mut Context<Self>) -> Self {
        let _ = cx;
        // Nothing is read until the page is first shown.
        Self {
            client,
            machines: vec![],
            checks: HashMap::new(),
            note: None,
            loading: false,
            generation: 0,
        }
    }

    pub fn load(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        self.generation += 1;
        let generation = self.generation;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let ssh = client.get::<Value>(SSH_MACHINES, &[]);
            let url = client.url(CONNECT).map_err(|_| "Invalid route".to_string());
            let connect = url.and_then(|url| {
                client
                    .with_desktop_identity(client.request("GET", &url))
                    .call()
                    .map_err(|_| "Could not read linked machines".to_string())
                    .and_then(Client::read::<Value>)
            });
            (ssh, connect)
        });
        cx.spawn(async move |this, cx| {
            let (ssh, connect) = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.loading = false;
                let linked = connect.as_ref().ok().filter(|reply| reply["ok"] == true);
                this.note = match (&ssh, linked) {
                    (Err(error), _) => Some(error.clone()),
                    (Ok(_), None) => Some("Sign in to see machines linked to your account.".into()),
                    _ => None,
                };
                this.machines = merged(
                    ssh.as_ref().unwrap_or(&Value::Null),
                    linked.unwrap_or(&Value::Null),
                );
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn check(&mut self, id: String, cx: &mut Context<Self>) {
        self.checks.insert(id.clone(), "Checking…".into());
        let client = self.client.clone();
        let target = id.clone();
        let task = cx.background_executor().spawn(async move {
            client.get::<Value>(SSH_MACHINES, &[("machine", target.as_str())])
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.checks.insert(id, check_result(result));
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

impl Render for Machines {
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
        let rows: Vec<_> = self
            .machines
            .clone()
            .into_iter()
            .enumerate()
            .map(|(index, machine)| {
                let id = machine.id.clone();
                let status = self.checks.get(&machine.id).cloned();
                div()
                    .debug_selector(move || format!("settings-machine-{index}"))
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
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .child(crate::text::sanitize(&machine.label)),
                            )
                            .child(muted(crate::text::sanitize(&machine.detail)))
                            .children(status.map(muted)),
                    )
                    .when(machine.ssh, |row| {
                        row.child(
                            div()
                                .id(("settings-machine-check", index))
                                .debug_selector(move || format!("settings-machine-check-{index}"))
                                .flex_none()
                                .px(px(8.))
                                .py(px(2.))
                                .rounded(px(6.))
                                .text_size(px(11.))
                                .border_1()
                                .border_color(theme().border)
                                .cursor_pointer()
                                .child("Check")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.check(id.clone(), cx)
                                })),
                        )
                    })
            })
            .collect();
        div()
            .id("settings-machines")
            .debug_selector(|| "settings-machines".into())
            .flex()
            .flex_col()
            .gap(px(10.))
            .max_w(px(520.))
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_baseline()
                    .gap(px(8.))
                    .child("Machines")
                    .child(
                        div()
                            .id("settings-machines-refresh")
                            .debug_selector(|| "settings-machines-refresh".into())
                            .px(px(8.))
                            .py(px(2.))
                            .rounded(px(6.))
                            .text_size(px(11.))
                            .border_1()
                            .border_color(theme().border)
                            .cursor_pointer()
                            .child("Refresh")
                            .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
                    ),
            )
            .child(muted(if self.loading {
                "Reading machines…".to_string()
            } else {
                "Add SSH machines with `o8 machine add`.".to_string()
            }))
            .children(self.note.clone().map(muted))
            .children(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_current_machine_leads_and_ssh_machines_follow() {
        let list = merged(
            &json!({"machines":[
                {"id":"a","label":"Box","target":"me@box","enabled":true},
                {"id":"b","label":"Off","target":"off","enabled":false}
            ]}),
            &json!({"currentMachineId":"m2","devices":[
                {"machineId":"m1","name":"Studio","platform":"darwin","appVersion":"1"},
                {"machineId":"m2","name":"iMac","platform":"darwin","appVersion":"2"}
            ]}),
        );
        let labels: Vec<_> = list.iter().map(|m| m.label.as_str()).collect();
        assert_eq!(labels, ["iMac", "Studio", "Box"]);
        assert!(list[0].current && list[2].ssh);
    }

    #[test]
    fn signed_out_still_shows_this_computer() {
        let list = merged(&Value::Null, &Value::Null);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label, "This computer");
    }

    #[test]
    fn a_failed_check_never_claims_the_machine_is_reachable() {
        assert_eq!(check_result(Err("x".into())), "Could not reach this machine.");
        assert_eq!(check_result(Ok(json!({"sessions":[{}]}))), "Reachable · 1 terminal");
    }
}
