//! Workspace sidebar. Rebuild descriptors on data/search changes; GPUI only
//! materializes visible rows. Global snapshots are invalidations, since the
//! desktop socket's initial tail is smaller than the complete HTTP inventory.
use crate::{
    client::{Client, Session},
    composer::{Composer, Submit},
    projects_model::{Action, Ledger, WorkspaceChange},
    sidebar,
    transport::{self, Incoming, Subscription},
};
use gpui::{
    Context, Entity, EventEmitter, FocusHandle, KeyDownEvent, ScrollStrategy,
    UniformListScrollHandle, Window, prelude::*,
};
use serde::Serialize;
use serde_json::json;
use std::{
    cell::Cell,
    collections::{BTreeMap, HashMap, HashSet},
    rc::Rc,
    time::{Duration, Instant},
};

#[derive(Clone)]
pub enum Event {
    Loaded(Vec<Session>),
    Refreshed(Vec<Session>, Option<Ledger>),
    Selected(String),
    Error(String),
    Workspace(Option<String>, Ledger),
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Row {
    pub kind: String,
    pub workspace: String,
    pub id: Option<String>,
    pub title: String,
    pub status: String,
    pub unread: bool,
    pub running: bool,
}
pub fn section(s: &Session) -> &'static str {
    if s.status == "archived" {
        "Archived"
    } else if s.id.contains(':') {
        "Workers"
    } else if sidebar::rank(s) > 0 {
        "Review"
    } else if sidebar::working(s) {
        "Working"
    } else {
        "Recent"
    }
}
pub fn rows(sessions: &[Session], query: &str, message_matches: &HashSet<String>) -> Vec<Row> {
    let query = query.trim().to_lowercase();
    let mut workspaces: BTreeMap<String, Vec<&Session>> = BTreeMap::new();
    for s in sessions {
        let workspace = s.repo_path.as_deref().unwrap_or("Unassigned");
        if !query.is_empty()
            && !format!("{} {} {}", s.title, s.status, workspace)
                .to_lowercase()
                .contains(&query)
            && !message_matches.contains(&s.id)
        {
            continue;
        }
        workspaces.entry(workspace.into()).or_default().push(s);
    }
    let mut groups: Vec<_> = workspaces.into_iter().collect();
    groups.sort_by_key(|(path, _)| (label(path).to_lowercase(), path.clone()));
    let mut result = vec![];
    for (workspace, sessions) in groups {
        let header = |kind: &str, title: String| Row {
            kind: kind.into(),
            workspace: workspace.clone(),
            id: None,
            title,
            status: String::new(),
            unread: false,
            running: false,
        };
        result.push(header("workspace", label(&workspace)));
        for name in ["Working", "Review", "Recent", "Workers", "Archived"] {
            let mut selected: Vec<_> = sessions
                .iter()
                .copied()
                .filter(|s| section(s) == name)
                .collect();
            selected.sort_by(|a, b| {
                (if name == "Review" {
                    sidebar::rank(b).cmp(&sidebar::rank(a))
                } else {
                    std::cmp::Ordering::Equal
                })
                .then_with(|| b.last_message_at.cmp(&a.last_message_at))
            });
            if selected.is_empty() {
                continue;
            }
            result.push(header("section", name.into()));
            result.extend(selected.into_iter().map(|s| Row {
                kind: "thread".into(),
                workspace: workspace.clone(),
                id: Some(s.id.clone()),
                title: s.title.clone(),
                status: s.status.clone(),
                unread: s.unread,
                running: sidebar::working(s),
            }));
        }
    }
    result
}
fn label(path: &str) -> String {
    path.rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or(path)
        .into()
}

pub struct ThreadList {
    client: Client,
    header: project_header::HeaderSnapshot,
    workspace: Option<String>,
    header_busy: bool,
    header_menu: Option<bool>,
    pub sessions: Vec<Session>,
    pub rows: Rc<Vec<Row>>,
    pub selected: Option<String>,
    pub scroll: UniformListScrollHandle,
    focus: FocusHandle,
    editor: Entity<Composer>,
    query: String,
    search_pending: Option<Instant>,
    search_running: bool,
    search_matches: HashSet<String>,
    search_error: String,
    rename: Option<String>,
    rename_drafts: HashMap<String, String>,
    editing: bool,
    choice: Option<String>,
    edit_generation: u64,
    loading: bool,
    saving: bool,
    pending_archives: HashMap<String, String>,
    dirty: Option<Instant>,
    generation: u64,
    last_load: Instant,
    last_inventory: Instant,
    inventory_loading: bool,
    subscription: Subscription,
    subscriptions: Vec<gpui::Subscription>,
    notice: String,
    pub painted: Rc<Cell<usize>>,
    pub materialized: Rc<Cell<usize>>,
}
impl EventEmitter<Event> for ThreadList {}
impl ThreadList {
    #[cfg(test)]
    pub(crate) fn diagnostic(&self) -> serde_json::Value {
        json!({"headerMenu":self.header_menu,"project":self.header.ledger.active_project_id,"notice":self.notice,"rename":self.rename,"editing":self.editing,"saving":self.saving,"loading":self.loading,"selected":self.selected,"choice":self.choice_row()})
    }
    pub fn new(client: Client, cx: &mut Context<Self>) -> Self {
        let editor = cx.new(Composer::new);
        let observe = cx.observe(&editor, |this, editor, cx| {
            if this.rename.is_none() {
                let query = editor.read(cx).text.clone();
                if query == this.query {
                    return;
                }
                this.query = query;
                this.search_matches.clear();
                this.search_error.clear();
                this.search_pending = (!this.query.trim().is_empty()).then(Instant::now);
                this.rebuild();
                cx.notify();
            }
        });
        let submit = cx.subscribe(&editor, |this, _, _: &Submit, cx| this.submit(cx));
        Self {
            subscription: transport::subscribe_global(client.clone()),
            client,
            header: project_header::HeaderSnapshot::default(),
            workspace: None,
            header_busy: false,
            header_menu: None,
            sessions: vec![],
            rows: Rc::new(vec![]),
            selected: None,
            scroll: UniformListScrollHandle::new(),
            focus: cx.focus_handle(),
            editor,
            query: String::new(),
            search_pending: None,
            search_running: false,
            search_matches: HashSet::new(),
            search_error: String::new(),
            rename: None,
            rename_drafts: HashMap::new(),
            editing: false,
            choice: None,
            edit_generation: 0,
            loading: false,
            saving: false,
            pending_archives: HashMap::new(),
            dirty: None,
            generation: 0,
            last_load: Instant::now(),
            last_inventory: Instant::now(),
            inventory_loading: false,
            subscriptions: vec![observe, submit],
            notice: String::new(),
            painted: Rc::new(Cell::new(usize::MAX)),
            materialized: Rc::new(Cell::new(0)),
        }
    }
    fn choice_row(&self) -> Option<&Row> {
        self.choice
            .as_ref()
            .and_then(|id| self.rows.iter().find(|r| r.id.as_ref() == Some(id)))
    }
    fn rebuild(&mut self) {
        self.rows = Rc::new(rows(&self.sessions, &self.query, &self.search_matches));
        if !self
            .rows
            .iter()
            .any(|r| r.id.is_some() && r.id == self.choice)
        {
            self.choice = self.rows.iter().find_map(|r| r.id.clone());
        }
    }
    pub fn catalog_changed(&mut self) {
        self.generation += 1;
        self.dirty.get_or_insert_with(Instant::now);
    }
    pub fn load(&mut self, cx: &mut Context<Self>) {
        if self.loading || self.saving {
            return;
        }
        self.loading = true;
        self.dirty = None;
        let generation = self.generation;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let sessions = client.sidebar_sessions()?;
            let header = project_header::HeaderSnapshot::load(&client).ok();
            let ledger = header.as_ref().map(|header| header.ledger.clone());
            Ok::<_, String>((sessions, ledger, header))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                if generation != this.generation {
                    this.dirty = Some(Instant::now());
                    return;
                }
                this.last_load = Instant::now();
                this.last_inventory = Instant::now();
                match result {
                    Ok((mut sessions, ledger, header)) => {
                        if let Some(header) = header {
                            this.header = header;
                        }
                        let previous: HashMap<_, _> =
                            this.sessions.iter().map(|s| (s.id.as_str(), s)).collect();
                        for s in &mut sessions {
                            if let Some(old) = previous.get(s.id.as_str()) {
                                s.unread = this.selected.as_ref() != Some(&s.id)
                                    && (old.unread || s.last_message_at > old.last_message_at);
                            }
                        }
                        this.sessions = sessions;
                        if !this.query.trim().is_empty() {
                            this.search_pending = Some(Instant::now());
                        }
                        this.rebuild();
                        this.notice.clear();
                        cx.emit(Event::Refreshed(this.sessions.clone(), ledger));
                    }
                    Err(error) => {
                        this.notice = error.clone();
                        cx.emit(Event::Error(error));
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub fn tick(&mut self, cx: &mut Context<Self>) {
        let messages: Vec<_> = self.subscription.receiver.try_iter().take(64).collect();
        let mut changed = false;
        for message in messages {
            if let Incoming::Frame(frame) = message {
                if frame["channel"] == "orchestrator-threads"
                    && matches!(
                        frame["event"].as_str(),
                        Some("upsert" | "created" | "updated")
                    )
                    && let Ok(mut incoming) =
                        serde_json::from_value::<Session>(frame["data"]["thread"].clone())
                {
                    incoming.title = crate::text::sanitize(&incoming.title);
                    if incoming.status == "busy" {
                        incoming.status = "running".into();
                    }
                    if let Some(old) = self.sessions.iter_mut().find(|s| s.id == incoming.id) {
                        if incoming.last_message_at < old.last_message_at
                            || old.status == "archived"
                        {
                            continue;
                        }
                        incoming.unread = self.selected.as_ref() != Some(&old.id)
                            && (old.unread || incoming.last_message_at > old.last_message_at);
                        incoming.packet_header = old.packet_header.clone();
                        incoming.packet_state = old.packet_state;
                        // Packet attention comes from the lifecycle API.
                        // A thread's own failure can recover on this stream.
                        if old.packet_state || old.outcome.is_some() {
                            incoming.status = old.status.clone();
                            incoming.rejected = old.rejected;
                            incoming.outcome = old.outcome.clone();
                        }
                        if *old == incoming {
                            continue;
                        }
                        *old = incoming;
                    } else {
                        self.sessions.push(incoming);
                    }
                    changed = true;
                    // Fence an older in-flight HTTP read without making a
                    // new inventory request for each streamed text chunk.
                    self.generation += 1;
                    continue;
                }
                if matches!(
                    frame["channel"].as_str(),
                    Some("orchestrator-threads" | "agent-lifecycle" | "lane-lifecycle")
                ) || frame["channel"] == "system" && frame["event"] == "connected"
                    || frame["channel"] == "realtime"
                        && frame["event"] == "batch"
                        && frame["data"]["events"].as_array().is_some_and(|events| {
                            events.iter().any(|event| {
                                event["stream"] == "global"
                                    && matches!(
                                        event["channel"].as_str(),
                                        Some(
                                            "orchestrator-threads"
                                                | "agent-lifecycle"
                                                | "lane-lifecycle"
                                        )
                                    )
                            })
                        })
                {
                    self.generation += 1;
                    self.dirty.get_or_insert_with(Instant::now);
                }
            }
        }
        if changed {
            if !self.query.trim().is_empty() {
                self.search_pending = Some(Instant::now());
            }
            self.rebuild();
            cx.emit(Event::Loaded(self.sessions.clone()));
            cx.notify();
        }
        if self.rename.is_none()
            && !self.search_running
            && self
                .search_pending
                .is_some_and(|time| time.elapsed() >= Duration::from_millis(300))
        {
            self.search_pending = None;
            self.search_running = true;
            let query = self.query.clone();
            let requested = query.clone();
            let client = self.client.clone();
            let task = cx
                .background_executor()
                .spawn(async move { client.search_thread_ids(&requested) });
            cx.spawn(async move |this, cx| {
                let result = task.await;
                let _ = this.update(cx, |this, cx| {
                    this.search_running = false;
                    if this.query != query {
                        cx.notify();
                        return;
                    }
                    match result {
                        Ok(matches) => {
                            this.search_matches = matches;
                            this.search_error.clear();
                            this.rebuild();
                        }
                        Err(error) => {
                            this.search_error = format!("Message search unavailable: {error}")
                        }
                    }
                    cx.notify();
                });
            })
            .detach();
            cx.notify();
        }
        // Same broad resilience cadence as the desktop sidebar. The loop drains
        // a local event queue; it makes no 20ms HTTP requests.
        if self
            .dirty
            .is_some_and(|time| time.elapsed() >= Duration::from_millis(300))
            || self.last_load.elapsed() >= Duration::from_secs(300)
        {
            self.load(cx);
        }
        if !self.loading
            && !self.inventory_loading
            && self.last_inventory.elapsed() >= Duration::from_secs(10)
        {
            self.inventory_loading = true;
            let generation = self.generation;
            let client = self.client.clone();
            let task = cx
                .background_executor()
                .spawn(async move { client.sidebar_workers() });
            cx.spawn(async move |this, cx| {
                let result = task.await;
                let _ = this.update(cx, |this, cx| {
                    this.inventory_loading = false;
                    this.last_inventory = Instant::now();
                    if this.loading || this.generation != generation {
                        return;
                    }
                    if let Ok(mut workers) = result {
                        for worker in &mut workers {
                            if let Some(old) = this.sessions.iter().find(|s| s.id == worker.id) {
                                worker.packet_header = old.packet_header.clone();
                                worker.unread = old.unread
                                    || this.selected.as_ref() != Some(&worker.id)
                                        && worker.last_message_at > old.last_message_at;
                            }
                        }
                        this.sessions.retain(|s| !s.id.contains(':'));
                        workers
                            .retain(|worker| !this.sessions.iter().any(|s| s.key() == worker.id));
                        this.sessions.extend(workers);
                        this.rebuild();
                        cx.emit(Event::Loaded(this.sessions.clone()));
                        cx.notify();
                    }
                });
            })
            .detach();
        }
    }
    fn suspend_rename(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.rename.take() else {
            return;
        };
        self.edit_generation += 1;
        self.rename_drafts
            .insert(id, self.editor.read(cx).text.clone());
        self.editing = false;
        let query = self.query.clone();
        self.editor.update(cx, |editor, cx| {
            editor.clear(cx);
            editor.set_text(&query, cx);
        });
    }
    pub fn focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.edit_generation += 1;
        self.suspend_rename(cx);
        self.editing = false;
        self.focus.focus(window);
        cx.notify();
    }
    pub fn sync_selection(&mut self, id: String, cx: &mut Context<Self>) {
        if self.selected.as_ref() == Some(&id) {
            return;
        }
        if self.rename.as_ref().is_some_and(|owner| owner != &id) {
            self.suspend_rename(cx);
        }
        self.selected = Some(id.clone());
        if let Some(session) = self.sessions.iter_mut().find(|s| s.id == id) {
            session.unread = false;
        }
        self.rebuild();
        if self.rows.iter().any(|r| r.id.as_deref() == Some(&id)) {
            self.choice = Some(id);
        }
        cx.notify();
    }
    pub fn search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.edit_generation += 1;
        self.suspend_rename(cx);
        self.editing = true;
        self.editor.read(cx).focus.focus(window);
        cx.notify();
    }
    pub fn choose(&mut self, id: String, cx: &mut Context<Self>) {
        if !self.rows.iter().any(|r| r.id.as_ref() == Some(&id)) {
            return;
        }
        self.edit_generation += 1;
        self.suspend_rename(cx);
        self.choice = Some(id.clone());
        self.editing = false;
        self.selected = Some(id.clone());
        if let Some(s) = self.sessions.iter_mut().find(|s| s.id == id) {
            s.unread = false;
        }
        self.rebuild();
        cx.emit(Event::Selected(id));
        cx.notify();
    }
    fn submit(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.rename.clone() {
            let title = self.editor.read(cx).text.trim().to_string();
            if !title.is_empty() {
                self.mutate(id, json!({"title":title}), cx);
            }
        } else if let Some(id) = self.choice.clone() {
            self.choose(id, cx);
        }
    }
    fn start_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.edit_generation += 1;
        let Some(id) = self.choice.clone().filter(|id| !id.contains(':')) else {
            return;
        };
        self.suspend_rename(cx);
        let draft = self.rename_drafts.remove(&id).unwrap_or_default();
        self.rename = Some(id);
        self.search_pending = None;
        self.editing = true;
        self.editor.update(cx, |e, cx| {
            e.clear(cx);
            e.set_text(&draft, cx);
        });
        self.editor.read(cx).focus.focus(window);
        cx.notify();
    }
    fn archive(&mut self, cx: &mut Context<Self>) {
        let Some(row) = self.choice_row().cloned() else {
            return;
        };
        if let Some(id) = row.id.as_ref().filter(|id| id.contains(':')).cloned() {
            let mutation = self
                .pending_archives
                .entry(id.clone())
                .or_insert_with(|| {
                    format!(
                        "next-sidebar-{}",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_nanos()
                    )
                })
                .clone();
            self.mutate(id, json!({"clientMutationId":mutation}), cx);
            return;
        }
        // Seconds since epoch are converted to the existing nullable ISO contract.
        let date = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let archived = if row.status == "archived" {
            serde_json::Value::Null
        } else {
            json!(iso_timestamp(date))
        };
        self.mutate(row.id.clone().unwrap(), json!({"archivedAt":archived}), cx);
    }
    fn mutate(&mut self, id: String, patch: serde_json::Value, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        self.saving = true;
        self.generation += 1;
        let edit_generation = self.edit_generation;
        let editor_revision = self.editor.read(cx).revision;
        let draft_owner = self.rename.clone();
        let renaming = draft_owner.as_ref() == Some(&id) && patch["title"].is_string();
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            if id.contains(':') {
                client.archive_worker(&id, patch["clientMutationId"].as_str().unwrap())
            } else {
                client.patch_thread(&id, patch)
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                let current_draft = this.edit_generation == edit_generation
                    && this.editor.read(cx).revision == editor_revision
                    && this.rename == draft_owner;
                match result {
                    Ok(()) => {
                        if renaming && current_draft {
                            this.edit_generation += 1;
                            if let Some(id) = this.rename.take() {
                                this.rename_drafts.remove(&id);
                            }
                            this.editing = false;
                            this.editor.update(cx, |e, cx| e.clear(cx));
                        }
                        this.load(cx);
                    }
                    Err(error) if current_draft => this.notice = error,
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.header_key(event, window, cx) {
            return;
        }
        let key = event.keystroke.key.as_str();
        match key {
            "escape" => {
                self.header_menu = None;
                self.edit_generation += 1;
                if let Some(id) = self.rename.take() {
                    self.rename_drafts.remove(&id);
                }
                self.editing = false;
                self.editor.update(cx, |e, cx| e.clear(cx));
                self.focus.focus(window);
            }
            "f2" => self.start_rename(window, cx),
            "delete" if !self.editing => self.archive(cx),
            "enter" if !self.editing => self.submit(cx),
            "up" | "down" | "home" | "end" if !self.editing => {
                let ids: Vec<_> = self
                    .rows
                    .iter()
                    .enumerate()
                    .filter_map(|(i, row)| row.id.as_ref().map(|id| (i, id.clone())))
                    .collect();
                if ids.is_empty() {
                    return;
                }
                let current = ids
                    .iter()
                    .position(|(_, id)| Some(id) == self.choice.as_ref())
                    .unwrap_or(0);
                let next = match key {
                    "up" => current.saturating_sub(1),
                    "down" => (current + 1).min(ids.len() - 1),
                    "home" => 0,
                    _ => ids.len() - 1,
                };
                self.choice = Some(ids[next].1.clone());
                self.scroll.scroll_to_item(ids[next].0, ScrollStrategy::Top);
            }
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }
}
// Gregorian UTC conversion avoids a new dependency solely for archive metadata.
fn iso_timestamp(seconds: u64) -> String {
    let days = (seconds / 86400) as i64 + 719468;
    let era = days / 146097;
    let doe = days - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = year + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        seconds / 3600 % 24,
        seconds / 60 % 60,
        seconds % 60
    )
}
#[path = "thread_list_view.rs"]
mod view;

#[cfg(test)]
#[path = "race_tests.rs"]
mod races;

#[path = "project_header.rs"]
mod project_header;
