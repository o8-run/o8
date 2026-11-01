//! Settings › Providers: one provider instance (T3's "Codex · work").
//!
//! An instance is a saved copy of a runtime with its own display name, binary,
//! home directory and environment. The server keeps the non-secret fields in
//! `~/.o8/provider-instances.json` and env in the encrypted ACP env store; this
//! panel only ever receives secrets as `{secret: true, configured: true}`.
//! Writes go through `POST /api/runtime/provider-instances` and every read and
//! write uses the settings path (`client.settings_request`, 15s).
use crate::{client::Client, composer::Composer, theme::current as theme};
use gpui::{
    div, prelude::*, px, AnyElement, Context, Div, Entity, EventEmitter, FocusHandle, IntoElement,
    KeyDownEvent, ParentElement, Render, Stateful, Styled, Subscription, Window,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, rc::Rc};

pub(crate) const INSTANCES: &str = "/api/runtime/provider-instances";

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub(crate) struct EnvVar {
    pub name: String,
    #[serde(default)]
    pub secret: bool,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub configured: bool,
}
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub(crate) struct Environment {
    pub revision: u64,
    #[serde(default)]
    pub variables: Vec<EnvVar>,
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Instance {
    pub id: String,
    pub runtime: String,
    pub name: String,
    #[serde(default)]
    pub binary_path: Option<String>,
    #[serde(default)]
    pub home_dir: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub default: bool,
    #[serde(default)]
    pub acp: Option<Value>,
    #[serde(default)]
    pub environment: Option<Environment>,
}
fn yes() -> bool {
    true
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Listing {
    #[serde(default)]
    pub instances: Vec<Instance>,
    #[serde(default)]
    pub home_selectors: BTreeMap<String, String>,
}

/// "Codex · work"; the Local ACP slot reads "Local ACP · <agent>".
pub(crate) fn label(runtime_label: &str, instance: &Instance) -> String {
    format!("{runtime_label} · {}", instance.name)
}
/// The binary an instance runs: its override, or an ACP agent's command.
pub(crate) fn binary(instance: &Instance) -> String {
    instance
        .acp
        .as_ref()
        .and_then(|a| a["command"].as_str().map(str::to_owned))
        .or_else(|| instance.binary_path.clone())
        .unwrap_or_default()
}
/// Env rows as the server's env editor expects them: a saved secret with no
/// new value keeps its encrypted value; blank rows are dropped.
pub(crate) fn env_body(rows: &[(String, String, bool, bool)]) -> Value {
    let variables: Vec<Value> = rows
        .iter()
        .filter(|(name, _, _, _)| !name.trim().is_empty())
        .map(|(name, value, secret, configured)| {
            if *secret && *configured && value.is_empty() {
                json!({"name": name.trim(), "secret": true})
            } else {
                json!({"name": name.trim(), "secret": secret, "value": value})
            }
        })
        .collect();
    Value::Array(variables)
}
/// The `update` body. ACP instances keep their arguments; the binary field
/// edits the agent command.
pub(crate) fn update_body(instance: &Instance, name: &str, binary: &str, home: &str) -> Value {
    let mut fields =
        json!({"name": name.trim(), "homeDir": home.trim(), "enabled": instance.enabled});
    match &instance.acp {
        Some(acp) => {
            let mut acp = acp.clone();
            acp["command"] = json!(binary.trim());
            fields["acp"] = acp;
        }
        None => fields["binaryPath"] = json!(binary.trim()),
    }
    json!({"action": "update", "id": instance.id, "instance": fields})
}

pub(crate) enum InstanceEvent {
    Saved,
    Deleted,
}
impl EventEmitter<InstanceEvent> for InstanceDetail {}

pub(crate) struct EnvRow {
    pub name: Entity<Composer>,
    pub value: Entity<Composer>,
    pub secret: bool,
    /// A saved secret: its value is never sent here, only replaced.
    pub configured: bool,
}

pub(crate) struct InstanceDetail {
    client: Client,
    pub instance: Instance,
    runtime_label: String,
    selector: Option<String>,
    name: Entity<Composer>,
    binary: Entity<Composer>,
    home: Entity<Composer>,
    pub env: Vec<EnvRow>,
    pub busy: bool,
    pub confirm_delete: bool,
    pub notice: String,
    pub error: Option<String>,
    controls: BTreeMap<String, FocusHandle>,
    subscriptions: Vec<Subscription>,
    pub revision_count: u64,
}

fn input(placeholder: &str, text: &str, cx: &mut Context<InstanceDetail>) -> Entity<Composer> {
    let field = cx.new(|cx| {
        let mut field = Composer::new(cx);
        field.inline = true;
        field.placeholder = placeholder.into();
        field.set_text(text, cx);
        field
    });
    field
}

impl InstanceDetail {
    pub fn new(
        client: Client,
        instance: Instance,
        runtime_label: String,
        selector: Option<String>,
        cx: &mut Context<Self>,
    ) -> Self {
        let name = input("Display name", &instance.name, cx);
        let binary = input(
            "Absolute path (empty: the detected CLI)",
            &binary(&instance),
            cx,
        );
        let home = input(
            "Absolute path (empty: the runtime default)",
            instance.home_dir.as_deref().unwrap_or(""),
            cx,
        );
        let mut view = Self {
            client,
            instance,
            runtime_label,
            selector,
            name,
            binary,
            home,
            env: vec![],
            busy: false,
            confirm_delete: false,
            notice: String::new(),
            error: None,
            controls: BTreeMap::new(),
            subscriptions: vec![],
            revision_count: 0,
        };
        for field in [view.name.clone(), view.binary.clone(), view.home.clone()] {
            view.subscriptions
                .push(cx.observe(&field, |this, _, cx| this.changed(cx)));
        }
        let variables = view
            .instance
            .environment
            .clone()
            .map(|e| e.variables)
            .unwrap_or_default();
        for var in variables {
            view.push_row(&var, cx);
        }
        view
    }
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.revision_count += 1;
        cx.notify();
    }
    fn push_row(&mut self, var: &EnvVar, cx: &mut Context<Self>) {
        let name = input("NAME", &var.name, cx);
        let placeholder = if var.secret && var.configured {
            "•••••• saved (type to replace)"
        } else {
            "value"
        };
        let value = input(placeholder, var.value.as_deref().unwrap_or(""), cx);
        for field in [&name, &value] {
            self.subscriptions
                .push(cx.observe(field, |this, _, cx| this.changed(cx)));
        }
        self.env.push(EnvRow {
            name,
            value,
            secret: var.secret,
            configured: var.secret && var.configured,
        });
    }
    pub fn add_row(&mut self, cx: &mut Context<Self>) {
        self.push_row(&EnvVar::default(), cx);
        self.changed(cx);
    }
    fn rows(&self, cx: &gpui::App) -> Vec<(String, String, bool, bool)> {
        self.env
            .iter()
            .map(|r| {
                (
                    r.name.read(cx).text.clone(),
                    r.value.read(cx).text.clone(),
                    r.secret,
                    r.configured,
                )
            })
            .collect()
    }
    /// Fields first (not for the Local ACP slot, edited by its own form), then
    /// env against the revision this panel read.
    pub fn save(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        self.notice = "Saving…".into();
        let client = self.client.clone();
        let fields = (!self.instance.default).then(|| {
            update_body(
                &self.instance,
                &self.name.read(cx).text,
                &self.binary.read(cx).text,
                &self.home.read(cx).text,
            )
        });
        let id = self.instance.id.clone();
        let revision = self
            .instance
            .environment
            .as_ref()
            .map(|e| e.revision)
            .unwrap_or(0);
        let env = env_body(&self.rows(cx));
        let task = cx.background_executor().spawn(async move {
            if let Some(fields) = fields {
                let _: serde::de::IgnoredAny = client
                    .settings_request("POST", INSTANCES, fields)
                    .map_err(|e| e.message)?;
            }
            let saved: Environment = client
                .settings_request(
                    "POST",
                    INSTANCES,
                    json!({"action": "env", "id": id, "environment": {"revision": revision, "variables": env}}),
                )
                .map_err(|e| e.message)?;
            Ok::<_, String>(saved)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(environment) => {
                        this.instance.environment = Some(environment);
                        this.notice = "Saved. New sessions on this instance use it.".into();
                        cx.emit(InstanceEvent::Saved);
                    }
                    Err(error) => {
                        this.notice.clear();
                        this.error = Some(error);
                    }
                }
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    pub fn delete(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.instance.default {
            return;
        }
        if !self.confirm_delete {
            self.confirm_delete = true;
            return self.changed(cx);
        }
        self.busy = true;
        let client = self.client.clone();
        let id = self.instance.id.clone();
        let task = cx.background_executor().spawn(async move {
            client
                .settings_request::<serde::de::IgnoredAny>(
                    "POST",
                    INSTANCES,
                    json!({"action": "delete", "id": id}),
                )
                .map(|_| ())
                .map_err(|e| e.message)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                this.confirm_delete = false;
                match result {
                    Ok(()) => cx.emit(InstanceEvent::Deleted),
                    Err(error) => this.error = Some(error),
                }
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }

    fn focus(&mut self, id: &str, cx: &mut Context<Self>) -> FocusHandle {
        self.controls
            .entry(id.to_owned())
            .or_insert_with(|| cx.focus_handle())
            .clone()
    }
    fn control(
        &mut self,
        id: String,
        enabled: bool,
        window: &Window,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> Stateful<Div> {
        let focus = self.focus(&id, cx);
        let focused = focus.is_focused(window);
        let action = Rc::new(action);
        let key_action = action.clone();
        div()
            .id(gpui::SharedString::from(id.clone()))
            .debug_selector(move || id.clone())
            .track_focus(&focus)
            .tab_stop(enabled)
            .when(focused, |v| v.border_1().border_color(theme().accent))
            .when(enabled, |v| v.cursor_pointer())
            .when(!enabled, |v| v.opacity(0.45))
            .on_click(cx.listener(move |this, _, _, cx| {
                cx.stop_propagation();
                if enabled {
                    action(this, cx);
                }
            }))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                if enabled && matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    key_action(this, cx);
                    cx.stop_propagation();
                }
            }))
    }
    fn button(
        &mut self,
        id: String,
        label: &'static str,
        tone: Option<gpui::Rgba>,
        enabled: bool,
        window: &Window,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> AnyElement {
        self.control(id, enabled, window, cx, action)
            .h(px(26.))
            .px(px(10.))
            .flex()
            .flex_shrink_0()
            .items_center()
            .rounded(px(7.))
            .text_size(px(12.))
            .bg(tone.unwrap_or(theme().surface_raised))
            .when(tone.is_some(), |v| v.text_color(gpui::white()))
            .hover(|v| v.bg(theme().hover))
            .child(label)
            .into_any_element()
    }
    fn field(selector: String, input: &Entity<Composer>, cx: &gpui::App) -> Stateful<Div> {
        let focus = input.read(cx).focus.clone();
        div()
            .id(gpui::SharedString::from(selector.clone()))
            .debug_selector(move || selector.clone())
            .flex_1()
            .min_w_0()
            .min_h(px(28.))
            .px(px(10.))
            .py(px(6.))
            .rounded(px(7.))
            .border_1()
            .border_color(theme().border)
            .bg(theme().surface_raised)
            .text_size(px(12.))
            .font_family(theme().font_mono)
            .on_mouse_down(gpui::MouseButton::Left, move |_, window, _| {
                focus.focus(window)
            })
            .child(input.clone())
    }
}

impl Render for InstanceDetail {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let editable = !self.instance.default;
        let section = |label: &'static str, help: String| {
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .pt(px(10.))
                .child(div().text_size(px(12.5)).child(label))
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child(help),
                )
        };
        let mut env = div()
            .debug_selector(|| "provider-instance-env".into())
            .flex()
            .flex_col()
            .gap(px(6.));
        for index in 0..self.env.len() {
            let secret = self.env[index].secret;
            let toggle = self
                .control(
                    format!("provider-env-secret-{index}"),
                    !self.busy,
                    window,
                    cx,
                    move |this, cx| {
                        let row = &mut this.env[index];
                        row.secret = !row.secret;
                        if !row.secret {
                            row.configured = false;
                        }
                        this.changed(cx);
                    },
                )
                .px(px(8.))
                .h(px(28.))
                .flex()
                .items_center()
                .rounded(px(7.))
                .text_size(px(11.))
                .bg(if secret {
                    theme().selection
                } else {
                    theme().surface_raised
                })
                .child(if secret { "Secret" } else { "Plain" });
            let remove = self
                .control(
                    format!("provider-env-remove-{index}"),
                    !self.busy,
                    window,
                    cx,
                    move |this, cx| {
                        this.env.remove(index);
                        this.changed(cx);
                    },
                )
                .size(px(28.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(7.))
                .hover(|v| v.bg(theme().hover))
                .child(crate::icon::stroke(
                    "M6 6l12 12M18 6 6 18",
                    theme().text_secondary,
                    11.,
                    2.,
                ));
            let row = &self.env[index];
            env = env.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(Self::field(
                        format!("provider-env-name-{index}"),
                        &row.name,
                        cx,
                    ))
                    .child(Self::field(
                        format!("provider-env-value-{index}"),
                        &row.value,
                        cx,
                    ))
                    .child(toggle)
                    .child(remove),
            );
        }
        let add_var = self.button(
            "provider-env-add".into(),
            "Add variable",
            None,
            !self.busy,
            window,
            cx,
            |this, cx| this.add_row(cx),
        );
        let save = self.button(
            "provider-instance-save".into(),
            "Save",
            Some(theme().accent),
            !self.busy,
            window,
            cx,
            |this, cx| this.save(cx),
        );
        let delete = editable.then(|| {
            if self.confirm_delete {
                let confirm = self.button(
                    "provider-instance-delete-confirm".into(),
                    "Delete instance",
                    Some(theme().danger),
                    !self.busy,
                    window,
                    cx,
                    |this, cx| this.delete(cx),
                );
                let cancel = self.button(
                    "provider-instance-delete-cancel".into(),
                    "Keep",
                    None,
                    !self.busy,
                    window,
                    cx,
                    |this, cx| {
                        this.confirm_delete = false;
                        this.changed(cx)
                    },
                );
                div()
                    .debug_selector(|| "provider-instance-delete-prompt".into())
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_size(px(11.5))
                            .text_color(theme().danger)
                            .child("Delete this instance, its env and saved secrets?"),
                    )
                    .child(div().flex().gap(px(8.)).child(confirm).child(cancel))
                    .into_any_element()
            } else {
                self.button(
                    "provider-instance-delete".into(),
                    "Delete…",
                    None,
                    !self.busy,
                    window,
                    cx,
                    |this, cx| this.delete(cx),
                )
            }
        });
        let home_help = match &self.selector {
            Some(selector) => format!(
                "Sets {selector} for this instance's sessions. Empty keeps the runtime default."
            ),
            None => "This runtime has no home directory setting.".into(),
        };
        let name_field = if editable {
            Self::field("provider-instance-name".into(), &self.name, cx).into_any_element()
        } else {
            div()
                .text_size(px(12.))
                .text_color(theme().text_secondary)
                .child(self.instance.name.clone())
                .into_any_element()
        };
        div()
            .debug_selector(|| "provider-instance-detail".into())
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .p(px(16.))
            .rounded(px(10.))
            .border_1()
            .border_color(theme().border)
            .child(
                div()
                    .text_size(px(15.))
                    .child(label(&self.runtime_label, &self.instance)),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child(if self.instance.default {
                        "Classic's Local ACP connection. Edit its command in Configure manually; env is edited here.".to_string()
                    } else {
                        format!("Instance of {} · id {}", self.instance.runtime, self.instance.id)
                    }),
            )
            .child(section("Display name", "Shown in lists and the composer.".into()))
            .child(name_field)
            .when(editable, |v| {
                v.child(section(
                    "Binary path",
                    if self.instance.acp.is_some() {
                        "The agent executable.".into()
                    } else {
                        "This instance's CLI. Empty uses the detected one.".into()
                    },
                ))
                .child(Self::field("provider-instance-binary".into(), &self.binary, cx))
            })
            .when(editable && self.selector.is_some(), |v| {
                v.child(section("Home directory", home_help))
                    .child(Self::field("provider-instance-home".into(), &self.home, cx))
            })
            .child(section(
                "Environment",
                "Added to this instance's sessions only. Secrets are encrypted and never shown again; provider API key names stay with Settings › API keys.".into(),
            ))
            .child(env)
            .child(div().pt(px(6.)).flex().child(add_var))
            .child(
                div()
                    .pt(px(14.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(save),
            )
            .children(delete.map(|d| div().pt(px(10.)).child(d)))
            .when(!self.notice.is_empty(), |v| {
                v.child(
                    div()
                        .debug_selector(|| "provider-instance-notice".into())
                        .pt(px(8.))
                        .text_size(px(11.5))
                        .text_color(theme().text_secondary)
                        .child(self.notice.clone()),
                )
            })
            .when_some(self.error.clone(), |v, e| {
                v.child(
                    div()
                        .debug_selector(|| "provider-instance-error".into())
                        .pt(px(8.))
                        .text_size(px(11.5))
                        .text_color(theme().danger)
                        .child(e),
                )
            })
    }
}
