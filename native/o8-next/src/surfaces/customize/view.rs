//! Native customization inventories and the existing saved-prompt library.
use super::{
    inventory::{Inventory, Row},
    plugins::Plugins,
};
use crate::{client::Client, composer::Composer, theme::current as theme};
use gpui::{
    ClipboardItem, Context, Entity, Render, SharedString, Window, canvas, div, prelude::*, px,
};
use serde_json::{Value, json};
use std::{cell::Cell, collections::HashSet, rc::Rc};

const PAGE_WIDTH: f32 = 1040.;
const TABS: [(&str, &str); 7] = [
    ("rules", "Instructions"),
    ("prompts", "Prompts"),
    ("skills", "Skills"),
    ("connections", "Connections"),
    ("agents", "Agents"),
    ("hooks", "Hooks"),
    ("plugins", "Plugins"),
];
struct Editor {
    id: Option<String>,
    scope: String,
    updated_at: Option<u64>,
    repo_path: Option<String>,
    title: Entity<Composer>,
    body: Entity<Composer>,
    tags: Entity<Composer>,
}
/// The page's Close button.
pub struct Close;
impl gpui::EventEmitter<Close> for Customize {}
pub struct Customize {
    client: Client,
    repo: Option<String>,
    personal: bool,
    tab: String,
    inventory: Inventory,
    query: Entity<Composer>,
    plugins: Entity<Plugins>,
    editor: Option<Editor>,
    deleting: Option<Row>,
    expanded: HashSet<String>,
    loading: bool,
    error: Option<String>,
    revision: u64,
    painted: Rc<Cell<u64>>,
    _subscriptions: Vec<gpui::Subscription>,
}
impl Customize {
    pub fn new(client: Client, repo: Option<String>, cx: &mut Context<Self>) -> Self {
        let query = cx.new(|cx| {
            let mut query = Composer::new(cx);
            query.placeholder = "Search".into();
            query
        });
        let plugins = {
            let (client, repo) = (client.clone(), repo.clone());
            cx.new(|cx| Plugins::new(client, repo, cx))
        };
        let plugins_changed = cx.observe(&plugins, |_, _, cx| cx.notify());
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
            plugins,
            editor: None,
            deleting: None,
            expanded: HashSet::new(),
            loading: false,
            error: None,
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            _subscriptions: vec![subscription, plugins_changed],
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
pub(super) fn control(
    id: &str,
    label: impl Into<SharedString>,
    enabled: bool,
) -> gpui::Stateful<gpui::Div> {
    let selector = id.to_owned();
    div()
        .id(SharedString::from(id.to_owned()))
        .debug_selector(move || selector.clone())
        .h(px(26.))
        .px(px(10.))
        .flex()
        .flex_shrink_0()
        .items_center()
        .rounded(px(7.))
        .text_size(px(12.))
        .text_color(theme().text_secondary)
        .border_1()
        .border_color(theme().border)
        .bg(theme().surface_raised)
        .opacity(if enabled { 1. } else { 0.45 })
        .when(enabled, |v| {
            v.cursor_pointer().hover(|v| v.bg(theme().hover))
        })
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
impl Customize {
    pub fn tab_is(&self, id: &str) -> bool {
        self.tab == id
    }
    pub fn select_tab(&mut self, id: &str, cx: &mut Context<Self>) {
        self.tab = id.into();
        self.editor = None;
        self.deleting = None;
        self.error = None;
        self.revision += 1;
        cx.notify();
    }
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
        let page = div()
            .w_full()
            .max_w(px(PAGE_WIDTH))
            .mx_auto()
            .flex()
            .flex_col()
            .gap(px(14.))
            .pt(px(44.))
            .px(px(28.))
            .pb(px(64.));
        let row_count = rows.len();
        div()
            .id("customize")
            .size_full()
            .overflow_y_scroll()
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .font_weight(gpui::FontWeight::LIGHT)
            .child(
                page.child(
                    div()
                        .flex()
                        .items_end()
                        .justify_between()
                        .gap(px(16.))
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(6.))
                                .child(div().text_size(px(24.)).child("Customize"))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .text_color(theme().text_muted)
                                        .child("What your agents know, can do and connect to."),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_shrink_0()
                                .gap(px(6.))
                                .child(
                                    control("custom-personal", "Personal", !busy)
                                        .bg(if self.personal {
                                            theme().selection
                                        } else {
                                            theme().surface_raised
                                        })
                                        .on_click(
                                            cx.listener(|this, _, _, cx| this.scope(true, cx)),
                                        ),
                                )
                                .when(self.repo.is_some(), |v| {
                                    v.child(
                                        control(
                                            "custom-workspace",
                                            self.repo
                                                .as_deref()
                                                .and_then(|repo| {
                                                    std::path::Path::new(repo).file_name()
                                                })
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
                                        .on_click(
                                            cx.listener(|this, _, _, cx| this.scope(false, cx)),
                                        ),
                                    )
                                })
                                .child(
                                    control("custom-refresh", "Refresh", !busy).on_click(
                                        cx.listener(|this, _, _, cx| this.load(None, cx)),
                                    ),
                                )
                                .child(
                                    control("custom-close", "Close", true)
                                        .on_click(cx.listener(|_, _, _, cx| cx.emit(Close))),
                                ),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap(px(6.))
                        .children(TABS.into_iter().map(|(id, label)| {
                            let count = if id == "plugins" {
                                self.plugins.read(cx).count()
                            } else {
                                self.inventory
                                    .rows
                                    .iter()
                                    .filter(|(kind, _)| kind == id)
                                    .count()
                            };
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
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    if !this.loading {
                                        this.tab = id.into();
                                        this.editor = None;
                                        this.deleting = None;
                                        this.error = None;
                                        this.revision += 1;
                                        cx.notify();
                                    }
                                },
                            ))
                        })),
                )
                .when(self.tab != "plugins", |v| {
                    v.child(
                        div()
                            .debug_selector(|| "custom-search".into())
                            .flex()
                            .w_full()
                            .text_size(px(13.))
                            .child(div().flex_1().min_w_0().child(self.query.clone())),
                    )
                })
                .when(self.tab == "plugins", |v| v.child(self.plugins.clone()))
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
                        control("custom-new", "Save a prompt", !busy).on_click(
                            cx.listener(|this, _, window, cx| this.edit(None, window, cx)),
                        ),
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
                .when(self.editor.is_none() && self.tab != "plugins", |v| {
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
                    .when(row_count > 0, |v| {
                        v.child(
                            div()
                                .flex()
                                .flex_col()
                                .rounded(px(12.))
                                .border_1()
                                .border_color(theme().border)
                                .bg(theme().surface)
                                .overflow_hidden()
                                .children(rows.into_iter().enumerate().map(|(i, row)| {
                                    let copy = row.clone();
                                    let edit = row.clone();
                                    let delete = row.clone();
                                    let key = format!("{}:{}", self.tab, row.title);
                                    let open = self.expanded.contains(&key);
                                    let preview = row
                                        .body
                                        .lines()
                                        .map(str::trim)
                                        .find(|line| !line.is_empty())
                                        .unwrap_or("")
                                        .chars()
                                        .take(180)
                                        .collect::<String>();
                                    div()
                                        .debug_selector(move || format!("custom-row-{i}"))
                                        .flex()
                                        .flex_col()
                                        .gap(px(6.))
                                        .px(px(14.))
                                        .py(px(10.))
                                        .when(i + 1 < row_count, |v| {
                                            v.border_b_1().border_color(theme().border)
                                        })
                                        .hover(|v| v.bg(theme().hover))
                                        .child(
                                            div()
                                                .flex()
                                                .items_center()
                                                .gap(px(12.))
                                                .child(
                                                    div()
                                                        .id(SharedString::from(format!(
                                                            "custom-open-{i}"
                                                        )))
                                                        .debug_selector(move || {
                                                            format!("custom-open-{i}")
                                                        })
                                                        .flex_1()
                                                        .min_w_0()
                                                        .flex()
                                                        .flex_col()
                                                        .gap(px(3.))
                                                        .cursor_pointer()
                                                        .on_click(cx.listener(
                                                            move |this, _, _, cx| {
                                                                if !this.expanded.remove(&key) {
                                                                    this.expanded
                                                                        .insert(key.clone());
                                                                }
                                                                this.revision += 1;
                                                                cx.notify();
                                                            },
                                                        ))
                                                        .child(
                                                            div()
                                                                .text_size(px(13.5))
                                                                .truncate()
                                                                .child(row.title),
                                                        )
                                                        .when(!open, |v| {
                                                            v.child(
                                                                div()
                                                                    .text_size(px(11.))
                                                                    .text_color(theme().text_muted)
                                                                    .truncate()
                                                                    .child(preview),
                                                            )
                                                        }),
                                                )
                                                .child(
                                                    control(
                                                        &format!("custom-copy-{i}"),
                                                        "Copy",
                                                        !busy,
                                                    )
                                                    .on_click(cx.listener(move |this, _, _, cx| {
                                                        this.copy(copy.clone(), cx)
                                                    })),
                                                )
                                                .when(self.tab == "prompts", |v| {
                                                    v.child(
                                                        control(
                                                            &format!("custom-edit-{i}"),
                                                            "Edit",
                                                            !busy,
                                                        )
                                                        .on_click(cx.listener(
                                                            move |this, _, window, cx| {
                                                                this.edit(
                                                                    Some(edit.clone()),
                                                                    window,
                                                                    cx,
                                                                )
                                                            },
                                                        )),
                                                    )
                                                    .child(
                                                        control(
                                                            &format!("custom-delete-{i}"),
                                                            "Delete",
                                                            !busy,
                                                        )
                                                        .on_click(cx.listener(
                                                            move |this, _, _, cx| {
                                                                if !this.loading {
                                                                    this.deleting =
                                                                        Some(delete.clone());
                                                                    this.revision += 1;
                                                                    cx.notify();
                                                                }
                                                            },
                                                        )),
                                                    )
                                                }),
                                        )
                                        .when(open, |v| {
                                            v.child(
                                                div()
                                                    .text_size(px(12.))
                                                    .line_height(px(18.))
                                                    .text_color(theme().text_secondary)
                                                    .child(row.body),
                                            )
                                        })
                                })),
                        )
                    })
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
                .child(canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision)).size(px(1.))),
            )
    }
}
