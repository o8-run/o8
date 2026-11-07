//! New project: name, visibility and target machine for `gh repo create`.
//! The server runs gh on the chosen machine and registers the clone.
use super::{Setup, Step, control, look, primary, quiet};
use crate::client::Client;
use gpui::{Context, IntoElement, div, prelude::*, px};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum Visibility {
    Private,
    Public,
}
impl Visibility {
    pub(super) fn flag(self) -> &'static str {
        match self {
            Self::Private => "private",
            Self::Public => "public",
        }
    }
}

#[derive(Clone, Deserialize, PartialEq, Debug)]
pub(super) struct Machine {
    pub id: String,
    pub label: String,
}

/// `None` is this machine. Saved SSH machines are listed; creating on one
/// needs its own o8 to register the clone, so they cannot be chosen yet.
#[derive(Clone, PartialEq, Debug)]
pub(super) struct Form {
    pub visibility: Visibility,
    pub machine: Option<String>,
    pub machines: Vec<Machine>,
}
impl Default for Form {
    fn default() -> Self {
        Self {
            visibility: Visibility::Private,
            machine: None,
            machines: vec![],
        }
    }
}
pub(super) const REMOTE_UNAVAILABLE: &str =
    "Creating a project on another machine is not available yet. Choose This machine.";

impl Form {
    /// Saved machines, or none when the registry is unreadable or local-only.
    pub(super) fn load_machines(client: &Client) -> Vec<Machine> {
        #[derive(Deserialize)]
        struct Machines {
            machines: Vec<Machine>,
        }
        client
            .get::<Machines>("/api/panel/ssh-machines", &[])
            .map(|m| m.machines)
            .unwrap_or_default()
    }
    /// Why Create is unavailable, or the request the server runs.
    pub(super) fn request(&self, name: &str) -> Result<Value, &'static str> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Name the new repository.");
        }
        if name.starts_with('-')
            || name == "."
            || name == ".."
            || name.len() > 100
            || name.to_ascii_lowercase().ends_with(".git")
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        {
            return Err("Use letters, numbers, \".\", \"-\" or \"_\" in the name.");
        }
        if self.machine.is_some() {
            return Err(REMOTE_UNAVAILABLE);
        }
        Ok(json!({"action":"create","name":name,"visibility":self.visibility.flag()}))
    }
}

pub(super) fn page(this: &Setup, busy: bool, cx: &mut Context<Setup>) -> impl IntoElement {
    let form = this.form.clone();
    let creatable = form.request(&this.name.read(cx).text).is_ok();
    div()
        .debug_selector(|| "setup-new-project-form".into())
        .flex()
        .flex_col()
        .gap(px(10.))
        .child(look::title("New project"))
        .child(
            div()
                .text_size(px(12.))
                .text_color(crate::theme::current().text_secondary)
                .child("Repository name"),
        )
        .child(
            div()
                .id("setup-new-project-name")
                .debug_selector(|| "setup-new-project-name".into())
                .on_click(cx.listener(|s, _, window, cx| s.name.read(cx).focus.focus(window)))
                .child(this.name.clone()),
        )
        .child(
            div()
                .flex()
                .gap(px(8.))
                .children([Visibility::Private, Visibility::Public].map(|visibility| {
                    let chosen = form.visibility == visibility;
                    control(
                        &format!("setup-visibility-{}", visibility.flag()),
                        format!(
                            "{}{}",
                            if chosen { "● " } else { "" },
                            if visibility == Visibility::Private {
                                "Private"
                            } else {
                                "Public"
                            }
                        ),
                        !busy,
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.busy {
                            this.form.visibility = visibility;
                            this.revision += 1;
                            cx.notify();
                        }
                    }))
                })),
        )
        .child(
            div()
                .text_size(px(12.))
                .text_color(crate::theme::current().text_secondary)
                .child("Create on"),
        )
        .child(
            control(
                "setup-machine-local",
                if form.machine.is_none() {
                    "● This machine"
                } else {
                    "This machine"
                },
                !busy,
            )
            .on_click(cx.listener(|this, _, _, cx| {
                if !this.busy {
                    this.form.machine = None;
                    this.error = None;
                    this.revision += 1;
                    cx.notify();
                }
            })),
        )
        .children(form.machines.iter().map(|machine| {
            let id = machine.id.clone();
            control(
                &format!("setup-machine-{}", machine.id),
                if form.machine.as_ref() == Some(&machine.id) {
                    format!("● {}", machine.label)
                } else {
                    machine.label.clone()
                },
                !busy,
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                if !this.busy {
                    this.form.machine = Some(id.clone());
                    this.error = Some(REMOTE_UNAVAILABLE.into());
                    this.revision += 1;
                    cx.notify();
                }
            }))
        }))
        .child(look::actions(
            vec![
                quiet("setup-cancel-new-project", "Cancel", !busy)
                    .on_click(cx.listener(|this, _, _, cx| {
                        if !this.busy {
                            this.name.update(cx, |input, cx| input.clear(cx));
                            this.navigate(Step::Projects, cx);
                        }
                    }))
                    .into_any_element(),
            ],
            vec![
                primary("setup-create", "Create and open", creatable && !busy)
                    .on_click(cx.listener(|this, _, _, cx| this.create(cx)))
                    .into_any_element(),
            ],
        ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_project_form_states() {
        let mut form = Form::default();
        assert_eq!(form.request("  ").unwrap_err(), "Name the new repository.");
        assert!(
            form.request("--web").is_err(),
            "an option-shaped name never reaches gh"
        );
        assert!(form.request("my site").is_err());
        assert!(form.request("site.git").is_err());
        assert_eq!(
            form.request(" my-site ").unwrap(),
            json!({"action":"create","name":"my-site","visibility":"private"})
        );
        form.visibility = Visibility::Public;
        assert_eq!(form.request("my-site").unwrap()["visibility"], "public");
        form.machine = Some("machine-1".into());
        assert_eq!(form.request("my-site").unwrap_err(), REMOTE_UNAVAILABLE);
    }
}
