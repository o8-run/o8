//! Action plugins: review a local folder, link its exact files, then run them.
use super::view::control;
use crate::{client::Client, composer::Composer, theme::current as theme};
use gpui::{Context, Entity, Render, SharedString, Window, div, prelude::*, px};
use serde_json::{Value, json};
use std::collections::HashSet;

const ROUTE: &str = "/api/customize/actions";
pub struct Plugins {
    client: Client,
    repo: Option<String>,
    installed: Vec<Value>,
    damaged: Vec<String>,
    receipts: Vec<Value>,
    directory: Entity<Composer>,
    review: Option<Value>,
    reviewed: String,
    open_files: HashSet<usize>,
    removing: Option<String>,
    loading: bool,
    error: Option<String>,
    notice: Option<String>,
    _subscription: gpui::Subscription,
}
fn text(item: &Value, key: &str) -> String {
    item[key].as_str().unwrap_or("").to_owned()
}
fn run_date(iso: &str) -> String {
    iso.get(..10).unwrap_or("").to_owned()
}
fn card() -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .rounded(px(12.))
        .border_1()
        .border_color(theme().border)
        .bg(theme().surface)
        .overflow_hidden()
}
fn heading(label: &'static str) -> gpui::Div {
    div()
        .mt(px(8.))
        .text_size(px(11.))
        .text_color(theme().text_muted)
        .child(label)
}
fn meta(label: impl Into<SharedString>) -> gpui::Div {
    div()
        .text_size(px(11.))
        .line_height(px(16.))
        .text_color(theme().text_muted)
        .child(label.into())
}
impl Plugins {
    pub fn new(client: Client, repo: Option<String>, cx: &mut Context<Self>) -> Self {
        let directory = cx.new(|cx| {
            let mut directory = Composer::new(cx);
            directory.placeholder = "Folder with an o8-actions.json".into();
            directory
        });
        let _subscription = cx.observe(&directory, |this, directory, cx| {
            if directory.read(cx).text.trim() != this.reviewed {
                this.review = None;
            }
            cx.notify();
        });
        let mut this = Self {
            client,
            repo,
            installed: vec![],
            damaged: vec![],
            receipts: vec![],
            directory,
            review: None,
            reviewed: String::new(),
            open_files: HashSet::new(),
            removing: None,
            loading: false,
            error: None,
            notice: None,
            _subscription,
        };
        this.request(None, None, cx);
        this
    }
    pub fn count(&self) -> usize {
        self.installed.len()
    }
    /// Sends one action, then always rereads the inventory it may have changed.
    fn request(&mut self, body: Option<Value>, done: Option<String>, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        self.loading = true;
        self.error = None;
        self.notice = None;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let result = body
                .map(|body| client.customize_request("POST", ROUTE, &body))
                .transpose()?;
            let inventory: Value = client.get(ROUTE, &[])?;
            Ok::<_, String>((result, inventory))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok((result, inventory)) => {
                        let list =
                            |key: &str| inventory[key].as_array().cloned().unwrap_or_default();
                        this.installed = list("installed");
                        this.receipts = list("receipts");
                        this.damaged = list("damaged")
                            .iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect();
                        let status = result.as_ref().map(|r| text(&r["receipt"], "status"));
                        this.notice = match (done, status.as_deref()) {
                            (Some(done), Some("" | "succeeded") | None) => Some(done),
                            (Some(done), Some(status)) => Some(format!("{done}: {status}")),
                            (None, _) => None,
                        };
                        if let Some(review) = result.map(|r| r["review"].clone()) {
                            this.review = (!review.is_null()).then_some(review);
                        }
                    }
                    Err(error) => this.error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn review_source(&mut self, cx: &mut Context<Self>) {
        self.open_files.clear();
        let directory = self.directory.read(cx).text.trim().to_owned();
        self.reviewed = directory.clone();
        let mut body = json!({"action":"review","directory":directory});
        if let Some(repo) = &self.repo {
            body["repo"] = json!(repo);
        }
        self.request(Some(body), None, cx);
    }
    fn link(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self.review.take() else {
            return;
        };
        let directory = review["sourceDirectory"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| self.directory.read(cx).text.trim().to_owned());
        let mut body =
            json!({"action":"link","directory":directory,"expectedRevision":review["revision"]});
        if review["manifest"]["workspace"] == "registered-project" {
            body["repo"] = json!(self.repo);
        }
        self.directory
            .update(cx, |directory, cx| directory.clear(cx));
        self.request(
            Some(body),
            Some("Linked. Run an action when you're ready.".into()),
            cx,
        );
    }
    fn change(&mut self, plugin: &Value, action: &str, cx: &mut Context<Self>) {
        let body =
            json!({"action":action,"id":plugin["manifest"]["id"],"revision":plugin["revision"]});
        let name = text(&plugin["manifest"], "name");
        self.removing = None;
        let done = match action {
            "remove" => format!("{name} removed."),
            "enable" => format!("{name} enabled."),
            _ => format!("{name} disabled."),
        };
        self.request(Some(body), Some(done), cx);
    }
    fn run(&mut self, plugin: &Value, action: &str, cx: &mut Context<Self>) {
        let mut body = json!({"action":"invoke","id":plugin["manifest"]["id"],"actionId":action,"revision":plugin["revision"]});
        if plugin["manifest"]["workspace"] == "registered-project" {
            body["repo"] = json!(self.repo);
        }
        self.request(Some(body), Some(action.to_owned()), cx);
    }
    fn review_panel(&self, review: &Value, cx: &mut Context<Self>) -> gpui::AnyElement {
        let manifest = &review["manifest"];
        let actions = manifest["actions"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|action| {
                format!(
                    "{} runs {} {}",
                    text(action, "id"),
                    text(action, "entry"),
                    action["args"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                )
            })
            .collect::<Vec<_>>()
            .join(" · ");
        let cwd = text(&review["execution"], "cwd");
        let files = review["files"].as_array().cloned().unwrap_or_default();
        div()
            .debug_selector(|| "plugin-review".into())
            .flex()
            .flex_col()
            .gap(px(6.))
            .px(px(14.))
            .py(px(12.))
            .border_t_1()
            .border_color(theme().border)
            .child(div().text_size(px(13.5)).child(format!(
                "{} · v{}",
                text(manifest, "name"),
                text(manifest, "version")
            )))
            .child(meta(text(manifest, "description")))
            .child(meta(actions))
            .child(meta(format!("Working folder: {cwd}")))
            .child(
                meta("These files run with your own user permissions. Read them before linking.")
                    .text_color(theme().warning),
            )
            .children(files.into_iter().enumerate().map(|(i, file)| {
                let open = self.open_files.contains(&i);
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .id(SharedString::from(format!("plugin-file-{i}")))
                            .debug_selector(move || format!("plugin-file-{i}"))
                            .cursor_pointer()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !this.open_files.remove(&i) {
                                    this.open_files.insert(i);
                                }
                                cx.notify();
                            }))
                            .child(meta(format!(
                                "{} · {} bytes",
                                text(&file, "path"),
                                file["bytes"].as_u64().unwrap_or(0)
                            ))),
                    )
                    .when(open, |v| {
                        v.child(
                            div()
                                .debug_selector(move || format!("plugin-file-content-{i}"))
                                .p(px(10.))
                                .rounded(px(7.))
                                .bg(theme().background)
                                .font_family(theme().font_mono)
                                .text_size(px(11.))
                                .line_height(px(16.))
                                .child(text(&file, "content")),
                        )
                    })
            }))
            .child(
                div().mt(px(6.)).child(
                    control("plugin-link", "Link this revision", !self.loading)
                        .on_click(cx.listener(|this, _, _, cx| this.link(cx))),
                ),
            )
            .into_any_element()
    }
}
impl Render for Plugins {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = self.loading;
        let ready = !busy && !self.directory.read(cx).text.trim().is_empty();
        let count = self.installed.len();
        let review = self.review.clone().map(|r| self.review_panel(&r, cx));
        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                div()
                    .text_size(px(13.))
                    .text_color(theme().text_muted)
                    .child("Small local tools your agents and you can run. Review a folder, link its exact files, then run an action."),
            )
            .child(
                card().child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .px(px(14.))
                        .py(px(8.))
                        .child(
                            div()
                                .debug_selector(|| "plugin-directory".into())
                                .flex_1()
                                .min_w_0()
                                .text_size(px(13.))
                                .child(self.directory.clone()),
                        )
                        .child(
                            control("plugin-review-source", "Review", ready).when(ready, |v| {
                                v.on_click(cx.listener(|this, _, _, cx| this.review_source(cx)))
                            }),
                        ),
                )
                .children(review),
            )
            .when_some(self.error.clone(), |v, error| {
                v.child(
                    div()
                        .debug_selector(|| "plugin-error".into())
                        .text_size(px(12.))
                        .text_color(theme().danger)
                        .child(error),
                )
            })
            .when_some(self.notice.clone(), |v, notice| {
                v.child(
                    div()
                        .debug_selector(|| "plugin-notice".into())
                        .text_size(px(12.))
                        .text_color(theme().text_secondary)
                        .child(notice),
                )
            })
            .when(!self.damaged.is_empty(), |v| {
                v.child(
                    div()
                        .text_size(px(12.))
                        .text_color(theme().danger)
                        .child(format!(
                            "Damaged, so their actions are off: {}",
                            self.damaged.join(", ")
                        )),
                )
            })
            .child(heading("Installed"))
            .when(count == 0 && !busy, |v| {
                v.child(
                    div()
                        .debug_selector(|| "plugin-empty".into())
                        .child(meta("No plugins linked yet. Instruction bundles live in Skills.")),
                )
            })
            .when(count > 0, |v| {
                v.child(card().children(self.installed.clone().into_iter().enumerate().map(
                    |(i, plugin)| {
                        let manifest = plugin["manifest"].clone();
                        let id = text(&manifest, "id");
                        let enabled = plugin["enabled"] == true;
                        let removing = self.removing.as_deref() == Some(id.as_str());
                        let source = plugin["sourceDirectory"]
                            .as_str()
                            .map(|path| format!("Linked from {path}"))
                            .or_else(|| {
                                plugin["source"]["repository"]
                                    .as_str()
                                    .map(|repo| format!("From {repo}"))
                            });
                        let toggle = plugin.clone();
                        let confirm = plugin.clone();
                        let actions = manifest["actions"].as_array().cloned().unwrap_or_default();
                        div()
                            .debug_selector(move || format!("plugin-row-{i}"))
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .px(px(14.))
                            .py(px(10.))
                            .when(i + 1 < count, |v| v.border_b_1().border_color(theme().border))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .text_size(px(13.5))
                                            .truncate()
                                            .child(format!(
                                                "{} · v{}",
                                                text(&manifest, "name"),
                                                text(&manifest, "version")
                                            )),
                                    )
                                    .child(
                                        control(
                                            &format!("plugin-toggle-{i}"),
                                            if enabled { "Disable" } else { "Enable" },
                                            !busy,
                                        )
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            let action = if enabled { "disable" } else { "enable" };
                                            this.change(&toggle, action, cx)
                                        })),
                                    )
                                    .when(!removing, |v| {
                                        let id = id.clone();
                                        v.child(
                                            control(&format!("plugin-remove-{i}"), "Remove", !busy)
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.removing = Some(id.clone());
                                                    cx.notify();
                                                })),
                                        )
                                    })
                                    .when(removing, |v| {
                                        v.child(
                                            control(&format!("plugin-remove-confirm-{i}"), "Confirm", !busy)
                                                .text_color(theme().danger)
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.change(&confirm, "remove", cx)
                                                })),
                                        )
                                        .child(
                                            control(&format!("plugin-remove-cancel-{i}"), "Cancel", !busy)
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.removing = None;
                                                    cx.notify();
                                                })),
                                        )
                                    }),
                            )
                            .child(meta(text(&manifest, "description")))
                            .children(source.map(meta))
                            .children(actions.into_iter().enumerate().map(|(a, action)| {
                                let plugin = plugin.clone();
                                let id = text(&action, "id");
                                let run = id.clone();
                                div()
                                    .mt(px(4.))
                                    .flex()
                                    .items_center()
                                    .gap(px(10.))
                                    .child(
                                        div().flex_1().min_w_0().child(meta(format!(
                                            "{id} · {}",
                                            text(&action, "description")
                                        ))),
                                    )
                                    .child(
                                        control(&format!("plugin-run-{i}-{a}"), "Run", !busy && enabled)
                                            .when(!busy && enabled, |v| {
                                                v.on_click(cx.listener(move |this, _, _, cx| {
                                                    this.run(&plugin, &run, cx)
                                                }))
                                            }),
                                    )
                            }))
                    },
                )))
            })
            .when(!self.receipts.is_empty(), |v| {
                v.child(heading("Recent runs")).child(card().children(
                    self.receipts.iter().take(8).enumerate().map(|(i, receipt)| {
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .px(px(14.))
                            .py(px(8.))
                            .when(i > 0, |v| v.border_t_1().border_color(theme().border))
                            .child(div().flex_1().min_w_0().truncate().text_size(px(12.)).child(
                                format!("{} · {}", text(receipt, "plugin_id"), text(receipt, "action_id")),
                            ))
                            .child(meta(text(receipt, "status")))
                            .child(meta(run_date(&text(receipt, "started_at"))))
                    }),
                ))
            })
    }
}
