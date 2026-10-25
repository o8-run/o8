//! Native customization inventories and the existing saved-prompt library.
use crate::{client::Client, composer::Composer, theme::current as theme};
use gpui::{
    ClipboardItem, Context, Entity, Render, SharedString, Window, canvas, div, prelude::*, px,
};
use serde_json::{Value, json};
use std::{cell::Cell, rc::Rc};

const TABS: [(&str, &str); 6] = [
    ("rules", "Instructions"),
    ("prompts", "Prompts"),
    ("skills", "Skills"),
    ("connections", "Connections"),
    ("agents", "Agents"),
    ("hooks", "Hooks"),
];
#[derive(Clone)]
struct Row {
    id: String,
    title: String,
    body: String,
    tags: Vec<String>,
    scope: String,
    updated_at: Option<u64>,
    repo_path: Option<String>,
}
impl Row {
    fn prompt(item: &Value) -> Result<Self, String> {
        let text = |key: &str| {
            item[key]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "Invalid saved prompt. Refresh before trying again.".to_owned())
        };
        let updated_at = item["updatedAt"]
            .as_u64()
            .filter(|v| *v > 0)
            .ok_or("Invalid saved prompt revision. Refresh before trying again.")?;
        Ok(Self {
            id: text("id")?,
            title: text("title")?,
            body: text("body")?,
            scope: text("scope")?,
            tags: item["tags"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
            updated_at: Some(updated_at),
            repo_path: item["repoPath"].as_str().map(str::to_owned),
        })
    }
}
#[derive(Clone, Default)]
struct Inventory {
    rows: Vec<(String, Row)>,
}
impl Inventory {
    fn load(client: &Client, repo: Option<&str>) -> Result<Self, String> {
        let query = repo.map(|r| vec![("repo", r)]).unwrap_or_default();
        let inventory: Value = client.get("/api/customize/inventory", &query)?;
        if inventory["ok"] != true {
            return Err("Could not load local customizations. Try again.".into());
        }
        let query = repo.map(|r| vec![("repoPath", r)]).unwrap_or_default();
        let rules: Value = client.get("/api/cortex/directives", &query)?;
        let connections: Value = client.get("/api/setup/mcp-servers", &[])?;
        let mut prompt_query = vec![
            (
                "scope",
                if repo.is_some() {
                    "available"
                } else {
                    "global"
                },
            ),
            ("limit", "100"),
        ];
        if let Some(repo) = repo {
            prompt_query.push(("repoPath", repo));
        }
        let prompts: Value = client.get("/api/prompt-library", &prompt_query)?;
        if ["agents", "skills", "hooks"]
            .iter()
            .any(|kind| !inventory[*kind].is_array())
            || !rules["directives"].is_array()
            || !connections["servers"].is_array()
            || prompts["ok"] != true
            || !prompts["prompts"].is_array()
        {
            return Err(
                "The server returned an invalid customization inventory. Try again.".into(),
            );
        }
        let mut result = Self::default();
        for kind in ["agents", "skills", "hooks"] {
            for item in inventory[kind].as_array().into_iter().flatten() {
                if repo.is_none() && item["scope"] == "project" {
                    continue;
                }
                let title = item[if kind == "hooks" { "event" } else { "name" }]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                let body = if kind == "hooks" {
                    "command".to_owned()
                } else {
                    item["description"].as_str().unwrap_or("").to_owned()
                };
                result.rows.push((
                    kind.into(),
                    Row {
                        id: item["file"].as_str().unwrap_or("").into(),
                        title,
                        body,
                        tags: vec![],
                        scope: item["scope"].as_str().unwrap_or("").into(),
                        updated_at: None,
                        repo_path: None,
                    },
                ));
            }
        }
        for item in rules["directives"].as_array().into_iter().flatten() {
            if repo.is_none() && item["scope"] != "global" && item["scope"] != "" {
                continue;
            }
            // Indexed documentation is reference material, not authored guidance.
            if item["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("spec-ingest:"))
            {
                continue;
            }
            result.rows.push((
                "rules".into(),
                Row {
                    id: item["id"].as_str().unwrap_or("").into(),
                    title: item["title"].as_str().unwrap_or("").into(),
                    body: item["body"].as_str().unwrap_or("").into(),
                    tags: vec![],
                    scope: item["scope"].as_str().unwrap_or("").into(),
                    updated_at: None,
                    repo_path: None,
                },
            ));
        }
        for (id, title) in [("o8-operator", "o8 operator"), ("cortex", "cortex")] {
            result.rows.push((
                "connections".into(),
                Row {
                    id: id.into(),
                    title: title.into(),
                    body: String::new(),
                    tags: vec![],
                    scope: "global".into(),
                    updated_at: None,
                    repo_path: None,
                },
            ));
        }
        for item in connections["servers"].as_array().into_iter().flatten() {
            result.rows.push((
                "connections".into(),
                Row {
                    id: item["id"].as_str().unwrap_or("").into(),
                    title: item["name"].as_str().unwrap_or("").into(),
                    body: if item["transport"] == "http" {
                        let host = item["url"]
                            .as_str()
                            .or(item["command"].as_str())
                            .and_then(|s| url::Url::parse(s).ok())
                            .and_then(|u| u.host_str().map(str::to_owned));
                        host.map(|host| format!("http · {host}"))
                            .unwrap_or_else(|| "http".into())
                    } else {
                        "stdio".into()
                    },
                    tags: vec![],
                    scope: "global".into(),
                    updated_at: None,
                    repo_path: None,
                },
            ));
        }
        for item in prompts["prompts"].as_array().into_iter().flatten() {
            result.rows.push(("prompts".into(), Row::prompt(item)?));
        }
        result.rows.sort_by(|(_, a), (_, b)| {
            (a.scope != "project")
                .cmp(&(b.scope != "project"))
                .then_with(|| a.title.cmp(&b.title))
        });
        Ok(result)
    }
}
struct Editor {
    id: Option<String>,
    scope: String,
    updated_at: Option<u64>,
    repo_path: Option<String>,
    title: Entity<Composer>,
    body: Entity<Composer>,
    tags: Entity<Composer>,
}
pub struct Customize {
    client: Client,
    repo: Option<String>,
    personal: bool,
    tab: String,
    inventory: Inventory,
    query: Entity<Composer>,
    editor: Option<Editor>,
    deleting: Option<Row>,
    loading: bool,
    error: Option<String>,
    revision: u64,
    painted: Rc<Cell<u64>>,
    _subscriptions: Vec<gpui::Subscription>,
}
impl Customize {
    pub fn new(client: Client, repo: Option<String>, cx: &mut Context<Self>) -> Self {
        let query = cx.new(Composer::new);
        let subscription = cx.observe(&query, |this, _, cx| {
            this.revision += 1;
            cx.notify();
        });
        let mut this = Self {
            client,
            personal: repo.is_none(),
            repo,
            tab: "rules".into(),
            inventory: Inventory::default(),
            query,
            editor: None,
            deleting: None,
            loading: false,
            error: None,
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            _subscriptions: vec![subscription],
        };
        this.load(None, cx);
        this
    }
    pub fn busy(&self) -> bool {
        self.loading
    }
    pub fn belongs_to(&self, repo: Option<&str>) -> bool {
        self.repo.as_deref() == repo
    }
    fn load(&mut self, write: Option<(String, String, Value)>, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        self.loading = true;
        self.error = None;
        let client = self.client.clone();
        let repo = if self.personal {
            None
        } else {
            self.repo.clone()
        };
        let saving = write.is_some();
        let task = cx.background_executor().spawn(async move {
            if let Some((method, path, body)) = write {
                client.customize_request(&method, &path, &body)?;
            }
            Inventory::load(&client, repo.as_deref())
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok(inventory) => {
                        this.inventory = inventory;
                        if saving {
                            this.editor = None;
                            this.deleting = None;
                        }
                    }
                    Err(error) => this.error = Some(error),
                }
                this.revision += 1;
                cx.notify();
            });
        })
        .detach();
        self.revision += 1;
        cx.notify();
    }
    fn edit(&mut self, row: Option<Row>, window: &mut Window, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        let Some(row) = row else {
            self.begin_edit(None, window, cx);
            return;
        };
        self.loading = true;
        self.error = None;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let response: Value =
                client.get(&format!("/api/prompt-library/{}", escape(&row.id)), &[])?;
            Row::prompt(&response["prompt"])
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.loading = false;
                match result {
                    Ok(row) => this.begin_edit(Some(row), window, cx),
                    Err(error) => this.error = Some(error),
                }
                this.revision += 1;
                cx.notify();
            });
        })
        .detach();
        self.revision += 1;
        cx.notify();
    }
    fn copy(&mut self, row: Row, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        if self.tab != "prompts" {
            cx.write_to_clipboard(ClipboardItem::new_string(row.body));
            return;
        }
        self.loading = true;
        self.error = None;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let response: Value =
                client.get(&format!("/api/prompt-library/{}", escape(&row.id)), &[])?;
            Row::prompt(&response["prompt"])
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok(row) => cx.write_to_clipboard(ClipboardItem::new_string(row.body)),
                    Err(error) => this.error = Some(error),
                }
                this.revision += 1;
                cx.notify();
            });
        })
        .detach();
        self.revision += 1;
        cx.notify();
    }
    fn begin_edit(&mut self, row: Option<Row>, window: &mut Window, cx: &mut Context<Self>) {
        let input = |text: String, cx: &mut Context<Self>| {
            cx.new(|cx| {
                let mut input = Composer::new(cx);
                input.text = text;
                input
            })
        };
        let title = input(
            row.as_ref().map(|r| r.title.clone()).unwrap_or_default(),
            cx,
        );
        let body = input(row.as_ref().map(|r| r.body.clone()).unwrap_or_default(), cx);
        let tags = input(
            row.as_ref().map(|r| r.tags.join(", ")).unwrap_or_default(),
            cx,
        );
        title.read(cx).focus.focus(window);
        self.editor = Some(Editor {
            repo_path: row
                .as_ref()
                .map(|r| r.repo_path.clone())
                .unwrap_or_else(|| {
                    if self.personal {
                        None
                    } else {
                        self.repo.clone()
                    }
                }),
            updated_at: row.as_ref().and_then(|r| r.updated_at),
            id: row.as_ref().map(|r| r.id.clone()),
            scope: row
                .map(|r| r.scope)
                .unwrap_or_else(|| if self.personal { "global" } else { "repo" }.into()),
            title,
            body,
            tags,
        });
        self.error = None;
        self.revision += 1;
        cx.notify();
    }
    fn save(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = &self.editor else {
            return;
        };
        let tags: Vec<_> = editor
            .tags
            .read(cx)
            .text
            .split(',')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
            .collect();
        let mut body = json!({"title":editor.title.read(cx).text,"body":editor.body.read(cx).text,"tags":tags,"scope":editor.scope,"repoPath":editor.repo_path});
        if let Some(revision) = editor.updated_at {
            body["expectedUpdatedAt"] = json!(revision);
        }
        let (method, path) = if let Some(id) = &editor.id {
            ("PATCH", format!("/api/prompt-library/{}", escape(id)))
        } else {
            ("POST", "/api/prompt-library".into())
        };
        self.load(Some((method.into(), path, body)), cx);
    }
    fn scope(&mut self, personal: bool, cx: &mut Context<Self>) {
        if self.loading || self.editor.is_some() {
            return;
        }
        self.personal = personal;
        self.inventory = Inventory::default();
        self.deleting = None;
        self.load(None, cx);
    }
}
fn escape(id: &str) -> String {
    url::form_urlencoded::byte_serialize(id.as_bytes()).collect()
}
fn control(id: &str, label: impl Into<SharedString>, enabled: bool) -> gpui::Stateful<gpui::Div> {
    let selector = id.to_owned();
    div()
        .id(SharedString::from(id.to_owned()))
        .debug_selector(move || selector.clone())
        .p(px(8.))
        .rounded(px(6.))
        .border_1()
        .border_color(theme().border)
        .bg(theme().surface_raised)
        .opacity(if enabled { 1. } else { 0.45 })
        .when(enabled, |v| v.cursor_pointer())
        .child(label.into())
}
fn field(id: &'static str, input: &Entity<Composer>, busy: bool, cx: &gpui::App) -> gpui::Div {
    div().debug_selector(move || id.into()).child(if busy {
        // Removing the input entity from the frame also removes its platform
        // input handler while the frozen request is in flight.
        div()
            .min_h(px(38.))
            .p(px(9.))
            .text_color(theme().text_secondary)
            .child(input.read(cx).text.clone())
            .into_any_element()
    } else {
        input.clone().into_any_element()
    })
}
impl Render for Customize {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = self.loading;
        let query = self.query.read(cx).text.trim().to_lowercase();
        let all: Vec<_> = self
            .inventory
            .rows
            .iter()
            .filter(|(kind, _)| kind == &self.tab)
            .map(|(_, row)| row.clone())
            .collect();
        let rows: Vec<_> = all
            .iter()
            .filter(|row| {
                query.is_empty()
                    || format!("{} {} {}", row.title, row.body, row.tags.join(" "))
                        .to_lowercase()
                        .contains(&query)
            })
            .cloned()
            .collect();
        let painted = self.painted.clone();
        let revision = self.revision;
        div()
            .id("customize")
            .size_full()
            .overflow_y_scroll()
            .p(px(24.))
            .flex()
            .flex_col()
            .gap(px(12.))
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .child(div().text_size(px(24.)).child("Customize"))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(8.))
                    .children(TABS.into_iter().map(|(id, label)| {
                        let count = self
                            .inventory
                            .rows
                            .iter()
                            .filter(|(kind, _)| kind == id)
                            .count();
                        control(
                            &format!("custom-tab-{id}"),
                            format!("{label} ({count})"),
                            !busy,
                        )
                        .bg(if self.tab == id {
                            theme().selection
                        } else {
                            theme().surface_raised
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !this.loading {
                                this.tab = id.into();
                                this.editor = None;
                                this.deleting = None;
                                this.error = None;
                                this.revision += 1;
                                cx.notify();
                            }
                        }))
                    })),
            )
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        control("custom-personal", "Personal", !busy)
                            .bg(if self.personal {
                                theme().selection
                            } else {
                                theme().surface_raised
                            })
                            .on_click(cx.listener(|this, _, _, cx| this.scope(true, cx))),
                    )
                    .when(self.repo.is_some(), |v| {
                        v.child(
                            control(
                                "custom-workspace",
                                self.repo
                                    .as_deref()
                                    .and_then(|repo| std::path::Path::new(repo).file_name())
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .to_string(),
                                !busy,
                            )
                            .bg(if !self.personal {
                                theme().selection
                            } else {
                                theme().surface_raised
                            })
                            .on_click(cx.listener(|this, _, _, cx| this.scope(false, cx))),
                        )
                    })
                    .child(
                        control("custom-refresh", "Refresh", !busy)
                            .on_click(cx.listener(|this, _, _, cx| this.load(None, cx))),
                    ),
            )
            .child(
                div()
                    .debug_selector(|| "custom-search".into())
                    .child(self.query.clone()),
            )
            .when(busy, |v| {
                v.child(
                    div()
                        .debug_selector(|| "custom-loading".into())
                        .child("Loading customizations…"),
                )
            })
            .when_some(self.error.clone(), |v, error| {
                v.child(
                    div()
                        .debug_selector(|| "custom-error".into())
                        .text_color(theme().danger)
                        .child(error),
                )
            })
            .when(self.tab == "prompts" && self.editor.is_none(), |v| {
                v.child(
                    control("custom-new", "Save a prompt", !busy)
                        .on_click(cx.listener(|this, _, window, cx| this.edit(None, window, cx))),
                )
            })
            .when_some(self.editor.as_ref(), |v, editor| {
                v.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child("Title")
                        .child(field("custom-title", &editor.title, busy, cx))
                        .child("Text")
                        .child(field("custom-body", &editor.body, busy, cx))
                        .child("Tags")
                        .child(field("custom-tags", &editor.tags, busy, cx))
                        .child(
                            div()
                                .flex()
                                .gap(px(8.))
                                .child(
                                    control("custom-save", "Save", !busy)
                                        .on_click(cx.listener(|this, _, _, cx| this.save(cx))),
                                )
                                .child(control("custom-cancel", "Cancel", !busy).on_click(
                                    cx.listener(|this, _, _, cx| {
                                        if !this.loading {
                                            this.editor = None;
                                            this.error = None;
                                            this.revision += 1;
                                            cx.notify();
                                        }
                                    }),
                                )),
                        ),
                )
            })
            .when(self.editor.is_none(), |v| {
                v.when(all.is_empty() && !busy && self.error.is_none(), |v| {
                    v.child(
                        div()
                            .debug_selector(|| "custom-empty".into())
                            .child("Nothing here yet"),
                    )
                })
                .when(!all.is_empty() && rows.is_empty(), |v| {
                    v.child(
                        div()
                            .debug_selector(|| "custom-no-matches".into())
                            .child("No matches"),
                    )
                })
                .children(rows.into_iter().enumerate().map(|(i, row)| {
                    let copy = row.clone();
                    let edit = row.clone();
                    let delete = row.clone();
                    div()
                        .debug_selector(move || format!("custom-row-{i}"))
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .p(px(12.))
                        .border_1()
                        .border_color(theme().border)
                        .child(row.title)
                        .child(row.body)
                        .child(
                            div()
                                .flex()
                                .gap(px(8.))
                                .child(
                                    control(&format!("custom-copy-{i}"), "Copy", !busy).on_click(
                                        cx.listener(move |this, _, _, cx| {
                                            this.copy(copy.clone(), cx)
                                        }),
                                    ),
                                )
                                .when(self.tab == "prompts", |v| {
                                    v.child(
                                        control(&format!("custom-edit-{i}"), "Edit", !busy)
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.edit(Some(edit.clone()), window, cx)
                                            })),
                                    )
                                    .child(
                                        control(&format!("custom-delete-{i}"), "Delete", !busy)
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                if !this.loading {
                                                    this.deleting = Some(delete.clone());
                                                    this.revision += 1;
                                                    cx.notify();
                                                }
                                            })),
                                    )
                                }),
                        )
                }))
            })
            .when_some(self.deleting.clone(), |v, id| {
                v.child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child("Delete saved prompt?")
                        .child(control("custom-delete-confirm", "Delete", !busy).on_click(
                            cx.listener(move |this, _, _, cx| {
                                this.load(
                                    Some((
                                        "DELETE".into(),
                                        format!(
                                            "/api/prompt-library/{}?expectedUpdatedAt={}",
                                            escape(&id.id),
                                            id.updated_at.unwrap()
                                        ),
                                        json!({}),
                                    )),
                                    cx,
                                )
                            }),
                        ))
                        .child(control("custom-delete-cancel", "Cancel", !busy).on_click(
                            cx.listener(|this, _, _, cx| {
                                if !this.loading {
                                    this.deleting = None;
                                    this.revision += 1;
                                    cx.notify();
                                }
                            }),
                        )),
                )
            })
            .child(canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision)).size(px(1.)))
    }
}
