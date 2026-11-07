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
    path::PathBuf,
    rc::Rc,
    time::{SystemTime, UNIX_EPOCH},
};

#[path = "frame.rs"]
mod frame;
#[path = "home.rs"]
mod home;
#[path = "import.rs"]
mod import;
#[cfg(test)]
#[path = "view_lifecycle_tests.rs"]
mod lifecycle_tests;
#[path = "look.rs"]
mod look;
#[path = "new_project.rs"]
mod new_project;
#[path = "privacy.rs"]
mod privacy;
#[path = "progress.rs"]
mod progress;
#[path = "sound.rs"]
pub(crate) mod sound;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    local_path: String,
}
#[derive(Clone, Copy, PartialEq)]
enum Step {
    /// Existing Codex and Claude Code threads to bring in, before projects.
    Import,
    Projects,
    Folder,
    Tools,
    Privacy,
    NewProject,
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
    fn model(&self, chosen: &str) -> Option<String> {
        self.setup["setupRecommendation"]["leadModel"]
            .as_str()
            .filter(|model| !model.trim().is_empty())
            .or_else(|| (!chosen.trim().is_empty()).then_some(chosen))
            .map(|model| model.trim().to_owned())
    }
}
pub struct Opened(pub Option<Session>);
impl EventEmitter<Opened> for Setup {}
/// Imported chats exist now; the shell reloads its sessions.
pub struct Imported;
impl EventEmitter<Imported> for Setup {}
/// Where setup stands now, saved so a relaunch resumes there.
pub struct Progressed(pub crate::shell_state::OnboardingProgress);
impl EventEmitter<Progressed> for Setup {}
/// The sounds switch changed.
pub struct Sounds(pub bool);
impl EventEmitter<Sounds> for Setup {}
pub struct Setup {
    client: Client,
    snapshot: Option<Snapshot>,
    step: Step,
    project: Option<Project>,
    backend: String,
    workers: Vec<String>,
    folder: Entity<Composer>,
    model: Entity<Composer>,
    name: Entity<Composer>,
    form: new_project::Form,
    import: import::Picker,
    session_id: String,
    busy: bool,
    error: Option<String>,
    /// Usage analytics: None until chosen, which the server reads as on.
    telemetry: Option<bool>,
    /// Crash reports: None until the person chooses, as on the desktop.
    crashes: Option<bool>,
    /// Whether the sample crash report is shown.
    crash_sample: bool,
    /// Saved with progress, as on the desktop.
    tools_configured: bool,
    task: String,
    /// The progress last saved, so only changes are written.
    saved: Option<crate::shell_state::OnboardingProgress>,
    revision: u64,
    painted: Rc<Cell<u64>>,
    /// Keys stay inside setup while it owns the window.
    pub(crate) focus: gpui::FocusHandle,
}
enum Action {
    Load(bool),
    Choose(Option<Project>),
    Add(String),
    Create(Value),
    Import(Vec<String>),
    Use,
    /// Save the usage analytics choice as soon as it changes.
    Usage(bool),
    Consent,
}
struct ResultState {
    snapshot: Snapshot,
    step: Step,
    project: Option<Project>,
    opened: Option<Option<Session>>,
    discovered: Option<import::Discovered>,
    imported: Option<(usize, usize)>,
}
impl Setup {
    #[cfg(test)]
    pub fn painted_page(&self) -> Option<&'static str> {
        (self.painted.get() == self.revision).then_some(match self.step {
            Step::Import => "import",
            Step::Projects => "projects",
            Step::Folder => "folder",
            Step::Tools => "tools",
            Step::Privacy => "privacy",
            Step::NewProject => "new-project",
        })
    }
    /// The progress rail's parts (label, detail, done) and the current one.
    #[cfg(test)]
    pub fn rail(&self) -> (Vec<(&'static str, String, bool)>, usize) {
        let (parts, current) = frame::rail(self);
        let parts = parts
            .into_iter()
            .map(|p| (p.label, p.detail, p.done))
            .collect();
        (parts, current)
    }
    #[cfg(test)]
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
    /// Each import group's folder and thread count, and how many are selected.
    #[cfg(test)]
    pub fn import_state(&self) -> (Vec<(String, usize)>, usize, Option<String>) {
        (
            self.import.groups(),
            self.import.selected(),
            self.import.note.clone(),
        )
    }
    pub fn busy(&self) -> bool {
        self.busy
    }
    /// `saved` is where an earlier launch stopped; `sounds_dir` is the
    /// app's data folder for the cue files.
    pub fn new(
        client: Client,
        saved: Option<&crate::shell_state::OnboardingProgress>,
        sounds_on: bool,
        sounds_dir: Option<PathBuf>,
        cx: &mut Context<Self>,
    ) -> Self {
        sound::configure(sounds_on, sounds_dir);
        let resume = progress::read(saved);
        let mut this = Self {
            client,
            snapshot: None,
            step: resume.step,
            project: resume.project,
            backend: String::new(),
            workers: vec![],
            folder: cx.new(Composer::new),
            model: cx.new(Composer::new),
            name: cx.new(Composer::new),
            form: new_project::Form::default(),
            import: import::Picker::default(),
            session_id: format!(
                "thoughts-next-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
            busy: false,
            error: None,
            telemetry: None,
            crashes: None,
            crash_sample: false,
            tools_configured: resume.tools_configured,
            task: resume.task,
            saved: saved.cloned(),
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            focus: cx.focus_handle(),
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
        let model = self.model.read(cx).text.trim().to_owned();
        let telemetry = self.telemetry;
        let crashes = self.crashes;
        let step = self.step;
        let id = self.session_id.clone();
        let used = matches!(action, Action::Use);
        let task = cx.background_executor().spawn(async move {
            let mut next = snapshot;
            let mut selected = project;
            let mut target = step;
            let mut finish = false;
            let (mut discovered, mut imported) = (None, None);
            match action {
                Action::Load(refresh) => {
                    next = Some(Snapshot::load(&client, refresh)?);
                    // A resumed project that is gone sends setup back to projects.
                    if !refresh && Self::registered(next.as_ref().unwrap(), selected.as_ref()).is_err() {
                        (selected, target) = (None, Step::Projects);
                    }
                    // An older server without the routes just skips the offer.
                    discovered = import::Discovered::load(&client).ok();
                    if !refresh && step == Step::Projects && discovered.as_ref().is_some_and(import::Discovered::pending) { target = Step::Import; }
                }
                Action::Import(keys) => {
                    imported = Some(import::Picker::import(&client, keys)?);
                    discovered = import::Discovered::load(&client).ok();
                    next = Some(Snapshot::load(&client, false)?); target = Step::Projects;
                }
                Action::Add(path) => {
                    let added = client.setup_request("POST", "/api/panel/repos", &json!({"action":"add", "localPath":path.trim()}))?;
                    selected = Some(serde_json::from_value::<Project>(added["repo"].clone()).map_err(|_| "Invalid project response")?);
                    next = Some(Snapshot::load(&client, true)?); target = Step::Tools;
                }
                Action::Choose(project) => {
                    selected = project;
                    (next, target, finish) = Self::proceed(&client, selected.as_ref(), &model)?;
                }
                Action::Create(request) => {
                    // gh's refusal (not signed in, name taken) returns as this page's error.
                    let created = client.setup_request("POST", "/api/panel/repos", &request)?;
                    selected = Some(serde_json::from_value::<Project>(created["repo"].clone()).map_err(|_| "Invalid project response")?);
                    (next, target, finish) = Self::proceed(&client, selected.as_ref(), &model)?;
                }
                Action::Use => {
                    let current = Snapshot::load(&client, true)?;
                    if !current.ready(&backend, &workers) { return Err("Your tools changed. Refresh tools before continuing.".into()); }
                    client.setup_request("POST", "/api/panel/operator-defaults", &Self::selection(&current, &backend, &workers))?;
                    next = Some(Snapshot::load(&client, false)?);
                    if selected.is_some() {
                        if next.as_ref().unwrap().model(&model).is_none() { target = Step::Tools; }
                        else if next.as_ref().unwrap().setup["values"]["telemetryConsentAnswered"] == true { finish = true; }
                        else { target = Step::Privacy; }
                    } else { target = Step::Projects; }
                }
                Action::Usage(enabled) => {
                    let response = client.setup_request("POST", "/api/panel/operator-defaults", &json!({"productTelemetryEnabled":enabled}))?;
                    if response["values"]["productTelemetryEnabled"] != enabled { return Err("Your usage choice could not be saved.".into()); }
                }
                Action::Consent => {
                    let crashes = crashes.ok_or("Choose whether to share crash reports to continue.")?;
                    let response = client.setup_request("POST", "/api/panel/operator-defaults", &json!({"productTelemetryEnabled":telemetry,"crashReportsEnabled":crashes,"telemetryConsentAnswered":true}))?;
                    if response["values"]["telemetryConsentAnswered"] != true { return Err("Privacy choices could not be confirmed. Try again.".into()); }
                    finish = true;
                }
            }
            let loaded = next.ok_or("Setup has not loaded. Try again.")?;
            let opened = if finish { Some(Self::finish(&client, &loaded, selected.as_ref(), &id, &model)?) } else { None };
            Ok::<_, String>(ResultState { snapshot: loaded, step: target, project: selected, opened, discovered, imported })
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(result) => {
                        if this.backend != result.snapshot.recommendation().0 {
                            this.model.update(cx, |model, cx| model.clear(cx));
                        }
                        (this.backend, this.workers) = result.snapshot.recommendation();
                        // Privacy opens with any earlier choices, as on the desktop.
                        if result.step == Step::Privacy
                            && (this.step != Step::Privacy || this.snapshot.is_none())
                        {
                            this.privacy_choices(&result.snapshot.setup["values"]);
                        }
                        this.snapshot = Some(result.snapshot);
                        this.project = result.project;
                        this.step = result.step;
                        if let Some(discovered) = result.discovered {
                            this.import.replace(discovered);
                        }
                        if let Some((imported, skipped)) = result.imported {
                            this.import.note = Some(import::note(imported, skipped));
                            if imported > 0 {
                                cx.emit(Imported);
                            }
                        }
                        if used {
                            this.tools_configured = true;
                        }
                        if let Some(session) = result.opened {
                            sound::play(sound::Cue::Complete);
                            cx.emit(Opened(session));
                        } else {
                            this.remember(cx);
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
    /// Opening a project, or starting without one: tools first when they are
    /// not ready, then privacy, then the first conversation.
    fn proceed(
        client: &Client,
        selected: Option<&Project>,
        model: &str,
    ) -> Result<(Option<Snapshot>, Step, bool), String> {
        let loaded = Snapshot::load(client, true)?;
        Self::registered(&loaded, selected)?;
        let (lead, pool) = loaded.recommendation();
        let (mut target, mut finish) = (Step::Projects, false);
        if selected.is_some() && (!loaded.ready(&lead, &pool) || loaded.model(model).is_none()) {
            target = Step::Tools;
        } else {
            if loaded.ready(&lead, &pool)
                && loaded.setup["setupRecommendation"]["preserved"] != true
            {
                client.setup_request(
                    "POST",
                    "/api/panel/operator-defaults",
                    &Self::selection(&loaded, &lead, &pool),
                )?;
            }
            if loaded.setup["values"]["telemetryConsentAnswered"] != true {
                target = Step::Privacy;
            } else {
                finish = true;
            }
        }
        Ok((Some(loaded), target, finish))
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
        chosen_model: &str,
    ) -> Result<Option<Session>, String> {
        let current = Snapshot::load(client, true)?;
        Self::registered(&current, project)?;
        let mut completion = json!({"setupComplete":true});
        let mut session = None;
        let (backend, workers) = snapshot.recommendation();
        // Without a project, a first conversation starts once a lead and model
        // are ready. It starts in Home, the home folder, as Home's New chat
        // does (#5611); with no home folder it runs in its own scratch folder.
        let first = match project {
            Some(_) => Some(
                snapshot
                    .model(chosen_model)
                    .ok_or("Choose a model for this runtime before continuing.")?,
            ),
            None => snapshot
                .model(chosen_model)
                .filter(|_| current.ready(&backend, &workers)),
        };
        if let Some(model) = first {
            if !current.ready(&backend, &workers) {
                return Err("Connect a coding tool before opening this project.".into());
            }
            let home = crate::shell::session::home_workspace().filter(|_| project.is_none());
            let (repo_path, repo_name) = match project {
                Some(project) => (Some(project.local_path.clone()), Some(project.name.clone())),
                None => (home.clone(), home.as_ref().map(|_| "Home".to_owned())),
            };
            client.setup_request("POST", "/api/v2/chat-history", &json!({"tabId":id,"messages":[],"backend":backend,"model":model,"repoPath":repo_path,"repoName":repo_name,"title":"New conversation"}))?;
            let history: Value = client.get("/api/v2/chat-history", &[("tabId", id)])?;
            if let Some(project) = project {
                completion["repoPath"] = json!(project.local_path);
            }
            completion["completedAt"] = history["savedAt"].clone();
            session = client.sessions()?.into_iter().find(|s| s.id == id);
            if session.is_none() {
                return Err("The conversation could not be reopened. Try again.".into());
            }
        }
        client.setup_request("POST", "/api/setup/config", &completion)?;
        Ok(session)
    }
    /// Earlier choices: usage analytics when one was saved, and crash
    /// reports only when the combined choice was answered.
    fn privacy_choices(&mut self, values: &Value) {
        let answered = values["telemetryConsentAnswered"] == true;
        self.telemetry = values["productTelemetryEnabled"].as_bool();
        self.crashes = values["crashReportsEnabled"].as_bool().filter(|_| answered);
    }
    fn navigate(&mut self, step: Step, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.step = step;
        self.error = None;
        self.remember(cx);
        self.revision += 1;
        cx.notify();
    }
    /// Save where setup stands when that changed.
    fn remember(&mut self, cx: &mut Context<Self>) {
        let now = progress::write(
            self.step,
            self.project.as_ref(),
            self.tools_configured,
            &self.task,
        );
        if self.saved.as_ref() != Some(&now) {
            self.saved = Some(now.clone());
            cx.emit(Progressed(now));
        }
    }
    /// Turn sounds on or off; turning them on by pointer previews a tick.
    fn set_sounds(&mut self, on: bool, preview: bool, cx: &mut Context<Self>) {
        sound::set_on(on);
        if on && preview {
            sound::play(sound::Cue::Tick);
        }
        cx.emit(Sounds(on));
        self.revision += 1;
        cx.notify();
    }
    /// New project lists saved machines beside this one as it opens.
    fn open_new_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.navigate(Step::NewProject, cx);
        self.name.read(cx).focus.focus(window);
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { new_project::Form::load_machines(&client) });
        cx.spawn(async move |this, cx| {
            let machines = task.await;
            let _ = this.update(cx, |this, cx| {
                this.form.machines = machines;
                this.revision += 1;
                cx.notify();
            });
        })
        .detach();
    }
    fn create(&mut self, cx: &mut Context<Self>) {
        match self.form.request(&self.name.read(cx).text) {
            Ok(request) => self.act(Action::Create(request), cx),
            Err(reason) => {
                self.error = Some(reason.into());
                self.revision += 1;
                cx.notify();
            }
        }
    }
}
/// A bordered setup control (`onboardingButtonStyle`).
fn control(id: &str, label: impl Into<SharedString>, enabled: bool) -> gpui::Stateful<gpui::Div> {
    look::button(id, label, enabled, look::Look::Bordered)
}
/// The step's main action (`renderButton`).
fn primary(id: &str, label: impl Into<SharedString>, enabled: bool) -> gpui::Stateful<gpui::Div> {
    look::button(id, label, enabled, look::Look::Primary)
}
/// A quiet setup control (`onboardingQuietButtonStyle`).
fn quiet(id: &str, label: impl Into<SharedString>, enabled: bool) -> gpui::Stateful<gpui::Div> {
    look::button(id, label, enabled, look::Look::Quiet)
}
impl Render for Setup {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = self.busy;
        let snapshot = self.snapshot.clone();
        let ready = snapshot
            .as_ref()
            .is_some_and(|s| s.ready(&self.backend, &self.workers));
        let painted = self.painted.clone();
        let revision = self.revision;
        let width = f32::from(window.viewport_size().width);
        let home = self.step == Step::Projects;
        let privacy = self.step == Step::Privacy;
        let body = div()
            .flex()
            .flex_col()
            .gap(px(20.))
            .when(privacy, |v| v.flex_1().min_h_0())
            // Away from home: back to projects and the project being set up.
            .when(!home, |v| {
                v.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .justify_between()
                        .gap(px(12.))
                        .child(quiet("setup-back", "← Projects", !busy).pl_0().on_click(
                            cx.listener(|this, _, _, cx| this.navigate(Step::Projects, cx)),
                        ))
                        .when_some(self.project.as_ref(), |v, project| {
                            v.child(
                                div()
                                    .flex()
                                    .gap(px(4.))
                                    .text_size(px(12.))
                                    .line_height(gpui::relative(1.5))
                                    .text_color(theme().text_secondary)
                                    .child("Setting up")
                                    .child(
                                        div().text_color(theme().text).child(project.name.clone()),
                                    ),
                            )
                        }),
                )
            })
            .when(home, |v| {
                v.child(self.home(busy, snapshot.as_ref(), width, cx))
            })
            .when(self.step == Step::Import, |v| {
                v.child(import::page(self, busy, cx))
            })
            .when(self.step == Step::Folder, |v| {
                v.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(12.))
                        .child(look::title("Open a folder"))
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(theme().text_secondary)
                                .child("Folder path"),
                        )
                        .child(
                            div()
                                .debug_selector(|| "setup-folder-input".into())
                                .child(self.folder.clone()),
                        )
                        .child(look::actions(
                            vec![
                                quiet("setup-cancel-folder", "Cancel", !busy)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        if !this.busy {
                                            this.folder.update(cx, |input, cx| input.clear(cx));
                                            this.navigate(Step::Projects, cx);
                                        }
                                    }))
                                    .into_any_element(),
                            ],
                            vec![
                                primary("setup-add", "Open folder", !busy)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        let path = this.folder.read(cx).text.clone();
                                        this.act(Action::Add(path), cx);
                                    }))
                                    .into_any_element(),
                            ],
                        )),
                )
            })
            .when(self.step == Step::NewProject, |v| {
                v.child(new_project::page(self, busy, cx))
            })
            .when(self.step == Step::Tools, |v| {
                v.child(
                    div()
                        .debug_selector(|| "setup-tools".into())
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .child(look::title("Choose your agent"))
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(gpui::FontWeight::LIGHT)
                                .line_height(gpui::relative(1.6))
                                .text_color(theme().text_secondary)
                                .child(
                                    "Start with an agent. You can add coding tools and adjust \
                                     your setup later.",
                                ),
                        )
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
                                        && ([
                                            "codex", "claude", "opencode", "muse", "fable", "o8",
                                            "pi",
                                        ]
                                        .contains(&backend.as_str())
                                            || runtime["builtIn"].is_object());
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap(px(4.))
                                        .pt(px(6.))
                                        .font_weight(gpui::FontWeight::LIGHT)
                                        .child(div().text_size(px(13.5)).child(
                                            runtime["label"].as_str().unwrap_or("Tool").to_owned(),
                                        ))
                                        .when(!enabled, |v| {
                                            v.child(
                                                div()
                                                    .text_size(px(12.))
                                                    .text_color(theme().text_secondary)
                                                    .child(
                                                        runtime["detail"]
                                                            .as_str()
                                                            .unwrap_or("Unavailable")
                                                            .to_owned(),
                                                    ),
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
                                                            this.model.update(cx, |model, cx| {
                                                                model.clear(cx)
                                                            });
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
                        .when(
                            snapshot.as_ref().is_some_and(|s| {
                                s.setup["setupRecommendation"]["backend"] == self.backend
                                    && s.model("").is_none()
                            }),
                            |v| {
                                v.child("Choose a model ID for this runtime to continue.")
                                    .child(
                                        div()
                                            .id("setup-model-input")
                                            .debug_selector(|| "setup-model-input".into())
                                            .on_click(cx.listener(|s, _, window, cx| {
                                                s.model.read(cx).focus.focus(window)
                                            }))
                                            .child(self.model.clone()),
                                    )
                            },
                        )
                        .child(look::actions(
                            vec![
                                quiet("setup-refresh", "Check again", !busy)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.act(Action::Load(true), cx)
                                    }))
                                    .into_any_element(),
                            ],
                            vec![
                                primary("setup-use", "Use this setup", ready && !busy)
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.act(Action::Use, cx)),
                                    )
                                    .into_any_element(),
                            ],
                        )),
                )
            })
            .when(self.step == Step::Privacy, |v| {
                v.child(privacy::page(self, busy, cx))
            })
            // Away from home, progress and errors follow the page.
            .when(!home && busy, |v| {
                v.child(
                    div()
                        .debug_selector(|| "setup-loading".into())
                        .text_size(px(12.))
                        .text_color(theme().text_secondary)
                        .child("Checking setup…"),
                )
            })
            .when_some(self.error.clone().filter(|_| !home), |v, error| {
                v.child(look::feedback(
                    "setup-error",
                    error,
                    "Your saved choices are kept. You can retry or return to projects.",
                    None,
                ))
            });
        // The desktop's full-window surface: a drag strip under the traffic
        // lights, the frame centred in a scrolling area on the window's own
        // material, and the footer.
        let viewport = window.viewport_size();
        let top = (f32::from(viewport.height) * 0.02).clamp(12., 24.);
        // The scrolling area's height, so a short page centres in it.
        let area = f32::from(viewport.height) - 52. - frame::FOOTER - top;
        div()
            .id("setup")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .text_color(theme().text)
            .font_family(theme().font_ui)
            .child(
                div()
                    .flex_none()
                    .w_full()
                    .h(px(52.))
                    .window_control_area(gpui::WindowControlArea::Drag),
            )
            .child(
                div()
                    .id("setup-content")
                    .debug_selector(|| "setup-content".into())
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .pt(px(top))
                    .px(px(32.))
                    .child(
                        div()
                            .min_h(px(area.max(0.)))
                            .pb(px(24.))
                            .flex()
                            .flex_col()
                            .items_center()
                            .justify_center()
                            .child(frame::frame(
                                self,
                                body,
                                viewport,
                                privacy.then_some((area - 24.).max(320.)),
                            )),
                    ),
            )
            .child(frame::footer(cx))
            .child(
                canvas(
                    |_, _, _| (),
                    move |_, _, window, _| {
                        painted.set(revision);
                        // A busy setup is modal, including shell navigation outside its
                        // content bounds. These listeners live for this painted frame.
                        if busy {
                            window.on_mouse_event(|_: &gpui::MouseDownEvent, phase, window, cx| {
                                if phase == gpui::DispatchPhase::Capture {
                                    window.prevent_default();
                                    cx.stop_propagation();
                                }
                            });
                            window.on_mouse_event(|_: &gpui::MouseUpEvent, phase, _, cx| {
                                if phase == gpui::DispatchPhase::Capture {
                                    cx.stop_propagation();
                                }
                            });
                        }
                    },
                )
                .size(px(1.)),
            )
    }
}
