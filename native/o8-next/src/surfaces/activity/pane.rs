//! Activity entity hosted by the opt-in shell. HTTP work stays off the UI thread.
use super::feed::{self, CiDetail, ReadError, Repo, Row, Streams};
use crate::client::Client;
use gpui::{Context, EventEmitter, FocusHandle, Window};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub enum ActivityEvent {
    Worker(String),
}
#[derive(Clone)]
pub(super) enum Action {
    Filter(&'static str),
    Scope(String),
    Refresh,
    Expand(Row),
    Link(String),
    Worker(String),
    RetryDetail(Row),
    Hold(Row, bool),
    StopMission,
}
#[derive(Clone)]
pub(super) enum DetailValue {
    Ci(CiDetail),
    Pr(Value),
}
#[derive(Default)]
pub(super) struct Detail {
    pub value: Option<DetailValue>,
    pub loading: bool,
    pub error: Option<String>,
    pub retry_at: Option<Instant>,
    pub updated: Option<Instant>,
}
pub struct ActivityPane {
    pub(super) client: Client,
    pub(super) workspace: String,
    pub(super) scope: String,
    pub(super) repos: Vec<Repo>,
    pub(super) rows: Vec<Row>,
    cache: HashMap<String, Streams>,
    pub(super) mission: Value,
    pub(super) loading: bool,
    pub(super) errors: Vec<String>,
    pub(super) filter: &'static str,
    pub(super) expanded: Option<String>,
    pub(super) details: HashMap<String, Detail>,
    pub(super) pending: bool,
    pub(super) notice: String,
    generation: u64,
    loaded_at: Instant,
    stop_identity: Option<(String, String)>,
    pub(super) focus: FocusHandle,
    pub(super) controls: Vec<(String, Action)>,
    pub(super) keyboard: Option<String>,
    pub(super) revision: u64,
    pub(super) painted: std::rc::Rc<std::cell::Cell<u64>>,
}
impl EventEmitter<ActivityEvent> for ActivityPane {}
impl ActivityPane {
    pub fn new(client: Client, workspace: String, cx: &mut Context<Self>) -> Self {
        crate::keymap::install(cx);
        let mut pane = Self {
            client,
            scope: workspace.clone(),
            workspace,
            repos: vec![],
            rows: vec![],
            cache: HashMap::new(),
            mission: Value::Null,
            loading: false,
            errors: vec![],
            filter: "all",
            expanded: None,
            details: HashMap::new(),
            pending: false,
            notice: String::new(),
            generation: 0,
            loaded_at: Instant::now(),
            stop_identity: None,
            focus: cx.focus_handle(),
            controls: vec![],
            keyboard: None,
            revision: 0,
            painted: std::rc::Rc::new(std::cell::Cell::new(u64::MAX)),
        };
        pane.load(cx);
        pane
    }
    pub fn focus(&self, window: &mut Window) {
        self.focus.focus(window);
    }
    #[cfg(test)]
    pub fn ready(&self) -> bool {
        !self.loading && self.painted.get() == self.revision
    }
    pub fn tick(&mut self, cx: &mut Context<Self>) {
        if self.loaded_at.elapsed() >= Duration::from_secs(300) && !self.loading && !self.pending {
            self.load(cx);
        }
        let retry = self.expanded.as_ref().and_then(|key| {
            let detail = self.details.get(key)?;
            (detail.error.is_some()
                && !detail.loading
                && detail.retry_at.is_some_and(|at| at <= Instant::now()))
            .then(|| self.rows.iter().find(|row| row.key() == *key).cloned())
            .flatten()
        });
        if let Some(row) = retry {
            self.detail(row, false, cx);
        }
    }
    fn changed(&mut self, cx: &mut Context<Self>) {
        self.revision += 1;
        cx.notify();
    }
    fn load(&mut self, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        self.loading = true;
        let generation = self.generation;
        let client = self.client.clone();
        let scope = self.scope.clone();
        let workspace = self.workspace.clone();
        let cache = self.cache.clone();
        let task = cx.background_executor().spawn(async move {
            let repos = client
                .activity_request("GET", "/api/panel/repos", &[], None)
                .and_then(|v| {
                    serde_json::from_value::<Vec<Repo>>(v["repos"].clone())
                        .map_err(|_| ReadError::invalid())
                });
            let registry = repos.clone().unwrap_or_default();
            let mut targets: Vec<_> = registry
                .iter()
                .filter(|r| scope == "*" || r.local_path == scope)
                .cloned()
                .collect();
            if targets.is_empty() && scope != "*" && !workspace.is_empty() {
                targets.push(Repo {
                    name: "Selected folder".into(),
                    local_path: scope.clone(),
                    remote_url: None,
                });
            }
            let mut snapshot = feed::load(&client, &targets, cache);
            if let Err(error) = repos {
                snapshot
                    .errors
                    .push(format!("Repository list unavailable: {}", error.message));
            }
            (registry, snapshot)
        });
        cx.spawn(async move |this, cx| {
            let (repos, snapshot) = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                this.loading = false;
                this.loaded_at = Instant::now();
                this.repos = repos;
                this.rows = snapshot.rows;
                this.errors = snapshot.errors;
                this.cache = snapshot.cache;
                this.mission = snapshot.mission;
                if !this.rows.iter().any(|r| Some(r.key()) == this.expanded) {
                    this.expanded = None;
                }
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    fn detail(&mut self, row: Row, manual: bool, cx: &mut Context<Self>) {
        if !matches!(row.kind, "ci" | "pr") {
            return;
        }
        let key = row.key();
        let detail = self.details.entry(key.clone()).or_default();
        if detail.loading
            || !manual
                && (detail.retry_at.is_some_and(|t| t > Instant::now())
                    || detail.error.is_none()
                        && detail
                            .updated
                            .is_some_and(|t| t.elapsed() < Duration::from_secs(300)))
        {
            return;
        }
        detail.loading = true;
        detail.error = None;
        let generation = self.generation;
        let client = self.client.clone();
        let target = row.clone();
        let task = cx.background_executor().spawn(async move {
            let repo = target.repo.as_deref().ok_or_else(ReadError::invalid)?;
            if target.kind == "ci" {
                client
                    .activity_request(
                        "GET",
                        &format!("/api/panel/ci/{}", target.id),
                        &[("repo", repo)],
                        None,
                    )
                    .and_then(|v| CiDetail::parse(v, &target))
                    .map(DetailValue::Ci)
            } else {
                let value = client.activity_request(
                    "GET",
                    "/api/panel/pr",
                    &[("repo", repo), ("number", &target.id)],
                    None,
                )?;
                if value["number"].as_u64().map(|n| n.to_string()).as_ref() != Some(&target.id)
                    || !value["files"].is_array()
                {
                    return Err(ReadError::invalid());
                }
                Ok(DetailValue::Pr(value))
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                // Obsolete scopes and collapsed observers cannot publish a late read.
                let Some(detail) = this.details.get_mut(&key) else {
                    return;
                };
                detail.loading = false;
                if generation != this.generation || this.expanded.as_ref() != Some(&key) {
                    return;
                }
                match result {
                    Ok(value) => {
                        detail.value = Some(value);
                        detail.updated = Some(Instant::now());
                        detail.retry_at = None;
                    }
                    Err(error) => {
                        if matches!(error.status, Some(403 | 429)) {
                            detail.retry_at =
                                Some(Instant::now() + Duration::from_secs(error.retry));
                        }
                        detail.error = Some(error.message);
                    }
                }
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    fn mutate(
        &mut self,
        method: &'static str,
        path: &'static str,
        body: Value,
        cx: &mut Context<Self>,
    ) {
        if self.pending {
            return;
        }
        self.pending = true;
        self.notice = "Applying decision…".into();
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(300);
            loop {
                let result = client.activity_request(method, path, &[], Some(&body));
                if path != "/api/orchestrator/stop-mission" {
                    break result;
                }
                match &result {
                    Ok(value) if value["outcomeUnknown"] == true => break result,
                    Ok(value)
                        if value["ok"].is_boolean()
                            && value["inProgress"] != true
                            && value["result"]["inProgress"] != true
                            && value["status"] != "in_progress"
                            && value["result"]["status"] != "in_progress" =>
                    {
                        break result;
                    }
                    Err(error) if error.status.is_some() => break result,
                    _ => {}
                }
                if Instant::now() >= deadline {
                    break Ok(json!({"outcomeUnknown":true}));
                }
                // The same exact body polls the persisted receipt; it cannot
                // create another stop while the first result is uncertain.
                std::thread::sleep(Duration::from_millis(750));
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                this.notice = match result {
                    Ok(value)
                        if value["result"]["inProgress"] == true
                            || value["outcomeUnknown"] == true =>
                    {
                        this.pending = true;
                        "Decision is unsettled. Refresh before another action.".into()
                    }
                    Ok(_) => {
                        this.stop_identity = None;
                        "Decision applied.".into()
                    }
                    Err(error) => {
                        if error.status.is_some() {
                            this.stop_identity = None;
                        }
                        error.message
                    }
                };
                this.load(cx);
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    pub(super) fn act(&mut self, action: Action, cx: &mut Context<Self>) {
        match action {
            Action::Filter(filter) => { self.filter = filter; self.expanded = None; }
            Action::Scope(scope) => {
                self.scope = scope; self.generation += 1; self.loading = false;
                self.rows.clear(); self.errors.clear(); self.expanded = None; self.details.clear(); self.keyboard = None; self.load(cx);
            }
            Action::Refresh => self.load(cx),
            Action::Expand(row) => {
                if self.expanded.as_ref() == Some(&row.key()) { self.expanded = None; }
                else { self.expanded = Some(row.key()); self.detail(row,false,cx); }
            }
            Action::RetryDetail(row) => self.detail(row,true,cx),
            Action::Link(url) => cx.open_url(&url),
            Action::Worker(key) => cx.emit(ActivityEvent::Worker(key)),
            Action::Hold(row,held) => self.mutate("PATCH","/api/orchestrator/state", json!({"packetId":row.id,"updates":{"queueState":if held {"held"}else{"queued"},"blockedReason":if held {Some("Held by operator")}else{None}}}),cx),
            Action::StopMission => {
                let mission = feed::text(&self.mission,"missionId");
                if mission.is_empty() { return; }
                // Reuse the same identity after an unconfirmed transport result.
                let (_,identity) = self.stop_identity.get_or_insert_with(|| (mission.clone(),format!("next-stop-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos())));
                let identity = identity.clone();
                self.mutate("POST","/api/orchestrator/stop-mission",json!({"missionId":mission,"idempotencyKey":identity}),cx);
            }
        }
        self.changed(cx);
    }
    pub(super) fn key_down(
        &mut self,
        action: &crate::keymap::Shortcut,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match *action {
            crate::keymap::Shortcut::ActivityMove(previous) => {
                let length = self.controls.len().max(1);
                let current = self
                    .keyboard
                    .as_ref()
                    .and_then(|id| self.controls.iter().position(|(control, _)| control == id));
                let index = if previous {
                    current.unwrap_or(0).wrapping_add(length - 1) % length
                } else {
                    current.map(|index| (index + 1) % length).unwrap_or(0)
                };
                self.keyboard = self.controls.get(index).map(|(id, _)| id.clone());
            }
            crate::keymap::Shortcut::ActivityActivate => {
                if let Some((_, action)) = self
                    .keyboard
                    .as_ref()
                    .and_then(|id| self.controls.iter().find(|(control, _)| control == id))
                    .cloned()
                {
                    self.act(action, cx);
                }
            }
            crate::keymap::Shortcut::ActivityCancel => {
                self.expanded = None;
                self.keyboard = None;
            }
            _ => {
                cx.propagate();
                return;
            }
        }
        self.changed(cx);
        cx.stop_propagation();
    }
}
#[path = "view.rs"]
mod view;
