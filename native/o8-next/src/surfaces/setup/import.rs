//! First launch: bring existing Codex and Claude Code threads into o8 as
//! chats that continue the same provider session (#5260), over the
//! discovered-session routes (#5450). Importing sends nothing.
use super::{Action, Setup, Step, control};
use crate::{client::Client, theme::current as theme};
use gpui::{
    AnyElement, Context, IntoElement, UniformListScrollHandle, div, prelude::*, px, uniform_list,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    time::Duration,
};

const ROW: f32 = 32.;
const LIST: f32 = 320.;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
    session_key: String,
    backend: String,
    #[serde(default)]
    title: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Group {
    repo_path: String,
    #[serde(default)]
    repo_name: Option<String>,
    session_keys: Vec<String>,
}
#[derive(Clone, Default, Deserialize)]
pub(super) struct Discovered {
    #[serde(default)]
    sessions: Vec<Thread>,
    #[serde(default)]
    projects: Vec<Group>,
}
impl Discovered {
    pub(super) fn load(client: &Client) -> Result<Self, String> {
        client.get("/api/runtime/discovered-sessions", &[])
    }
    pub(super) fn pending(&self) -> bool {
        !self.sessions.is_empty()
    }
}

#[derive(Clone, Copy)]
enum Row {
    Group(usize),
    Thread(usize, usize),
}

pub(super) struct Picker {
    /// Session key to (title, runtime label).
    threads: HashMap<String, (String, &'static str)>,
    groups: Vec<Group>,
    selected: BTreeSet<String>,
    expanded: BTreeSet<usize>,
    /// What the last import did, shown on the projects page.
    pub(super) note: Option<String>,
    scroll: UniformListScrollHandle,
}
impl Default for Picker {
    fn default() -> Self {
        Self {
            threads: HashMap::new(),
            groups: vec![],
            selected: BTreeSet::new(),
            expanded: BTreeSet::new(),
            note: None,
            scroll: UniformListScrollHandle::new(),
        }
    }
}
impl Picker {
    pub(super) fn replace(&mut self, discovered: Discovered) {
        let mut grouped = BTreeSet::new();
        let mut groups = vec![];
        for group in discovered.projects {
            let keys: Vec<String> = group
                .session_keys
                .into_iter()
                .filter(|key| discovered.sessions.iter().any(|s| &s.session_key == key))
                .collect();
            grouped.extend(keys.iter().cloned());
            if !keys.is_empty() {
                groups.push(Group {
                    session_keys: keys,
                    ..group
                });
            }
        }
        let rest: Vec<String> = discovered
            .sessions
            .iter()
            .map(|s| s.session_key.clone())
            .filter(|key| !grouped.contains(key))
            .collect();
        if !rest.is_empty() {
            groups.push(Group {
                repo_path: String::new(),
                repo_name: Some("No project".into()),
                session_keys: rest,
            });
        }
        self.threads = discovered
            .sessions
            .into_iter()
            .map(|s| {
                let label = if s.backend == "codex" {
                    "Codex"
                } else {
                    "Claude Code"
                };
                let title = s
                    .title
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| "Untitled thread".into());
                (s.session_key, (title, label))
            })
            .collect();
        self.groups = groups;
        self.selected.clear();
        self.expanded.clear();
    }
    pub(super) fn pending(&self) -> bool {
        !self.threads.is_empty()
    }
    pub(super) fn selection(&self) -> Vec<String> {
        self.selected.iter().cloned().collect()
    }
    #[cfg(test)]
    pub(super) fn groups(&self) -> Vec<(String, usize)> {
        self.groups
            .iter()
            .map(|g| (g.repo_path.clone(), g.session_keys.len()))
            .collect()
    }
    #[cfg(test)]
    pub(super) fn selected(&self) -> usize {
        self.selected.len()
    }
    fn rows(&self) -> Vec<Row> {
        let mut rows = vec![];
        for (index, group) in self.groups.iter().enumerate() {
            rows.push(Row::Group(index));
            if self.expanded.contains(&index) {
                rows.extend((0..group.session_keys.len()).map(|n| Row::Thread(index, n)));
            }
        }
        rows
    }
    fn chosen_in(&self, group: usize) -> usize {
        self.groups[group]
            .session_keys
            .iter()
            .filter(|key| self.selected.contains(*key))
            .count()
    }
    fn toggle_group(&mut self, group: usize) {
        let keys = &self.groups[group].session_keys;
        if self.chosen_in(group) == keys.len() {
            for key in keys {
                self.selected.remove(key);
            }
        } else {
            self.selected.extend(keys.iter().cloned());
        }
    }
    fn toggle_thread(&mut self, key: &str) {
        if !self.selected.remove(key) {
            self.selected.insert(key.to_owned());
        }
    }
    fn select_all(&mut self) {
        self.selected = self.threads.keys().cloned().collect();
    }

    /// Imports the selection. Threads whose provider session can no longer
    /// resume are dropped and the rest retried once. Returns (imported, skipped).
    pub(super) fn import(client: &Client, keys: Vec<String>) -> Result<(usize, usize), String> {
        let (status, body) = post(client, &keys)?;
        let (status, body, skipped) =
            if status == 409 && body["error"]["code"] == "session_not_resumable" {
                let stale: BTreeSet<&str> = body["error"]["sessionKeys"]
                    .as_array()
                    .map(|keys| keys.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_else(|| body["error"]["sessionKey"].as_str().into_iter().collect());
                let rest: Vec<String> = keys
                    .iter()
                    .filter(|key| !stale.contains(key.as_str()))
                    .cloned()
                    .collect();
                if rest.is_empty() {
                    return Ok((0, keys.len()));
                }
                let skipped = keys.len() - rest.len();
                let (status, body) = post(client, &rest)?;
                (status, body, skipped)
            } else {
                (status, body, 0)
            };
        if status != 200 {
            let message = body["error"]["message"]
                .as_str()
                .or_else(|| body["error"].as_str())
                .unwrap_or("The threads could not be imported.");
            return Err(format!("{message} (HTTP {status})"));
        }
        let count = |field: &str| body[field].as_array().map_or(0, Vec::len);
        Ok((count("created") + count("existing"), skipped))
    }
}

fn post(client: &Client, keys: &[String]) -> Result<(u16, Value), String> {
    let url = client
        .url("/api/runtime/discovered-sessions/import")
        .map_err(|_| "Invalid import route")?;
    // A large selection writes one chat per thread under the server's lease.
    match client
        .request("POST", &url)
        .timeout(Duration::from_secs(120))
        .send_json(json!({ "sessionKeys": keys }))
    {
        Ok(response) => Ok((200, Client::read(response)?)),
        Err(ureq::Error::Status(status, response)) => Ok((
            status,
            Client::read::<Value>(response).unwrap_or(Value::Null),
        )),
        Err(_) => Err("Could not reach the selected server.".into()),
    }
}

/// The note shown on the projects page after an import.
pub(super) fn note(imported: usize, skipped: usize) -> String {
    let threads = |n: usize| if n == 1 { "thread" } else { "threads" };
    match (imported, skipped) {
        (0, 0) => "Nothing was imported.".into(),
        (0, skipped) => format!(
            "None of the {skipped} selected {} can be continued: their saved sessions are missing.",
            threads(skipped)
        ),
        (imported, 0) => format!("Imported {imported} {}.", threads(imported)),
        (imported, skipped) => format!(
            "Imported {imported} {}. {skipped} could not be continued: their saved sessions are missing.",
            threads(imported)
        ),
    }
}

/// Unchecked, checked (✓) or mixed (–) for a partly chosen folder. The marks
/// are drawn white over the accent so they show on every appearance.
fn checkbox(id: String, on: bool, partial: bool) -> gpui::Div {
    const CHECK: &str = "M5 12.5 10 17.5 19 7";
    const MIXED: &str = "M6 12h12";
    let filled = on || partial;
    let mark = if on {
        Some((CHECK, "check"))
    } else if partial {
        Some((MIXED, "mixed"))
    } else {
        None
    };
    div()
        .flex_shrink_0()
        .size(px(16.))
        .rounded(px(3.))
        .border_1()
        .border_color(if filled {
            theme().accent
        } else {
            theme().border
        })
        .when(filled, |v| v.bg(theme().accent))
        .flex()
        .items_center()
        .justify_center()
        .when_some(mark, |v, (path, name)| {
            let selector = format!("{id}-{name}");
            v.child(
                div()
                    .debug_selector(move || selector.clone())
                    .child(crate::icon::stroke(path, gpui::rgb(0xFFFFFF), 12., 3.)),
            )
        })
}

fn row(this: &Setup, row: Row, cx: &mut Context<Setup>) -> AnyElement {
    let picker = &this.import;
    let base = |id: String| {
        let selector = id.clone();
        div()
            .id(gpui::SharedString::from(id))
            .debug_selector(move || selector.clone())
            .h(px(ROW))
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(10.))
            .rounded(px(6.))
            .cursor_pointer()
            .hover(|v| v.bg(theme().hover))
    };
    match row {
        Row::Group(index) => {
            let group = &picker.groups[index];
            let total = group.session_keys.len();
            let chosen = picker.chosen_in(index);
            let open = picker.expanded.contains(&index);
            let name = group.repo_name.clone().unwrap_or_else(|| {
                std::path::Path::new(&group.repo_path)
                    .file_name()
                    .map_or_else(
                        || group.repo_path.clone(),
                        |n| n.to_string_lossy().into_owned(),
                    )
            });
            base(format!("setup-import-group-{index}"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if !this.busy {
                        this.import.toggle_group(index);
                        cx.notify();
                    }
                }))
                .child(
                    div()
                        .id(gpui::SharedString::from(format!(
                            "setup-import-expand-{index}"
                        )))
                        .debug_selector(move || format!("setup-import-expand-{index}"))
                        .w(px(14.))
                        .text_color(theme().text_muted)
                        .child(if open { "▾" } else { "▸" })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            if !this.import.expanded.remove(&index) {
                                this.import.expanded.insert(index);
                            }
                            cx.notify();
                        })),
                )
                .child(checkbox(
                    format!("setup-import-mark-{index}"),
                    chosen == total,
                    chosen > 0 && chosen < total,
                ))
                .child(div().flex_1().min_w_0().truncate().child(name))
                .child(
                    div()
                        .text_color(theme().text_muted)
                        .child(format!("{chosen} of {total}")),
                )
                .into_any_element()
        }
        Row::Thread(group, n) => {
            let key = picker.groups[group].session_keys[n].clone();
            let (title, label) = picker
                .threads
                .get(&key)
                .cloned()
                .unwrap_or_else(|| ("Untitled thread".into(), ""));
            let on = picker.selected.contains(&key);
            base(format!("setup-import-thread-{group}-{n}"))
                .pl(px(32.))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if !this.busy {
                        this.import.toggle_thread(&key);
                        cx.notify();
                    }
                }))
                .child(checkbox(
                    format!("setup-import-mark-{group}-{n}"),
                    on,
                    false,
                ))
                .child(div().flex_1().min_w_0().truncate().child(title))
                .child(div().text_color(theme().text_muted).child(label))
                .into_any_element()
        }
    }
}

pub(super) fn page(this: &Setup, busy: bool, cx: &mut Context<Setup>) -> impl IntoElement {
    let picker = &this.import;
    let total = picker.threads.len();
    let chosen = picker.selected.len();
    let projects = picker.groups.len();
    let rows = picker.rows().len();
    div()
        .debug_selector(|| "setup-import".into())
        .flex()
        .flex_col()
        .gap(px(10.))
        .child(div().text_size(px(24.)).child("Bring in your threads"))
        .child(div().text_color(theme().text_secondary).child(format!(
            "Found {total} Codex and Claude Code {} in {projects} {}. Each one you import \
                 opens as a chat that continues the same session. Nothing is sent until you write.",
            if total == 1 { "thread" } else { "threads" },
            if projects == 1 { "place" } else { "places" },
        )))
        .child(
            div()
                .flex()
                .gap(px(8.))
                .child(
                    control("setup-import-all", "Select all", !busy && chosen < total).on_click(
                        cx.listener(|this, _, _, cx| {
                            if !this.busy {
                                this.import.select_all();
                                cx.notify();
                            }
                        }),
                    ),
                )
                .child(
                    control("setup-import-none", "Select none", !busy && chosen > 0).on_click(
                        cx.listener(|this, _, _, cx| {
                            if !this.busy {
                                this.import.selected.clear();
                                cx.notify();
                            }
                        }),
                    ),
                ),
        )
        .child(
            div()
                .h(px(LIST.min(rows as f32 * ROW + 8.)))
                .p(px(4.))
                .rounded(px(8.))
                .border_1()
                .border_color(theme().border)
                .child(
                    uniform_list(
                        "setup-import-list",
                        rows,
                        cx.processor(|this, range: std::ops::Range<usize>, _, cx| {
                            let rows = this.import.rows();
                            range
                                .filter_map(|i| rows.get(i).copied())
                                .map(|r| row(this, r, cx))
                                .collect::<Vec<_>>()
                        }),
                    )
                    .size_full()
                    .track_scroll(picker.scroll.clone()),
                ),
        )
        .child(
            div()
                .flex()
                .gap(px(8.))
                .child(
                    primary(
                        "setup-import-confirm",
                        match chosen {
                            0 => "Import".to_owned(),
                            1 => "Import 1 thread".to_owned(),
                            n => format!("Import {n} threads"),
                        },
                        !busy && chosen > 0,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        if !this.import.selected.is_empty() {
                            let keys = this.import.selection();
                            this.act(Action::Import(keys), cx);
                        }
                    })),
                )
                .child(
                    control("setup-import-skip", "Skip", !busy)
                        .on_click(cx.listener(|this, _, _, cx| this.navigate(Step::Projects, cx))),
                ),
        )
}

/// The step's main action: accent fill and white label, as the editor's Done.
fn primary(
    id: &str,
    label: impl Into<gpui::SharedString>,
    enabled: bool,
) -> gpui::Stateful<gpui::Div> {
    control(id, label, enabled)
        .bg(theme().accent)
        .border_color(theme().accent)
        .text_color(gpui::rgb(0xFFFFFF))
}
