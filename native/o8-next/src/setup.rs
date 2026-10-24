//! Native first-run project, runtime and privacy flow. All writes use desktop routes.
use crate::{
    client::{Client, Session},
    composer::Composer,
    theme::current as theme,
};
use gpui::{
    Context, Entity, EventEmitter, Render, SharedString, Window, canvas, div, prelude::*, px,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::Cell,
    rc::Rc,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    local_path: String,
}
#[derive(Clone, Copy, PartialEq)]
enum Step {
    Projects,
    Folder,
    Tools,
    Privacy,
}
#[derive(Clone)]
struct Snapshot {
    projects: Vec<Project>,
    setup: Value,
}
impl Snapshot {
    fn load(client: &Client, refresh: bool) -> Result<Self, String> {
        #[derive(Deserialize)]
        struct Projects {
            repos: Vec<Project>,
        }
        let projects = client.get::<Projects>("/api/panel/repos", &[])?.repos;
        let mut query = vec![("include", "setup")];
        if refresh {
            query.push(("refresh", "runtime"));
        }
        let setup = client.get("/api/panel/operator-defaults", &query)?;
        Ok(Self { projects, setup })
    }
    fn available(&self, id: &str) -> bool {
        self.setup["dispatchableRuntimes"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|r| r["id"] == id && r["available"] == true))
    }
    fn ready(&self, backend: &str, workers: &[String]) -> bool {
        let lead = if backend == "claude" || backend == "fable" {
            "claude-code"
        } else {
            backend
        };
        let built_in = self.setup["dispatchableRuntimes"]
            .as_array()
            .is_some_and(|rows| {
                rows.iter()
                    .any(|r| r["builtIn"]["backend"] == backend && r["available"] == true)
            });
        (built_in
            || self.available(lead)
            || backend == "o8"
            || (!backend.is_empty()
                && self.setup["setupRecommendation"]["preserved"] == true
                && !["codex", "claude", "fable", "opencode", "muse"].contains(&backend)))
            && !workers.is_empty()
            && workers.iter().all(|w| self.available(w))
    }
    fn recommendation(&self) -> (String, Vec<String>) {
        let r = &self.setup["setupRecommendation"];
        (
            r["backend"].as_str().unwrap_or("").into(),
            r["workerRuntimes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
        )
    }
}
pub struct Opened(pub Option<Session>);
impl EventEmitter<Opened> for Setup {}
pub struct Setup {
    client: Client,
    snapshot: Option<Snapshot>,
    step: Step,
    project: Option<Project>,
    backend: String,
    workers: Vec<String>,
    folder: Entity<Composer>,
    session_id: String,
    busy: bool,
    error: Option<String>,
    telemetry: bool,
    crashes: bool,
    revision: u64,
    painted: Rc<Cell<u64>>,
}
enum Action {
    Load(bool),
    Choose(Option<Project>),
    Add(String),
    Use,
    Consent,
}
struct ResultState {
    snapshot: Snapshot,
    step: Step,
    project: Option<Project>,
    opened: Option<Option<Session>>,
}
impl Setup {
    #[cfg(test)]
    pub fn painted_page(&self) -> Option<&'static str> {
        (self.painted.get() == self.revision).then_some(match self.step {
            Step::Projects => "projects",
            Step::Folder => "folder",
            Step::Tools => "tools",
            Step::Privacy => "privacy",
        })
    }
    pub fn busy(&self) -> bool {
        self.busy
    }
    pub fn new(client: Client, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            client,
            snapshot: None,
            step: Step::Projects,
            project: None,
            backend: String::new(),
            workers: vec![],
            folder: cx.new(Composer::new),
            session_id: format!(
                "thoughts-next-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
            busy: false,
            error: None,
            telemetry: false,
            crashes: false,
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
        };
        this.act(Action::Load(false), cx);
        this
    }
    fn act(&mut self, action: Action, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        if matches!(action, Action::Use)
            && !self
                .snapshot
                .as_ref()
                .is_some_and(|s| s.ready(&self.backend, &self.workers))
        {
            return;
        }
        self.busy = true;
        self.error = None;
        let client = self.client.clone();
        let snapshot = self.snapshot.clone();
        let project = self.project.clone();
        let backend = self.backend.clone();
        let workers = self.workers.clone();
        let telemetry = self.telemetry;
        let crashes = self.crashes;
        let step = self.step;
        let id = self.session_id.clone();
        let task = cx.background_executor().spawn(async move {
            let mut next = snapshot;
            let mut selected = project;
            let mut target = step;
            let mut finish = false;
            match action {
                Action::Load(refresh) => { next = Some(Snapshot::load(&client, refresh)?); }
                Action::Add(path) => {
                    let added = client.setup_post("/api/panel/repos", &json!({"action":"add", "localPath":path.trim()}))?;
                    selected = Some(serde_json::from_value::<Project>(added["repo"].clone()).map_err(|_| "Invalid project response")?);
                    next = Some(Snapshot::load(&client, true)?); target = Step::Tools;
                }
                Action::Choose(project) => {
                    selected = project;
                    let loaded = Snapshot::load(&client, true)?;
                    Self::registered(&loaded, selected.as_ref())?;
                    let (lead, pool) = loaded.recommendation();
                    if selected.is_some() && !loaded.ready(&lead, &pool) { target = Step::Tools; }
                    else {
                        if loaded.ready(&lead, &pool) && loaded.setup["setupRecommendation"]["preserved"] != true {
                            client.setup_post("/api/panel/operator-defaults", &Self::selection(&loaded, &lead, &pool))?;
                        }
                        if loaded.setup["values"]["telemetryConsentAnswered"] != true { target = Step::Privacy; }
                        else { finish = true; }
                    }
                    next = Some(loaded);
                }
                Action::Use => {
                    let current = Snapshot::load(&client, true)?;
                    if !current.ready(&backend, &workers) { return Err("Your tools changed. Refresh tools before continuing.".into()); }
                    client.setup_post("/api/panel/operator-defaults", &Self::selection(&current, &backend, &workers))?;
                    next = Some(Snapshot::load(&client, false)?);
                    if selected.is_some() {
                        if next.as_ref().unwrap().setup["values"]["telemetryConsentAnswered"] == true { finish = true; }
                        else { target = Step::Privacy; }
                    } else { target = Step::Projects; }
                }
                Action::Consent => {
                    let response = client.setup_post("/api/panel/operator-defaults", &json!({"productTelemetryEnabled":telemetry,"crashReportsEnabled":crashes,"telemetryConsentAnswered":true}))?;
                    if response["values"]["telemetryConsentAnswered"] != true { return Err("Privacy choices could not be confirmed. Try again.".into()); }
                    finish = true;
                }
            }
            let loaded = next.ok_or("Setup has not loaded. Try again.")?;
            let opened = if finish { Some(Self::finish(&client, &loaded, selected.as_ref(), &id)?) } else { None };
            Ok::<_, String>(ResultState { snapshot: loaded, step: target, project: selected, opened })
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(result) => {
                        (this.backend, this.workers) = result.snapshot.recommendation();
                        this.snapshot = Some(result.snapshot);
                        this.project = result.project;
                        this.step = result.step;
                        if let Some(session) = result.opened {
                            cx.emit(Opened(session));
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
    fn registered(snapshot: &Snapshot, project: Option<&Project>) -> Result<(), String> {
        if project.is_some_and(|p| {
            !snapshot
                .projects
                .iter()
                .any(|r| r.id == p.id && r.local_path == p.local_path)
        }) {
            return Err("This project is no longer available. Open its folder again.".into());
        }
        Ok(())
    }
    fn selection(snapshot: &Snapshot, backend: &str, workers: &[String]) -> Value {
        let mut update = json!({"orchestratorBackend":backend,"workerRuntimes":workers,"defaultDispatchRuntime":workers.first()});
        // Preserve the desktop's runtime-specific model fields. A changed lead
        // uses that runtime's default instead of a model from another provider.
        if snapshot.setup["setupRecommendation"]["backend"] == backend {
            let r = &snapshot.setup["setupRecommendation"];
            if backend == "claude" {
                update["orchestratorModel"] = r["leadModel"].clone();
            }
            if backend == "opencode" {
                update["opencodeOrchestratorModel"] = r["leadModel"].clone();
            }
            if r["workerRuntimes"][0] == workers.first().map(String::as_str).unwrap_or("") {
                update[if workers.first().is_some_and(|w| w == "opencode") {
                    "opencodeWorkerModel"
                } else {
                    "defaultDispatchModel"
                }] = r["workerModel"].clone();
            }
        }
        update
    }
    fn finish(
        client: &Client,
        snapshot: &Snapshot,
        project: Option<&Project>,
        id: &str,
    ) -> Result<Option<Session>, String> {
        let current = Snapshot::load(client, true)?;
        Self::registered(&current, project)?;
        let mut completion = json!({"setupComplete":true});
        let mut session = None;
        if let Some(project) = project {
            let (backend, workers) = snapshot.recommendation();
            if !current.ready(&backend, &workers) {
                return Err("Connect a coding tool before opening this project.".into());
            }
            client.setup_post("/api/v2/chat-history", &json!({"tabId":id,"messages":[],"backend":backend,"repoPath":project.local_path,"repoName":project.name,"title":"New conversation"}))?;
            let history: Value = client.get("/api/v2/chat-history", &[("tabId", id)])?;
            completion["repoPath"] = json!(project.local_path);
            completion["completedAt"] = history["savedAt"].clone();
            session = client.sessions()?.into_iter().find(|s| s.id == id);
            if session.is_none() {
                return Err("The conversation could not be reopened. Try again.".into());
            }
        }
        client.setup_post("/api/setup/config", &completion)?;
        Ok(session)
    }
    fn navigate(&mut self, step: Step, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.step = step;
        self.error = None;
        self.revision += 1;
        cx.notify();
    }
}
fn control(id: &str, label: impl Into<SharedString>, enabled: bool) -> gpui::Stateful<gpui::Div> {
    let selector = id.to_owned();
    div()
        .id(SharedString::from(id.to_owned()))
        .debug_selector(move || selector.clone())
        .p(px(8.))
        .rounded(px(6.))
        .bg(theme().surface_raised)
        .border_1()
        .border_color(theme().border)
        .opacity(if enabled { 1. } else { 0.45 })
        .when(enabled, |v| v.cursor_pointer())
        .child(label.into())
}
impl Render for Setup {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = self.busy;
        let snapshot = self.snapshot.clone();
        let ready = snapshot
            .as_ref()
            .is_some_and(|s| s.ready(&self.backend, &self.workers));
        let painted = self.painted.clone();
        let revision = self.revision;
        div()
            .id("setup")
            .size_full()
            .overflow_y_scroll()
            .p(px(24.))
            .flex()
            .flex_col()
            .gap(px(12.))
            .bg(theme().background)
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .child(
                div()
                    .flex()
                    .gap(px(12.))
                    .child(
                        control("setup-back", "Projects", !busy).on_click(
                            cx.listener(|this, _, _, cx| this.navigate(Step::Projects, cx)),
                        ),
                    )
                    .child(
                        control("setup-refresh", "Check again", !busy).on_click(
                            cx.listener(|this, _, _, cx| this.act(Action::Load(true), cx)),
                        ),
                    ),
            )
            .when(busy, |v| {
                v.child(
                    div()
                        .debug_selector(|| "setup-loading".into())
                        .child("Checking setup…"),
                )
            })
            .when_some(self.error.clone(), |v, error| {
                v.child(
                    div()
                        .debug_selector(|| "setup-error".into())
                        .text_color(theme().danger)
                        .child(error),
                )
            })
            .when(self.step == Step::Projects, |v| {
                v.child(
                    div()
                        .debug_selector(|| "setup-projects".into())
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .child(div().text_size(px(24.)).child("Open a project"))
                        .child(
                            control("setup-folder", "Open folder", !busy).on_click(cx.listener(
                                |this, _, window, cx| {
                                    this.navigate(Step::Folder, cx);
                                    this.folder.read(cx).focus.focus(window);
                                },
                            )),
                        )
                        .children(
                            snapshot
                                .as_ref()
                                .map(|s| s.projects.clone())
                                .unwrap_or_default()
                                .into_iter()
                                .enumerate()
                                .map(|(i, project)| {
                                    control(
                                        &format!("setup-project-{i}"),
                                        project.name.clone(),
                                        !busy,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _, _, cx| {
                                            this.act(Action::Choose(Some(project.clone())), cx)
                                        },
                                    ))
                                }),
                        )
                        .when(
                            snapshot.as_ref().is_some_and(|s| s.projects.is_empty()) && !busy,
                            |v| v.child("No projects yet"),
                        )
                        .child(
                            control("setup-change-tools", "Set up tools", !busy).on_click(
                                cx.listener(|this, _, _, cx| this.navigate(Step::Tools, cx)),
                            ),
                        )
                        .child(
                            control("setup-explore", "Start without a project", !busy).on_click(
                                cx.listener(|this, _, _, cx| this.act(Action::Choose(None), cx)),
                            ),
                        ),
                )
            })
            .when(self.step == Step::Folder, |v| {
                v.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .child("Folder path")
                        .child(
                            div()
                                .debug_selector(|| "setup-folder-input".into())
                                .child(self.folder.clone()),
                        )
                        .child(
                            control("setup-add", "Open folder", !busy).on_click(cx.listener(
                                |this, _, _, cx| {
                                    let path = this.folder.read(cx).text.clone();
                                    this.act(Action::Add(path), cx);
                                },
                            )),
                        )
                        .child(control("setup-cancel-folder", "Cancel", !busy).on_click(
                            cx.listener(|this, _, _, cx| {
                                if !this.busy {
                                    this.folder.update(cx, |input, cx| input.clear(cx));
                                    this.navigate(Step::Projects, cx);
                                }
                            }),
                        )),
                )
            })
            .when(self.step == Step::Tools, |v| {
                v.child(
                    div()
                        .debug_selector(|| "setup-tools".into())
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .child(div().text_size(px(24.)).child("Coding tools"))
                        .children(
                            snapshot
                                .as_ref()
                                .map(|s| {
                                    s.setup["dispatchableRuntimes"]
                                        .as_array()
                                        .cloned()
                                        .unwrap_or_default()
                                })
                                .unwrap_or_default()
                                .into_iter()
                                .map(|runtime| {
                                    let id = runtime["id"].as_str().unwrap_or("").to_owned();
                                    let worker = id.clone();
                                    let backend = runtime["builtIn"]["backend"]
                                        .as_str()
                                        .unwrap_or(if id == "claude-code" { "claude" } else { &id })
                                        .to_owned();
                                    let enabled = runtime["available"] == true && !busy;
                                    let lead_enabled = enabled
                                        && (["codex", "claude", "opencode", "muse", "fable", "o8"]
                                            .contains(&backend.as_str())
                                            || runtime["builtIn"].is_object());
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap(px(4.))
                                        .child(
                                            runtime["label"].as_str().unwrap_or("Tool").to_owned(),
                                        )
                                        .when(!enabled, |v| {
                                            v.child(
                                                runtime["detail"]
                                                    .as_str()
                                                    .unwrap_or("Unavailable")
                                                    .to_owned(),
                                            )
                                        })
                                        .child(
                                            div()
                                                .flex()
                                                .gap(px(8.))
                                                .child(
                                                    control(
                                                        &format!("setup-lead-{id}"),
                                                        if self.backend == backend {
                                                            "Lead selected"
                                                        } else {
                                                            "Use as lead"
                                                        },
                                                        lead_enabled,
                                                    )
                                                    .on_click(cx.listener(move |this, _, _, cx| {
                                                        if lead_enabled {
                                                            this.backend = backend.clone();
                                                            this.workers = vec![id.clone()];
                                                            this.revision += 1;
                                                            cx.notify();
                                                        }
                                                    })),
                                                )
                                                .child(
                                                    control(
                                                        &format!("setup-worker-{worker}"),
                                                        if self.workers.contains(&worker) {
                                                            "Worker selected"
                                                        } else {
                                                            "Use as worker"
                                                        },
                                                        enabled,
                                                    )
                                                    .on_click(cx.listener(move |this, _, _, cx| {
                                                        if enabled {
                                                            if this.workers.contains(&worker) {
                                                                if this.workers.len() > 1 {
                                                                    this.workers
                                                                        .retain(|w| w != &worker);
                                                                }
                                                            } else {
                                                                this.workers.push(worker.clone());
                                                            }
                                                            this.revision += 1;
                                                            cx.notify();
                                                        }
                                                    })),
                                                ),
                                        )
                                }),
                        )
                        .when(
                            snapshot.as_ref().is_some_and(|s| {
                                s.setup["dispatchableRuntimes"]
                                    .as_array()
                                    .is_none_or(|r| r.is_empty())
                            }) && !busy,
                            |v| v.child("No coding tools found"),
                        )
                        .child(
                            control("setup-use", "Use this setup", ready && !busy)
                                .on_click(cx.listener(|this, _, _, cx| this.act(Action::Use, cx))),
                        ),
                )
            })
            .when(self.step == Step::Privacy, |v| {
                v.child(
                    div()
                        .debug_selector(|| "setup-privacy".into())
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .child(div().text_size(px(24.)).child("Privacy"))
                        .child(
                            control(
                                "setup-telemetry",
                                if self.telemetry {
                                    "Product analytics: on"
                                } else {
                                    "Product analytics: off"
                                },
                                !busy,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                if !this.busy {
                                    this.telemetry = !this.telemetry;
                                    this.revision += 1;
                                    cx.notify();
                                }
                            })),
                        )
                        .child(
                            control(
                                "setup-crashes",
                                if self.crashes {
                                    "Crash reports: on"
                                } else {
                                    "Crash reports: off"
                                },
                                !busy,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                if !this.busy {
                                    this.crashes = !this.crashes;
                                    this.revision += 1;
                                    cx.notify();
                                }
                            })),
                        )
                        .child(
                            control("setup-consent", "Save and continue", !busy).on_click(
                                cx.listener(|this, _, _, cx| this.act(Action::Consent, cx)),
                            ),
                        ),
                )
            })
            .child(canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision)).size(px(1.)))
    }
}
