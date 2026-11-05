//! Activity entity hosted by the opt-in shell. HTTP work stays off the UI thread.
use super::feed::{self, CiDetail, ReadError, Repo, Row, Streams};
use crate::client::Client;
use gpui::{Context, EventEmitter, FocusHandle, KeyDownEvent, Window};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub enum ActivityEvent {
    Commit(Row),
    Draft(String, String),
    Preferences(preferences::Saved),
    Worker(String),
    /// A row's GitHub link, for the shell to open in the surface that
    /// claims it (pull requests, issues) or in the browser.
    Open(String),
    Diff(String),
}
#[derive(Clone)]
pub(super) enum Action {
    BackToFeed,
    Packet(packet::Command),
    /// The summary row that holds Recurring problems and Proposed directives.
    Attention,
    Proposals,
    ProposalDetail(String),
    ProposalDecision(String, bool),
    RetryProposals,
    Dossiers,
    DossierHistory(String),
    DossierDecision(String, &'static str),
    RetryDossiers,
    Filter(&'static str),
    Scope(String),
    /// Opens or closes the repository scope menu (O8RepoSelector).
    ScopeMenu(bool),
    Refresh,
    Expand(Row),
    /// A row's destination, as classic's double-click: pull requests and
    /// issues open in the app, commits and CI runs on GitHub.
    Open(Row),
    Link(String),
    Worker(String),
    RetryDetail(Row),
    Hold(Row, bool),
    StopMission,
    /// A worker lane command from the packet card (O8ActivityPacketRow):
    /// resume, stop, create_pr or merge.
    Lane(Row, &'static str),
    /// Opens or cancels the close-unmerged confirmation for a packet.
    CloseAsk(Option<String>),
    CloseReason(&'static str),
    Close(Row),
}

/// Routes whose persisted receipt is replayed with the same body until terminal
/// (classic fetchCorrelatedActionReceipt).
const RECEIPTS: [&str; 2] = [
    "/api/orchestrator/stop-mission",
    "/api/orchestrator/discard-packet",
];
/// close-unmerged-shared.ts: each disposition and its label.
pub(super) const CLOSE_REASONS: [(&str, &str); 4] = [
    ("adopted_elsewhere", "Adopted elsewhere"),
    ("superseded", "Superseded"),
    ("spec_changed", "Spec changed"),
    ("wontfix", "Won't fix"),
];
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
    pub(crate) background: bool,
    pr_browser: Option<bool>,
    pub(super) commit: Option<(String, gpui::Entity<crate::diff_ui::DiffSurface>)>,
    pub(super) updates: updates::Updates,
    pub(super) packet: packet::State,
    pub(super) proposals: proposals::Proposals,
    pub(super) saved: preferences::Saved,
    pub(super) scroll: gpui::ScrollHandle,
    pub(super) restore_y: Option<f32>,
    pub(super) decisions: decisions::Decisions,
    pub(super) client: Client,
    pub(super) workspace: String,
    pub(super) scope: String,
    pub(super) repos: Vec<Repo>,
    pub(super) rows: Vec<Row>,
    cache: HashMap<String, Streams>,
    packet_fallback: String,
    pub(super) mission: Value,
    pub(super) loading: bool,
    pub(super) errors: Vec<String>,
    pub(super) filter: &'static str,
    /// Recurring problems and Proposed directives are open under their summary row.
    pub(super) attention_open: bool,
    pub(super) expanded: Option<String>,
    pub(super) details: HashMap<String, Detail>,
    pub(super) pending: bool,
    pub(super) notice: String,
    pub(super) notice_error: bool,
    generation: u64,
    pub(super) loaded_at: Instant,
    stop_identity: Option<(String, String)>,
    /// The packet whose close-unmerged confirmation is open, and its reason.
    pub(super) closing: Option<String>,
    pub(super) close_reason: &'static str,
    /// PacketCloseUnmergedActions' busy label while the close receipt settles.
    pub(super) close_stage: Option<&'static str>,
    pub(super) scope_menu: bool,
    pub(super) remote_updated: Option<u64>,
    pub(super) focus: FocusHandle,
    pub(super) controls: Vec<(String, Action)>,
    pub(super) keyboard: Option<String>,
    pub(super) revision: u64,
    pub(super) painted: std::rc::Rc<std::cell::Cell<u64>>,
}
impl EventEmitter<ActivityEvent> for ActivityPane {}
impl ActivityPane {
    pub fn new(client: Client, workspace: String, cx: &mut Context<Self>) -> Self {
        Self::new_with_preferences(client, workspace, Default::default(), false, vec![], cx)
    }
    pub(crate) fn new_with_preferences(
        client: Client,
        workspace: String,
        saved: preferences::Saved,
        open: bool,
        seen: Vec<String>,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut pane = Self {
            background: false,
            pr_browser: None,
            commit: None,
            updates: Default::default(),
            packet: packet::State::default(),
            proposals: Default::default(),
            saved: Default::default(),
            scroll: gpui::ScrollHandle::new(),
            restore_y: None,
            decisions: Default::default(),
            client,
            scope: workspace.clone(),
            workspace,
            repos: vec![],
            rows: vec![],
            cache: HashMap::new(),
            packet_fallback: crate::clock::now().to_string(),
            mission: Value::Null,
            loading: false,
            errors: vec![],
            filter: "all",
            attention_open: false,
            expanded: None,
            details: HashMap::new(),
            pending: false,
            notice: String::new(),
            notice_error: false,
            generation: 0,
            loaded_at: Instant::now(),
            stop_identity: None,
            closing: None,
            close_reason: CLOSE_REASONS[0].0,
            close_stage: None,
            scope_menu: false,
            remote_updated: None,
            focus: cx.focus_handle(),
            controls: vec![],
            keyboard: None,
            revision: 0,
            painted: std::rc::Rc::new(std::cell::Cell::new(u64::MAX)),
        };
        pane.hydrate(saved, open, seen);
        pane.load(cx);
        pane.load_dossiers(cx);
        pane.load_proposals(cx);
        pane
    }
    pub fn focus(&self, window: &mut Window) {
        self.focus.focus(window);
    }
    #[cfg(test)]
    pub fn ready(&self) -> bool {
        !self.loading
            && !self.decisions.loading
            && !self.proposals.loading
            && self.painted.get() == self.revision
    }
    pub fn tick(&mut self, cx: &mut Context<Self>) {
        let interval = if self.background { 300 } else { 120 };
        if self.loaded_at.elapsed() >= Duration::from_secs(interval)
            && !self.loading
            && !self.pending
        {
            self.load(cx);
        }
        if !self.pending
            && self
                .updates
                .aux_updated
                .is_none_or(|at| at.elapsed() >= Duration::from_secs(300))
        {
            self.load_dossiers(cx);
            self.load_proposals(cx);
        }
        let retry = self.expanded.as_ref().and_then(|key| {
            let detail = self.details.get(key)?;
            (detail.error.is_some()
                && !detail.loading
                && detail.retry_at.is_some_and(|at| at <= Instant::now()))
            .then(|| {
                // A CI run grouped onto its commit retries from there.
                self.rows
                    .iter()
                    .flat_map(|row| std::iter::once(row).chain(&row.ci))
                    .find(|row| row.key() == *key)
                    .cloned()
            })
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
            self.updates.queued = true;
            return;
        }
        self.updates.queued = false;
        let fresh = std::mem::take(&mut self.updates.fresh);
        let manual = std::mem::take(&mut self.updates.manual);
        self.loading = true;
        let generation = self.generation;
        let client = self.client.clone();
        let scope = self.scope.clone();
        let workspace = self.workspace.clone();
        let cache = self.cache.clone();
        let previous_repos = self.repos.clone();
        let preference = self.pr_browser;
        let options = feed::ReadOptions {
            fresh,
            manual,
            mission: self.mission.clone(),
            packet_fallback: self.packet_fallback.clone(),
        };
        let task = cx.background_executor().spawn(async move {
            let preference = preference.or_else(|| {
                let value: Value = client
                    .get("/api/panel/operator-defaults", &[("include", "values")])
                    .ok()?;
                match value["values"]["prLinkDestination"].as_str()? {
                    "browser" => Some(true),
                    "in-app" => Some(false),
                    _ => None,
                }
            });
            let repos = client
                .activity_request("GET", "/api/panel/repos", &[], None)
                .and_then(|v| {
                    serde_json::from_value::<Vec<Repo>>(v["repos"].clone())
                        .map_err(|_| ReadError::invalid())
                });
            let registry = repos.clone().unwrap_or(previous_repos);
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
            let mut snapshot = feed::load(&client, &targets, cache, options);
            if let Err(error) = repos {
                snapshot
                    .errors
                    .push(format!("Repository list unavailable: {}", error.message));
            }
            (registry, snapshot, preference)
        });
        cx.spawn(async move |this, cx| {
            let (repos, snapshot, preference) = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                this.loading = false;
                this.loaded_at = Instant::now();
                this.repos = repos;
                this.pr_browser = preference;
                this.rows = snapshot.rows;
                this.errors = snapshot.errors;
                this.cache = snapshot.cache;
                this.mission = snapshot.mission;
                this.remote_updated = snapshot.remote_updated;
                // A CI run grouped onto its commit stays expanded across reloads.
                let expanded = this
                    .rows
                    .iter()
                    .flat_map(|row| std::iter::once(row).chain(&row.ci))
                    .find(|r| Some(r.key()) == this.expanded)
                    .cloned();
                if expanded.is_none() {
                    this.expanded = None;
                }
                if let Some(row) = expanded {
                    if row.kind == "packet" {
                        this.packet_read(row, false, cx);
                    } else {
                        this.detail(row, false, cx);
                    }
                }
                this.changed(cx);
                if this.updates.queued {
                    this.load(cx);
                }
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
                            .is_some_and(|t| t.elapsed() < Duration::from_secs(120)))
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
        self.notice_error = false;
        self.notice = "Applying decision…".into();
        let merge = body["verb"] == "merge";
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(300);
            loop {
                let result = client.activity_request(method, path, &[], Some(&body));
                if !RECEIPTS.contains(&path) {
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
                // create another stop or close while the first is uncertain.
                std::thread::sleep(Duration::from_millis(750));
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.pending = false;
                this.notice_error = result.is_err();
                this.notice = match result {
                    Ok(value)
                        if value["result"]["inProgress"] == true
                            || value["outcomeUnknown"] == true =>
                    {
                        this.pending = true;
                        "Decision is unsettled. Refresh before another action.".into()
                    }
                    Ok(value) => {
                        this.stop_identity = None;
                        this.closing = None;
                        this.close_stage = None;
                        // A created PR's note carries its URL.
                        value["note"]
                            .as_str()
                            .filter(|note| !note.is_empty())
                            .map_or_else(|| "Decision applied.".into(), String::from)
                    }
                    Err(error) => {
                        if error.status.is_some() {
                            this.stop_identity = None;
                        }
                        this.close_stage = None;
                        if merge && error.message.to_lowercase().contains("conflict") {
                            format!("{} Try \"Create PR\" instead.", error.message)
                        } else {
                            error.message
                        }
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
        match &action {
            Action::Hold(row, _) | Action::Lane(row, _) | Action::Close(row) => {
                self.packet.action = Some(row.id.clone())
            }
            Action::StopMission => self.packet.action = None,
            _ => {}
        }
        match action {
            Action::BackToFeed => self.commit = None,
            Action::Packet(command) => self.packet_act(command, cx),
            Action::Proposals => {self.proposals.open = !self.proposals.open; self.saved.proposals_open=Some(self.proposals.open); self.mark_proposals_seen(cx); self.remember_view(cx);},
            Action::ProposalDetail(id) => {if !self.proposals.expanded.remove(&id){self.proposals.expanded.insert(id);}},
            Action::ProposalDecision(id,accept) => self.proposal_action(id,accept,cx),
            Action::RetryProposals => self.load_proposals(cx),
            Action::Filter(filter) => { self.filter = filter; self.expanded = None; }
            Action::ScopeMenu(open) => self.scope_menu = open,
            Action::Scope(scope) => {
                self.remember_view(cx);
                self.scope_menu = false;
                self.scope = scope;
                self.restore_view();
                if let Some(y)=self.restore_y {self.scroll.set_offset(gpui::point(gpui::px(0.),gpui::px(y)));} self.generation += 1; self.loading = false;
                self.packet.reads.clear(); self.packet.editor = None; self.rows.clear(); self.errors.clear(); self.details.clear(); self.keyboard = None; self.load(cx);
            }
            Action::Refresh => { self.packet.reads.clear(); self.refresh_feed(true,true,cx); self.load_dossiers(cx); self.load_proposals(cx); },
            Action::Attention => {
                self.attention_open = !self.attention_open;
                self.mark_proposals_seen(cx);
            }
            Action::Dossiers => self.decisions.open = !self.decisions.open,
            Action::DossierHistory(id) => self.decisions.expanded = if self.decisions.expanded.as_ref() == Some(&id) { None } else { Some(id) },
            Action::DossierDecision(id, action) => self.dossier_decision(id, action, cx),
            Action::RetryDossiers => self.load_dossiers(cx),
            Action::Expand(row) => {
                if self.expanded.as_ref() == Some(&row.key()) { self.expanded = None; }
                else { self.expanded = Some(row.key()); if row.kind == "packet" { self.packet_read(row,false,cx); } else { self.detail(row,false,cx); } }
            }
            Action::RetryDetail(row) => self.detail(row,true,cx),
            Action::Link(url) => cx.open_url(&url),
            Action::Open(row) => {
                if row.kind == "commit" {
                    cx.emit(ActivityEvent::Commit(row));
                } else if row.kind == "pr" && self.pr_browser == Some(true) {
                    if let Some(url) = row.url() { cx.open_url(&url); }
                } else if let Some(url) = row.url() {
                    cx.emit(ActivityEvent::Open(url));
                }
            }
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
            Action::Lane(row, verb) => {
                let lane = feed::text(&row.data["lane"], "laneId");
                if lane.is_empty() { return; }
                let mut body = json!({"verb": verb, "laneId": lane});
                match verb {
                    "resume" => { body["message"] = json!("Continue the previous task."); body["actor"] = json!("user"); }
                    "stop" => body["actor"] = json!("user"),
                    "create_pr" => body["commitMessage"] = json!("Auto-commit from lane"),
                    _ => body["commitMessage"] = json!(format!("Merge lane: {}", feed::text(&row.data, "title"))),
                }
                self.mutate("POST", "/api/lanes", body, cx);
            }
            Action::CloseAsk(packet) => { self.closing = packet; self.close_reason = CLOSE_REASONS[0].0; }
            Action::CloseReason(reason) => self.close_reason = reason,
            Action::Close(row) => {
                if self.pending { return; }
                let mutation = format!("next-close-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
                self.mutate("POST", "/api/orchestrator/discard-packet", json!({"packetId": row.id, "disposition": self.close_reason, "clientMutationId": mutation}), cx);
                // The stage shows on the confirm itself, as in classic.
                self.notice.clear();
                self.close_stage = Some("Closing packet…");
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_secs(3)).await;
                    let _ = this.update(cx, |this, cx| {
                        if this.close_stage.is_some() && this.closing.as_deref() == Some(row.id.as_str()) {
                            this.close_stage = Some("Preserving work and archiving…");
                            this.changed(cx);
                        }
                    });
                })
                .detach();
            }
        }
        self.remember_view(cx);
        self.changed(cx);
    }
    /// The scope menu row for the current scope.
    pub(super) fn checked_scope(&self) -> String {
        self.repos
            .iter()
            .position(|repo| self.scope != "*" && repo.local_path == self.scope)
            .map_or_else(
                || "activity-scope-all".into(),
                |i| format!("activity-scope-{i}"),
            )
    }
    pub(super) fn key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if event.keystroke.modifiers.control || event.keystroke.modifiers.platform {
            return;
        }
        match event.keystroke.key.as_str() {
            "tab" | "down" | "up" => {
                let length = self.controls.len().max(1);
                let current = self
                    .keyboard
                    .as_ref()
                    .and_then(|id| self.controls.iter().position(|(control, _)| control == id));
                let index = if event.keystroke.key == "up" || event.keystroke.modifiers.shift {
                    current.unwrap_or(0).wrapping_add(length - 1) % length
                } else {
                    current.map(|index| (index + 1) % length).unwrap_or(0)
                };
                self.keyboard = self.controls.get(index).map(|(id, _)| id.clone());
            }
            "enter" | "space" => {
                if let Some((_, action)) = self
                    .keyboard
                    .as_ref()
                    .and_then(|id| self.controls.iter().find(|(control, _)| control == id))
                    .cloned()
                {
                    let opening = matches!(action, Action::ScopeMenu(true));
                    self.act(action, cx);
                    self.packet_focus_editor(window, cx);
                    // As classic, the open menu starts on the checked scope.
                    if opening {
                        self.keyboard = Some(self.checked_scope());
                    }
                }
            }
            "escape" if self.commit.is_some() => self.commit = None,
            "escape" if self.scope_menu => {
                self.scope_menu = false;
                self.keyboard = Some("activity-scope".into());
            }
            "escape" => {
                self.expanded = None;
                self.keyboard = None;
            }
            _ => return,
        }
        self.changed(cx);
        cx.stop_propagation();
    }
}
#[path = "decisions.rs"]
mod decisions;
#[path = "view.rs"]
mod view;

#[path = "commit.rs"]
mod commit;
#[path = "packet.rs"]
mod packet;
#[path = "preferences.rs"]
pub(super) mod preferences;
#[path = "proposals.rs"]
mod proposals;
#[path = "updates.rs"]
mod updates;

#[cfg(test)]
impl ActivityPane {
    /// Proposed directives loaded, and directive ids saved as seen.
    pub(super) fn proposal_counts(&self) -> (usize, usize) {
        (self.proposals.rows().len(), self.proposals.seen.len())
    }
}
