//! New and edit automation (AutomationEditor.tsx): name, prompt, repository,
//! runtime and a manual or cron trigger. Watch triggers stay as saved.
use super::view::{OWNER, Scheduled, action, call};
use super::*;
use crate::{composer::Composer, theme::current as theme};
use gpui::{Div, SharedString, WeakEntity};
use serde_json::{Value, json};

const RUNTIMES: [&str; 3] = ["codex", "gemini", "opencode"];
const DEFAULT_CRON: &str = "0 9 * * 1-5";

/// The editor closed; carries the saved record, if any.
pub(super) struct Done(pub Option<Value>);
impl gpui::EventEmitter<Done> for Editor {}

pub(crate) struct Editor {
    owner: WeakEntity<Scheduled>,
    id: Option<String>,
    record: Option<Value>,
    name: Entity<Composer>,
    prompt: Entity<Composer>,
    cron: Entity<Composer>,
    repos: Vec<(String, String)>,
    repo: String,
    runtime: String,
    cron_on: bool,
    saving: bool,
    error: Option<String>,
}

impl Editor {
    pub(super) fn new(
        owner: WeakEntity<Scheduled>,
        row: Option<Value>,
        mut repos: Vec<(String, String)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let text = |key: &str| {
            row.as_ref()
                .and_then(|r| r[key].as_str())
                .unwrap_or("")
                .to_owned()
        };
        let input = |value: String, placeholder: &str, inline: bool, cx: &mut Context<Self>| {
            let input = cx.new(|cx| {
                let mut input = Composer::new(cx);
                input.text = value;
                input.placeholder = placeholder.into();
                input.inline = inline;
                input.framed = false;
                input.newline_on_enter = !inline;
                input
            });
            cx.observe(&input, |_, _, cx| cx.notify()).detach();
            input
        };
        let name = input(text("name"), "Daily triage", true, cx);
        let prompt = input(
            text("prompt"),
            "What should the agent do each time it runs?",
            false,
            cx,
        );
        let cron_text = match text("cronExpr") {
            expr if expr.is_empty() => DEFAULT_CRON.to_owned(),
            expr => expr,
        };
        let cron = input(cron_text, DEFAULT_CRON, true, cx);
        let repo = match text("repoPath") {
            path if path.is_empty() => repos.first().map(|r| r.0.clone()).unwrap_or_default(),
            path => path,
        };
        if !repo.is_empty() && !repos.iter().any(|r| r.0 == repo) {
            repos.insert(0, (repo.clone(), text("branch")));
        }
        let runtime = match text("runtime") {
            r if RUNTIMES.contains(&r.as_str()) => r,
            _ => "codex".into(),
        };
        name.read(cx).focus.focus(window);
        Self {
            owner,
            id: row
                .as_ref()
                .and_then(|r| r["id"].as_str())
                .map(str::to_owned),
            cron_on: row.as_ref().is_none_or(|r| r["triggerKind"] == "cron"),
            record: row,
            name,
            prompt,
            cron,
            repos,
            repo,
            runtime,
            saving: false,
            error: None,
        }
    }

    fn cancel(&mut self, cx: &mut Context<Self>) {
        if !self.saving {
            cx.emit(Done(None));
        }
    }

    fn save(&mut self, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        let name = self.name.read(cx).text.trim().to_owned();
        let prompt = self.prompt.read(cx).text.trim().to_owned();
        let cron = self.cron.read(cx).text.trim().to_owned();
        let watch = self
            .record
            .as_ref()
            .is_some_and(|r| r["triggerKind"] == "watch");
        let missing = if name.is_empty() {
            Some("Name the automation.")
        } else if prompt.is_empty() {
            Some("Write the prompt the agent runs.")
        } else if self.repo.is_empty() {
            Some("Choose a repository.")
        } else if self.cron_on && !watch && cron.split_whitespace().count() != 5 {
            Some("Cron needs five fields, like 0 9 * * 1-5.")
        } else {
            None
        };
        if let Some(missing) = missing {
            self.error = Some(missing.into());
            cx.notify();
            return;
        }
        let saved = |key: &str| {
            self.record
                .as_ref()
                .map(|r| r[key].clone())
                .unwrap_or(Value::Null)
        };
        // The saved branch while the repository is unchanged, else its default.
        let branch = match saved("branch").as_str() {
            Some(b) if !b.is_empty() && saved("repoPath") == self.repo.as_str() => b.to_owned(),
            _ => self
                .repos
                .iter()
                .find(|r| r.0 == self.repo)
                .map(|r| r.1.clone())
                .filter(|b| !b.is_empty())
                .unwrap_or_else(|| "main".into()),
        };
        let trigger = if watch {
            "watch"
        } else if self.cron_on {
            "cron"
        } else {
            "manual"
        };
        let mut body = json!({
            "name": name,
            "prompt": prompt,
            "runtime": self.runtime,
            "repoPath": self.repo,
            "branch": branch,
            "triggerKind": trigger,
            "catchUpPolicy": saved("catchUpPolicy").as_str().unwrap_or("latest"),
            "repoConcurrencyLimit": saved("repoConcurrencyLimit").as_u64().unwrap_or(1),
            "precheckCommand": saved("precheckCommand"),
            "precheckTimeoutMs": saved("precheckTimeoutMs"),
        });
        if trigger == "cron" {
            body["cronExpr"] = json!(cron);
        }
        let (method, path) = match &self.id {
            Some(id) => ("PATCH", format!("/api/automations/{id}")),
            None => {
                body["owner"] = json!(OWNER);
                ("POST", "/api/automations".to_owned())
            }
        };
        let Some(client) = self.owner.upgrade().map(|o| o.read(cx).client.clone()) else {
            return;
        };
        self.saving = true;
        self.error = None;
        cx.notify();
        let task = cx
            .background_executor()
            .spawn(async move { call(&client, method, &path, Some(body)) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                match result {
                    Ok(data) if data["automation"].is_object() => {
                        cx.emit(Done(Some(data["automation"].clone())))
                    }
                    Ok(data) => {
                        this.error =
                            Some(data["error"].as_str().unwrap_or("Save failed").to_owned());
                    }
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
    }
}

fn label(text: &'static str) -> impl IntoElement {
    div()
        .text_size(px(10.5))
        .text_color(theme().text_muted)
        .child(text)
}

/// A bordered field; the multi-line composer brings its own padding.
fn boxed(
    id: &'static str,
    input: &Entity<Composer>,
    height: f32,
    cx: &gpui::App,
) -> impl IntoElement {
    let inline = height < 40.;
    let focus = input.read(cx).focus.clone();
    div()
        .debug_selector(move || id.into())
        .cursor_text()
        .on_mouse_down(gpui::MouseButton::Left, move |_, window, _| {
            focus.focus(window);
            // Keeps the shell's own focus tracker from taking it back.
            window.prevent_default();
        })
        .min_h(px(height))
        .when(inline, |d| d.px(px(10.)).py(px(7.)))
        .rounded(px(8.))
        .border_1()
        .border_color(theme().border)
        .bg(theme().surface)
        .text_size(px(13.))
        .child(input.clone())
}

fn chip(id: String, text: String, on: bool) -> gpui::Stateful<Div> {
    let selector = id.clone();
    div()
        .id(SharedString::from(id))
        .debug_selector(move || selector.clone())
        .h(px(26.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(px(7.))
        .border_1()
        .border_color(if on { theme().accent } else { theme().border })
        .bg(if on { theme().hover } else { theme().surface })
        .text_size(px(11.5))
        .text_color(if on { theme().text } else { theme().text_muted })
        .cursor_pointer()
        .hover(|d| d.bg(theme().hover))
        .child(text)
}

impl Render for Editor {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let watch = self
            .record
            .as_ref()
            .is_some_and(|r| r["triggerKind"] == "watch");
        div()
            .id("scheduled-editor-scrim")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .bg(theme().text)
                    .opacity(0.35),
            )
            .on_click(cx.listener(|this, _, _, cx| this.cancel(cx)))
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    this.cancel(cx);
                    cx.stop_propagation();
                }
            }))
            .child(
                div()
                    .id("scheduled-editor")
                    .debug_selector(|| "scheduled-editor".into())
                    .w(px(560.))
                    .max_w_full()
                    .max_h(gpui::relative(0.9))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .p(px(20.))
                    .rounded(px(12.))
                    .border_1()
                    .border_color(theme().border)
                    .bg(theme().surface_raised)
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .child(div().text_size(px(16.)).child(if self.id.is_some() {
                        "Edit automation"
                    } else {
                        "New automation"
                    }))
                    .child(label("Name"))
                    .child(boxed("scheduled-editor-name", &self.name, 34., cx))
                    .child(label("Prompt"))
                    .child(boxed("scheduled-editor-prompt", &self.prompt, 110., cx))
                    .child(label("Repository"))
                    .child(div().flex().flex_wrap().gap(px(6.)).children(
                        self.repos.iter().enumerate().map(|(index, (repo, _))| {
                            let path = repo.clone();
                            chip(
                                format!("scheduled-editor-repo-{index}"),
                                repo.rsplit('/')
                                    .find(|p| !p.is_empty())
                                    .unwrap_or(repo)
                                    .to_owned(),
                                *repo == self.repo,
                            )
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    this.repo = path.clone();
                                    cx.notify();
                                },
                            ))
                        }),
                    ))
                    .child(label("Runtime"))
                    .child(
                        div()
                            .flex()
                            .gap(px(6.))
                            .children(RUNTIMES.iter().map(|runtime| {
                                chip(
                                    format!("scheduled-editor-runtime-{runtime}"),
                                    runtime[..1].to_uppercase() + &runtime[1..],
                                    self.runtime == *runtime,
                                )
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.runtime = (*runtime).into();
                                        cx.notify();
                                    },
                                ))
                            })),
                    )
                    .child(label("Trigger"))
                    .when(watch, |d| {
                        d.child(
                            div()
                                .text_size(px(11.5))
                                .text_color(theme().text_muted)
                                .child("Watch trigger · edit its source in the web app."),
                        )
                    })
                    .when(!watch, |d| {
                        d.child(
                            div()
                                .flex()
                                .gap(px(6.))
                                .child(
                                    chip(
                                        "scheduled-editor-manual".into(),
                                        "Manual".into(),
                                        !self.cron_on,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, _, cx| {
                                            this.cron_on = false;
                                            cx.notify();
                                        },
                                    )),
                                )
                                .child(
                                    chip(
                                        "scheduled-editor-cron".into(),
                                        "Cron schedule".into(),
                                        self.cron_on,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, _, cx| {
                                            this.cron_on = true;
                                            cx.notify();
                                        },
                                    )),
                                ),
                        )
                        .when(self.cron_on, |d| {
                            d.child(boxed("scheduled-editor-cron-expr", &self.cron, 34., cx))
                                .child(
                                    div()
                                        .text_size(px(10.))
                                        .text_color(theme().text_faint)
                                        .child("minute hour day month weekday · local time"),
                                )
                        })
                    })
                    .when_some(self.error.clone(), |d, error| {
                        d.child(
                            div()
                                .text_size(px(11.5))
                                .text_color(theme().danger)
                                .child(error),
                        )
                    })
                    .child(
                        div()
                            .pt(px(4.))
                            .flex()
                            .justify_end()
                            .gap(px(6.))
                            .child(
                                action(
                                    "scheduled-editor-cancel".into(),
                                    "Cancel",
                                    false,
                                    self.saving,
                                )
                                .on_click(cx.listener(|this, _, _, cx| this.cancel(cx))),
                            )
                            .child(
                                action(
                                    "scheduled-editor-save".into(),
                                    if self.saving { "Saving…" } else { "Save" },
                                    false,
                                    self.saving,
                                )
                                .text_color(theme().text)
                                .border_1()
                                .border_color(theme().border)
                                .bg(theme().surface)
                                .on_click(cx.listener(|this, _, _, cx| this.save(cx))),
                            ),
                    ),
            )
    }
}
