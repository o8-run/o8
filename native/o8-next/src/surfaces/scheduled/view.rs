//! The Scheduled page (AutomationsPage.tsx, AutomationRow.tsx and
//! ConnectedAgentAutomations.tsx): local automations with run, pause, edit,
//! delete and fire history, then the connected agents' own schedules.
use super::editor::Editor;
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, Div, FocusHandle, ScrollHandle, SharedString, Stateful};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Classic's owner for the operator's own automations.
pub(super) const OWNER: &str = "operator";
const REFRESH: Duration = Duration::from_secs(15);
const PAGE_WIDTH: f32 = 1040.;
const ADD: &str = "M12 5v14M5 12h14";

pub(crate) struct Scheduled {
    pub(super) client: Client,
    pub(crate) focus: FocusHandle,
    scroll: ScrollHandle,
    rows: Vec<Value>,
    pub(crate) loading: bool,
    error: Option<String>,
    connected: Option<Result<Value, String>>,
    /// Registered repositories as (local path, default branch).
    pub(super) repos: Vec<(String, String)>,
    fetched: Option<Instant>,
    in_flight: bool,
    busy: HashMap<String, &'static str>,
    confirm: Option<String>,
    history: HashSet<String>,
    show_all: bool,
    pub(super) editor: Option<Entity<Editor>>,
    _editor_events: Option<gpui::Subscription>,
}

impl Scheduled {
    pub(crate) fn new(client: Client, _: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self {
            client,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            rows: vec![],
            loading: true,
            error: None,
            connected: None,
            repos: vec![],
            fetched: None,
            in_flight: false,
            busy: HashMap::new(),
            confirm: None,
            history: HashSet::new(),
            show_all: false,
            editor: None,
            _editor_events: None,
        };
        view.load(cx);
        view
    }

    /// Classic refreshes every 15 seconds while the page is open.
    pub(crate) fn tick(&mut self, refresh: bool, cx: &mut Context<Self>) {
        if refresh || self.fetched.is_none_or(|at| at.elapsed() >= REFRESH) {
            self.load(cx);
        }
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        if self.in_flight {
            return;
        }
        self.in_flight = true;
        self.fetched = Some(Instant::now());
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let rows =
                call(&client, "GET", "/api/automations", None).and_then(|data| match data["error"]
                    .as_str()
                {
                    Some(error) => Err(error.to_owned()),
                    None => Ok(data["automations"].as_array().cloned().unwrap_or_default()),
                });
            let connected = call(&client, "GET", "/api/automations/connected", None);
            let repos = call(&client, "GET", "/api/panel/repos", None)
                .map(|data| {
                    data["repos"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|repo| {
                            let path = repo["localPath"].as_str()?.to_owned();
                            let branch = repo["defaultBranch"].as_str().unwrap_or("main");
                            Some((path, branch.to_owned()))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            (rows, connected, repos)
        });
        cx.spawn(async move |this, cx| {
            let (rows, connected, repos) = task.await;
            let _ = this.update(cx, |this, cx| {
                this.in_flight = false;
                this.loading = false;
                match rows {
                    Ok(rows) => {
                        this.rows = rows;
                        this.error = None;
                    }
                    Err(error) => {
                        this.rows.clear();
                        this.error = Some(error);
                    }
                }
                this.connected = Some(connected);
                if !repos.is_empty() {
                    this.repos = repos;
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// One mutation, applied optimistically and reconciled with the server.
    fn mutate(
        &mut self,
        id: String,
        busy: &'static str,
        method: &'static str,
        path: String,
        body: Option<Value>,
        cx: &mut Context<Self>,
    ) {
        self.busy.insert(id.clone(), busy);
        cx.notify();
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { call(&client, method, &path, body) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy.remove(&id);
                match result {
                    Ok(data) if data["ok"] == false => {
                        this.fail(&id, data["note"].as_str().unwrap_or("Run failed"));
                    }
                    Ok(data) => {
                        if let Some(record) = data.get("automation").filter(|r| r.is_object()) {
                            this.persisted(record.clone());
                        }
                    }
                    Err(error) => this.fail(&id, &error),
                }
                this.load(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn fail(&mut self, id: &str, message: &str) {
        if let Some(row) = self.rows.iter_mut().find(|r| r["id"] == id) {
            row["lastRunStatus"] = json!("error");
            row["lastErrorMessage"] = json!(message);
        }
    }

    pub(super) fn persisted(&mut self, record: Value) {
        match self.rows.iter_mut().find(|r| r["id"] == record["id"]) {
            Some(row) => *row = record,
            None => self.rows.insert(0, record),
        }
    }

    fn toggle(&mut self, id: String, enabled: bool, cx: &mut Context<Self>) {
        if let Some(row) = self.rows.iter_mut().find(|r| r["id"] == id) {
            row["enabled"] = json!(enabled);
        }
        let path = format!("/api/automations/{id}");
        self.mutate(
            id,
            "toggle",
            "PATCH",
            path,
            Some(json!({"enabled": enabled})),
            cx,
        );
    }

    fn run(&mut self, id: String, run_anyway: bool, cx: &mut Context<Self>) {
        if let Some(row) = self.rows.iter_mut().find(|r| r["id"] == id) {
            row["lastRunStatus"] = json!("running");
            row["lastRunAt"] = json!(now_ms());
        }
        let path = format!("/api/automations/{id}/run");
        let body = json!({"clientMutationId": mutation_id(), "runAnyway": run_anyway});
        self.mutate(id, "run", "POST", path, Some(body), cx);
    }

    fn delete(&mut self, id: String, cx: &mut Context<Self>) {
        self.confirm = None;
        self.rows.retain(|r| r["id"] != id);
        let path = format!("/api/automations/{id}");
        self.mutate(id, "delete", "DELETE", path, None, cx);
    }

    fn toggle_connected(&mut self, id: String, enabled: bool, cx: &mut Context<Self>) {
        if let Some(Ok(data)) = &mut self.connected
            && let Some(job) = data["jobs"]
                .as_array_mut()
                .and_then(|jobs| jobs.iter_mut().find(|j| j["id"] == id))
        {
            job["enabled"] = json!(enabled);
        }
        let body = json!({"id": id, "enabled": enabled});
        let key = format!("connected:{id}");
        self.mutate(
            key,
            "toggle",
            "PATCH",
            "/api/automations/connected".into(),
            Some(body),
            cx,
        );
    }

    fn open_editor(&mut self, row: Option<Value>, window: &mut Window, cx: &mut Context<Self>) {
        let owner = cx.entity().downgrade();
        let repos = self.repos.clone();
        let editor = cx.new(|cx| Editor::new(owner, row, repos, window, cx));
        self._editor_events = Some(cx.subscribe_in(
            &editor,
            window,
            |this, _, event: &super::editor::Done, window, cx| {
                if let Some(record) = &event.0 {
                    this.persisted(record.clone());
                    this.load(cx);
                }
                this.editor = None;
                this._editor_events = None;
                this.focus.focus(window);
                cx.notify();
            },
        ));
        self.editor = Some(editor);
        cx.notify();
    }

    fn mine(&self) -> Vec<Value> {
        self.rows
            .iter()
            .filter(|row| row["owner"] == OWNER)
            .cloned()
            .collect()
    }

    fn connected_jobs(&self) -> Vec<Value> {
        match &self.connected {
            Some(Ok(data)) if data["installed"] != false => {
                data["jobs"].as_array().cloned().unwrap_or_default()
            }
            _ => vec![],
        }
    }

    fn header(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let mine = self.mine();
        let active = mine
            .iter()
            .filter(|r| r["enabled"] == true && r["lastRunStatus"] != "idle")
            .count()
            + self
                .connected_jobs()
                .iter()
                .filter(|j| j["enabled"] == true)
                .count();
        let status = if self.loading || self.connected.is_none() {
            "Loading activity…".to_owned()
        } else if self.error.is_some() || matches!(self.connected, Some(Err(_))) {
            "Activity unavailable".to_owned()
        } else {
            format!("{active} active")
        };
        div()
            .flex()
            .items_start()
            .justify_between()
            .gap(px(16.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(div().text_size(px(24.)).child("Scheduled"))
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(theme().text_muted)
                            .child("Automate repetitive tasks with agents that run on schedules and triggers."),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .flex_shrink_0()
                    .child(
                        div()
                            .text_size(px(9.5))
                            .text_color(theme().text_faint)
                            .child(status),
                    )
                    .child(
                        pill("scheduled-new", cx)
                            .child(crate::icon::stroke(ADD, theme().text, 12., 1.8))
                            .child("New automation")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open_editor(None, window, cx)
                            })),
                    ),
            )
    }

    fn row(&self, row: &Value, cx: &mut Context<Self>) -> impl IntoElement {
        let id = row["id"].as_str().unwrap_or("").to_owned();
        let enabled = row["enabled"] == true;
        let busy = self.busy.get(&id).copied();
        let running = row["lastRunStatus"] == "running" || busy == Some("run");
        let trigger = match row["triggerKind"].as_str() {
            Some("cron") => format!("cron {}", row["cronExpr"].as_str().unwrap_or(""))
                .trim()
                .to_owned(),
            Some("watch") => format!(
                "{} {}",
                row["watchState"].as_str().unwrap_or("watch"),
                row["watchSourceKind"].as_str().unwrap_or("source")
            ),
            _ => "manual".into(),
        };
        let mut meta = vec![
            trigger,
            basename(row["repoPath"].as_str().unwrap_or("")),
            row["runtime"].as_str().unwrap_or("").to_owned(),
        ];
        if row["precheckCommand"].is_string() {
            meta.push("precheck".into());
        }
        meta.push(match row["lastRunAt"].as_f64() {
            None => "never ran".into(),
            Some(at) => format!("last ran {}", relative(Some(at), "just now")),
        });
        if row["triggerKind"] == "cron" && enabled {
            meta.push(format!(
                "next {}",
                relative(row["nextRunAt"].as_f64(), "unscheduled")
            ));
        }
        let fires = row["fireMetrics"]["count"].as_u64().unwrap_or(0);
        let history_open = self.history.contains(&id);
        let confirming = self.confirm.as_deref() == Some(id.as_str());
        let (history_id, run_id, edit_id, delete_id, toggle_id) =
            (id.clone(), id.clone(), id.clone(), id.clone(), id.clone());
        let record = row.clone();
        let name = row["name"].as_str().unwrap_or("Untitled").to_owned();
        let group = SharedString::from(format!("scheduled-row-{id}"));
        div()
            .id(group.clone())
            .group(group.clone())
            .debug_selector({
                let group = group.clone();
                move || group.to_string()
            })
            .flex()
            .flex_col()
            .rounded(px(9.))
            .opacity(if enabled { 1. } else { 0.62 })
            .hover(|d| d.bg(theme().hover))
            .when(confirming, |d| d.bg(theme().hover))
            .child(
                div()
                    .min_h(px(52.))
                    .flex()
                    .items_center()
                    .gap(px(9.))
                    .px(px(10.))
                    .py(px(7.))
                    .child(
                        div()
                            .size(px(6.))
                            .flex_shrink_0()
                            .rounded_full()
                            .bg(status_color(
                                row["lastRunStatus"].as_str().unwrap_or("idle"),
                            )),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(
                                div()
                                    .text_size(px(13.5))
                                    .whitespace_nowrap()
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .child(name.clone()),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .text_size(px(9.5))
                                    .text_color(theme().text_muted)
                                    .whitespace_nowrap()
                                    .overflow_hidden()
                                    .child(meta.join("  ·  "))
                                    .child("  ·  ")
                                    .child(
                                        link(
                                            format!("scheduled-history-{id}"),
                                            format!("history {fires}"),
                                        )
                                        .on_click(
                                            cx.listener(move |this, _, _, cx| {
                                                if !this.history.remove(&history_id) {
                                                    this.history.insert(history_id.clone());
                                                }
                                                cx.notify();
                                            }),
                                        ),
                                    ),
                            ),
                    )
                    .child(
                        toggle(
                            format!("scheduled-toggle-{id}"),
                            enabled,
                            busy == Some("toggle"),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.toggle(toggle_id.clone(), !enabled, cx)
                        })),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(2.))
                            .invisible()
                            .group_hover(group.clone(), |d| d.visible())
                            .when(confirming, |d| d.visible())
                            .child(
                                action(
                                    format!("scheduled-run-{id}"),
                                    if running { "Running" } else { "Run" },
                                    false,
                                    running,
                                )
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        if !running {
                                            this.run(run_id.clone(), false, cx)
                                        }
                                    },
                                )),
                            )
                            .child(
                                action(format!("scheduled-edit-{id}"), "Edit", false, false)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        let _ = &edit_id;
                                        this.open_editor(Some(record.clone()), window, cx)
                                    })),
                            )
                            .child(
                                action(format!("scheduled-delete-{id}"), "Delete", true, false)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.confirm = Some(delete_id.clone());
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .when(history_open, |d| d.child(self.history_panel(row, cx)))
            .when(confirming, |d| {
                let (confirm_id, label) = (
                    id.clone(),
                    if busy == Some("delete") {
                        "Deleting"
                    } else {
                        "Confirm delete"
                    },
                );
                d.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .px(px(10.))
                        .py(px(8.))
                        .border_t_1()
                        .border_color(theme().border)
                        .child(
                            div()
                                .flex_1()
                                .text_size(px(11.))
                                .text_color(theme().text_muted)
                                .child(format!("Delete “{name}”? This can’t be undone.")),
                        )
                        .child(
                            action("scheduled-delete-cancel".into(), "Cancel", false, false)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.confirm = None;
                                    cx.notify();
                                })),
                        )
                        .child(
                            action("scheduled-delete-confirm".into(), label, true, false).on_click(
                                cx.listener(move |this, _, _, cx| {
                                    this.delete(confirm_id.clone(), cx)
                                }),
                            ),
                        ),
                )
            })
    }

    fn history_panel(&self, row: &Value, cx: &mut Context<Self>) -> impl IntoElement {
        let metrics = &row["fireMetrics"];
        let fires = row["fires"].as_array().cloned().unwrap_or_default();
        let id = row["id"].as_str().unwrap_or("").to_owned();
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .px(px(25.))
            .py(px(8.))
            .border_t_1()
            .border_color(theme().border)
            .child(
                div()
                    .text_size(px(9.5))
                    .text_color(theme().text_faint)
                    .child(format!(
                        "queue p50 {} · p95 {} · max concurrent {} · duplicates {}",
                        duration(metrics["queueDelayMs"]["p50"].as_f64()),
                        duration(metrics["queueDelayMs"]["p95"].as_f64()),
                        metrics["maxConcurrentFires"].as_u64().unwrap_or(0),
                        metrics["duplicateFireCount"].as_u64().unwrap_or(0),
                    )),
            )
            .when(fires.is_empty(), |d| {
                d.child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child("No fires recorded yet."),
                )
            })
            .children(fires.into_iter().enumerate().map(|(index, fire)| {
                let status = fire["status"]
                    .as_str()
                    .unwrap_or("pending")
                    .replace('_', " ");
                let skipped = matches!(
                    fire["status"].as_str(),
                    Some("skipped_precheck" | "precheck_error")
                );
                let run_id = id.clone();
                div()
                    .min_h(px(26.))
                    .flex()
                    .items_center()
                    .gap(px(7.))
                    .child(
                        div()
                            .size(px(5.))
                            .flex_shrink_0()
                            .rounded_full()
                            .bg(fire_color(fire["status"].as_str().unwrap_or(""))),
                    )
                    .child(
                        div()
                            .w(px(92.))
                            .text_size(px(10.5))
                            .text_color(theme().text_muted)
                            .child(status),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_size(px(10.5))
                            .text_color(theme().text_muted)
                            .child(format!(
                                "{} · {} · {}",
                                fire["source"].as_str().unwrap_or(""),
                                relative(fire["scheduledAt"].as_f64(), "now"),
                                explain(&fire)
                            )),
                    )
                    .when(skipped, |d| {
                        d.child(
                            action(
                                format!("scheduled-run-anyway-{index}"),
                                "Run anyway",
                                false,
                                false,
                            )
                            .on_click(
                                cx.listener(move |this, _, _, cx| {
                                    this.run(run_id.clone(), true, cx)
                                }),
                            ),
                        )
                    })
            }))
    }

    fn connected_section(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let jobs = match &self.connected {
            None => {
                return Some(section_note("Reading connected schedules…").into_any_element());
            }
            Some(Err(error)) => {
                return Some(
                    section_note(&format!("Connected agent schedules unavailable: {error}"))
                        .into_any_element(),
                );
            }
            Some(Ok(data)) if data["installed"] == false || data["available"] == false => {
                return None;
            }
            Some(Ok(_)) => self.connected_jobs(),
        };
        if jobs.is_empty() {
            return None;
        }
        let count = jobs.len();
        Some(
            div()
                .flex()
                .flex_col()
                .child(section_header("Connected agent schedules", count))
                .children(jobs.into_iter().map(|job| {
                    let id = job["id"].as_str().unwrap_or("").to_owned();
                    let enabled = job["enabled"] == true;
                    let busy = self.busy.contains_key(&format!("connected:{id}"));
                    let toggle_id = id.clone();
                    div()
                        .min_h(px(52.))
                        .flex()
                        .items_center()
                        .gap(px(9.))
                        .px(px(10.))
                        .py(px(7.))
                        .opacity(if enabled { 1. } else { 0.62 })
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .gap(px(4.))
                                .child(
                                    div()
                                        .text_size(px(13.5))
                                        .child(job["name"].as_str().unwrap_or("").to_owned()),
                                )
                                .child(
                                    div()
                                        .text_size(px(9.5))
                                        .text_color(theme().text_muted)
                                        .whitespace_nowrap()
                                        .overflow_hidden()
                                        .text_ellipsis()
                                        .child(format!(
                                            "{} · {} · Next {} · Last {} ({})",
                                            schedule_label(&job["schedule"]),
                                            job["agentId"].as_str().unwrap_or(""),
                                            relative(job["nextRunAt"].as_f64(), "unscheduled"),
                                            relative(job["lastRunAt"].as_f64(), "never"),
                                            job["lastRunStatus"].as_str().unwrap_or("idle"),
                                        )),
                                ),
                        )
                        .child(
                            action(
                                format!("scheduled-connected-{id}"),
                                if busy {
                                    "Updating…"
                                } else if enabled {
                                    "Pause"
                                } else {
                                    "Resume"
                                },
                                false,
                                busy,
                            )
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    this.toggle_connected(toggle_id.clone(), !enabled, cx)
                                },
                            )),
                        )
                }))
                .into_any_element(),
        )
    }
}

impl Render for Scheduled {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mine = self.mine();
        let count = mine.len();
        let shown: Vec<_> = if self.show_all {
            mine.clone()
        } else {
            mine.iter().take(6).cloned().collect()
        };
        let connected_count = self.connected_jobs().len();
        let rows: Vec<AnyElement> = shown
            .iter()
            .map(|row| self.row(row, cx).into_any_element())
            .collect();
        let empty = !self.loading
            && self.error.is_none()
            && count == 0
            && connected_count == 0
            && matches!(self.connected, Some(Ok(_)));
        div()
            .size_full()
            .relative()
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .font_weight(gpui::FontWeight::LIGHT)
            .child(
                div()
                    .id("scheduled-page")
                    .debug_selector(|| "scheduled-page".into())
                    // The editor overlay sits outside, so its clicks keep their field focused.
                    .track_focus(&self.focus)
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .child(
                        div()
                            .w_full()
                            .max_w(px(PAGE_WIDTH))
                            .mx_auto()
                            .min_h_full()
                            .flex()
                            .flex_col()
                            .gap(px(14.))
                            .pt(px(72.))
                            .px(px(28.))
                            .pb(px(64.))
                            .child(self.header(cx))
                            .when(self.loading, |d| {
                                d.child(div().pt(px(32.)).text_size(px(11.)).text_color(theme().text_faint).child("Loading…"))
                            })
                            .when_some(self.error.clone().filter(|_| !self.loading), |d, error| {
                                d.child(empty_state("Automations unavailable", &error, None, cx))
                            })
                            .when(!self.loading && self.error.is_none() && count > 0, |d| {
                                d.child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .child(section_header("Automations", count))
                                        .children(rows)
                                        .when(!self.show_all && count > 6, |d| {
                                            d.child(
                                                link("scheduled-show-all".into(), format!("Show {} more", count - 6))
                                                    .px(px(10.))
                                                    .py(px(5.))
                                                    .text_size(px(12.))
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.show_all = true;
                                                        cx.notify();
                                                    })),
                                            )
                                        }),
                                )
                            })
                            .children(self.connected_section(cx))
                            .when(empty, |d| {
                                d.child(empty_state(
                                    "Let agents handle the repeat work",
                                    "Create a local automation that runs a prompt manually or on a cron schedule.",
                                    Some("New automation"),
                                    cx,
                                ))
                            })
                            .child(div().flex_1())
                            .child(
                                div()
                                    .pt(px(4.))
                                    .text_size(px(9.5))
                                    .text_color(theme().text_faint)
                                    .child("Automations refresh every 15 seconds while this page is open."),
                            ),
                    ),
            )
            .children(self.editor.clone())
    }
}

/// GET or a mutation; a refusal reads the route's own error and note.
pub(super) fn call(
    client: &Client,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    if method == "GET" {
        return client.get(path, &[]);
    }
    let url = client.url(path).map_err(|_| "Invalid route".to_owned())?;
    let request = client.request(method, &url);
    let response = match body {
        Some(body) => request.send_json(body),
        None => request.call(),
    };
    match response {
        Ok(response) => Client::read::<Value>(response).or_else(|_| Ok(Value::Null)),
        Err(ureq::Error::Status(status, response)) => {
            let data = Client::read::<Value>(response).unwrap_or(Value::Null);
            let message = data["error"]
                .as_str()
                .or(data["note"].as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Request refused (HTTP {status})"));
            Err(message)
        }
        Err(_) => Err("Could not reach the selected server".into()),
    }
}

pub(super) fn pill(id: &'static str, _: &mut Context<Scheduled>) -> Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .h(px(28.))
        .px(px(12.))
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded(px(8.))
        .border_1()
        .border_color(theme().border)
        .bg(theme().surface_raised)
        .text_size(px(12.))
        .cursor_pointer()
        .hover(|d| d.bg(theme().hover))
}

fn link(id: String, label: impl Into<SharedString>) -> Stateful<Div> {
    let selector = id.clone();
    div()
        .id(SharedString::from(id))
        .debug_selector(move || selector.clone())
        .cursor_pointer()
        .hover(|d| d.text_color(theme().text).underline())
        .child(label.into())
}

pub(super) fn action(
    id: String,
    label: &'static str,
    danger: bool,
    disabled: bool,
) -> Stateful<Div> {
    let selector = id.clone();
    div()
        .id(SharedString::from(id))
        .debug_selector(move || selector.clone())
        .h(px(24.))
        .px(px(8.))
        .flex()
        .items_center()
        .rounded(px(6.))
        .text_size(px(11.))
        .text_color(if danger {
            theme().danger
        } else {
            theme().text_muted
        })
        .opacity(if disabled { 0.5 } else { 1. })
        .when(!disabled, |d| {
            d.cursor_pointer().hover(|d| d.bg(theme().hover))
        })
        .child(label)
}

/// Classic's 32×18 switch.
fn toggle(id: String, on: bool, busy: bool) -> Stateful<Div> {
    let selector = id.clone();
    div()
        .id(SharedString::from(id))
        .debug_selector(move || selector.clone())
        .relative()
        .flex_shrink_0()
        .w(px(32.))
        .h(px(18.))
        .rounded(px(9.))
        .cursor_pointer()
        .bg(if on { theme().accent } else { theme().border })
        .opacity(if busy { 0.55 } else { 1. })
        .child(
            div()
                .absolute()
                .top(px(2.))
                .left(px(if on { 16. } else { 2. }))
                .size(px(14.))
                .rounded_full()
                .bg(theme().surface_raised),
        )
}

fn section_header(label: &'static str, count: usize) -> impl IntoElement {
    div()
        .flex()
        .items_baseline()
        .gap(px(7.))
        .pt(px(14.))
        .pb(px(4.))
        .text_color(theme().text_faint)
        .child(div().text_size(px(10.)).child(label.to_uppercase()))
        .child(div().text_size(px(9.5)).child(count.to_string()))
}

fn section_note(text: &str) -> impl IntoElement {
    div()
        .pt(px(14.))
        .text_size(px(11.))
        .text_color(theme().text_faint)
        .child(text.to_owned())
}

fn empty_state(
    title: &str,
    body: &str,
    action: Option<&'static str>,
    cx: &mut Context<Scheduled>,
) -> impl IntoElement {
    div()
        .mt(px(16.))
        .flex()
        .flex_col()
        .items_center()
        .gap(px(6.))
        .py(px(30.))
        .px(px(24.))
        .border_1()
        .border_color(theme().border)
        .rounded(px(10.))
        .child(
            div()
                .text_size(px(13.5))
                .text_color(theme().text)
                .child(title.to_owned()),
        )
        .child(
            div()
                .max_w(px(420.))
                .text_size(px(12.))
                .text_color(theme().text_muted)
                .text_center()
                .child(body.to_owned()),
        )
        .when_some(action, |d, label| {
            d.child(
                div().mt(px(8.)).child(
                    pill("scheduled-empty-new", cx)
                        .child(crate::icon::stroke(ADD, theme().text, 12., 1.8))
                        .child(label)
                        .on_click(
                            cx.listener(|this, _, window, cx| this.open_editor(None, window, cx)),
                        ),
                ),
            )
        })
}

fn status_color(status: &str) -> gpui::Rgba {
    match status {
        "running" => theme().accent,
        "ok" => theme().success,
        "error" => theme().danger,
        _ => theme().text_faint,
    }
}

fn fire_color(status: &str) -> gpui::Rgba {
    match status {
        "leased" => theme().accent,
        "succeeded" => theme().success,
        "skipped_precheck" => theme().text_muted,
        "precheck_error" | "parked" | "cancelled" => theme().danger,
        "retrying" | "recovered" => theme().warning,
        _ => theme().text_faint,
    }
}

/// AutomationRow's fireExplanation.
pub(super) fn explain(fire: &Value) -> String {
    let note = |fallback: &str| {
        fire["resultNote"]
            .as_str()
            .filter(|n| !n.is_empty())
            .unwrap_or(fallback)
            .to_owned()
    };
    let recoveries = fire["recoveryCount"].as_u64().unwrap_or(0);
    let message = match fire["status"].as_str().unwrap_or("") {
        "retrying" => format!(
            "Retry {} of {} queued",
            fire["attemptCount"].as_u64().unwrap_or(0) + 1,
            fire["maxAttempts"].as_u64().unwrap_or(0)
        ),
        "recovered" => format!(
            "Recovered after {recoveries} lost lease{}",
            if recoveries == 1 { "" } else { "s" }
        ),
        "parked" => note("Parked after bounded retries"),
        "cancelled" => note("Cancelled"),
        "skipped_precheck" => note("Precheck skipped the agent launch"),
        "precheck_error" => fire["precheckErrorMessage"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| note("Precheck failed closed")),
        _ if recoveries > 0 => format!(
            "Recovered {recoveries} time{}",
            if recoveries == 1 { "" } else { "s" }
        ),
        "succeeded" => note("Dispatched successfully"),
        _ => note("Waiting for capacity"),
    };
    if fire["source"] == "watch" {
        let source = fire["sourceId"]
            .as_str()
            .or(fire["sourceKind"].as_str())
            .unwrap_or("configured source");
        format!(
            "{} from {source} · {message}",
            fire["sourceEventType"].as_str().unwrap_or("event")
        )
    } else {
        message
    }
}

/// ConnectedAgentAutomations' scheduleLabel.
pub(super) fn schedule_label(schedule: &Value) -> String {
    let tz = schedule["tz"]
        .as_str()
        .map(|tz| format!(" · {tz}"))
        .unwrap_or_default();
    match schedule["kind"].as_str() {
        Some("cron") if schedule["expr"].is_string() => {
            let expr = schedule["expr"].as_str().unwrap();
            let parts: Vec<&str> = expr.split_whitespace().collect();
            let daily = parts.len() == 5 && parts[2..] == ["*", "*", "*"];
            match (
                daily,
                parts.first().and_then(|m| m.parse::<u32>().ok()),
                parts.get(1).and_then(|h| h.parse::<u32>().ok()),
            ) {
                (true, Some(minute), Some(hour)) if minute < 60 && hour < 24 => format!(
                    "Daily at {}:{minute:02} {}{tz}",
                    if hour % 12 == 0 { 12 } else { hour % 12 },
                    if hour < 12 { "AM" } else { "PM" }
                ),
                _ => format!("{expr}{tz}"),
            }
        }
        Some("every") if schedule["everyMs"].is_number() => {
            let ms = schedule["everyMs"].as_f64().unwrap();
            let hours = ms / 3_600_000.;
            if hours.fract() == 0. {
                format!("Every {hours}h")
            } else {
                format!("Every {}m", (ms / 60_000.).round())
            }
        }
        Some("at") if schedule["at"].is_string() => {
            format!("Once · {}", schedule["at"].as_str().unwrap())
        }
        _ => "Unknown schedule".into(),
    }
}

fn basename(path: &str) -> String {
    path.rsplit('/')
        .find(|p| !p.is_empty())
        .unwrap_or(path)
        .to_owned()
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.)
}

fn mutation_id() -> String {
    format!("native-{}-{}", std::process::id(), now_ms() as u64)
}

/// AutomationRow's formatRelative.
pub(super) fn relative(ms: Option<f64>, fallback: &str) -> String {
    const MINUTE: f64 = 60_000.;
    const HOUR: f64 = 3_600_000.;
    const DAY: f64 = 86_400_000.;
    let Some(ms) = ms else {
        return fallback.to_owned();
    };
    let delta = ms - now_ms();
    if delta < 0. {
        let ago = -delta;
        return if ago < MINUTE {
            "just now".into()
        } else if ago < HOUR {
            format!("{}m ago", (ago / MINUTE).floor().max(1.))
        } else if ago < DAY {
            format!("{}h ago", (ago / HOUR).floor())
        } else {
            format!("{}d ago", (ago / DAY).floor())
        };
    }
    if delta < HOUR {
        format!("in {}m", (delta / MINUTE).ceil().max(1.))
    } else if delta < DAY {
        let hours = (delta / HOUR).floor();
        let minutes = ((delta % HOUR) / MINUTE).floor();
        if minutes > 0. {
            format!("in {hours}h {minutes}m")
        } else {
            format!("in {hours}h")
        }
    } else {
        format!("in {}d", (delta / DAY).round())
    }
}

fn duration(ms: Option<f64>) -> String {
    match ms {
        None => "—".into(),
        Some(ms) if ms < 1000. => format!("{ms}ms"),
        Some(ms) if ms < 10_000. => format!("{:.1}s", ms / 1000.),
        Some(ms) if ms < 60_000. => format!("{:.0}s", ms / 1000.),
        Some(ms) => format!("{}m", (ms / 60_000.).round()),
    }
}
