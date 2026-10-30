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
    collections::{HashMap, HashSet},
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
    /// A `ui-command` frame for the main window. Every socket receives the
    /// broadcast; only this global one hands it on.
    UiCommand(serde_json::Value),
    /// A project's repository scope changed; empty shows every repository.
    Scope(String, Vec<String>),
    /// A project's view changed (folders::View::key).
    View(String, &'static str),
    /// The closed By repo folders, by repository path.
    Folders(Vec<String>),
    /// The project menu's Switch workspace, with the focus to give back.
    WorkspacePicker(Option<gpui::FocusHandle>),
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
    pub age: String,
    pub branch: bool,
    pub attention: bool,
    /// Set on a By repo folder row.
    pub folder: Option<folders::Folder>,
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
    /// Focus before the project menu opened; Switch workspace returns it.
    header_focus: Option<gpui::FocusHandle>,
    /// Each project's repository scope (T3's projectScopeKeys), by project id.
    scopes: HashMap<String, Vec<String>>,
    scope_menu: Option<project_header::ScopeMenu>,
    row_menu: Option<project_header::RowMenu>,
    /// Each project's view, by project id; By date when absent.
    views: HashMap<String, folders::View>,
    view_menu: bool,
    new_menu: bool,
    /// The press that last closed a menu from outside it; when that press
    /// lands on the menu's trigger, its click must not reopen the menu.
    menu_press: Option<gpui::Point<gpui::Pixels>>,
    /// A thread New thread created; the shell opens it once the list has it.
    pending_open: Option<String>,
    /// Closed By repo folders, by repository path.
    closed: HashSet<String>,
    pub sessions: Vec<Session>,
    pub rows: Rc<Vec<Row>>,
    pub selected: Option<String>,
    pub scroll: UniformListScrollHandle,
    focus: FocusHandle,
    archived_focus: FocusHandle,
    editor: Entity<Composer>,
    query: String,
    expanded: HashSet<String>,
    branch_ids: HashSet<String>,
    archived_open: bool,
    #[cfg(test)]
    pub(super) title_layouts: HashMap<String, gpui::TextLayout>,
    last_age: Instant,
    search_pending: Option<Instant>,
    search_running: bool,
    search_matches: HashSet<String>,
    search_error: String,
    rename: Option<String>,
    rename_drafts: HashMap<String, String>,
    editing: bool,
    choice: Option<String>,
    // A selection made before its thread is listed moves the choice once it arrives.
    follow_selection: bool,
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
        json!({"headerMenu":self.header_menu,"project":self.header.ledger.active_project_id,"notice":self.notice,"rename":self.rename,"editing":self.editing,"saving":self.saving,"loading":self.loading,"selected":self.selected,"choice":self.choice_row(),"dirty":self.dirty.is_some(),"generation":self.generation})
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
            header_focus: None,
            scopes: HashMap::new(),
            scope_menu: None,
            row_menu: None,
            views: HashMap::new(),
            view_menu: false,
            new_menu: false,
            menu_press: None,
            pending_open: None,
            closed: HashSet::new(),
            sessions: vec![],
            rows: Rc::new(vec![]),
            selected: None,
            scroll: UniformListScrollHandle::new(),
            focus: cx.focus_handle(),
            archived_focus: cx.focus_handle().tab_stop(true),
            editor,
            query: String::new(),
            expanded: HashSet::new(),
            branch_ids: HashSet::new(),
            archived_open: false,
            #[cfg(test)]
            title_layouts: HashMap::new(),
            last_age: Instant::now(),
            search_pending: None,
            search_running: false,
            search_matches: HashSet::new(),
            search_error: String::new(),
            rename: None,
            rename_drafts: HashMap::new(),
            editing: false,
            choice: None,
            follow_selection: false,
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
        let previous_choice = self
            .rows
            .iter()
            .position(|r| r.id.is_some() && r.id == self.choice);
        if let Some(session) = self
            .sessions
            .iter()
            .find(|s| self.selected.as_ref() == Some(&s.id))
        {
            self.expanded.insert(self.group_key(session).into());
        }
        let sessions = self.scoped_sessions();
        let mut rows = self.view_rows(&sessions);
        // An incoming message can push the keyboard choice past Show more.
        // Disclosure must follow that thread's identity before choosing a fallback.
        if self.query.trim().is_empty()
            && !rows.iter().any(|r| r.id.is_some() && r.id == self.choice)
            && let Some(session) = self
                .sessions
                .iter()
                .find(|s| self.choice.as_ref() == Some(&s.id))
        {
            self.expanded.insert(self.group_key(session).into());
            rows = self.view_rows(&sessions);
        }
        if !self.archived_open
            && self.query.trim().is_empty()
            && let Some(index) = rows
                .iter()
                .position(|r| r.kind == "section" && r.title == "Archived")
        {
            rows.truncate(index);
        }
        self.rows = Rc::new(rows);
        if !self
            .rows
            .iter()
            .any(|r| r.id.is_some() && r.id == self.choice)
        {
            self.choice = self.rows.iter().find_map(|r| r.id.clone());
        }
        if self.follow_selection
            && let Some(id) = self.selected.clone()
            && self.rows.iter().any(|r| r.id.as_ref() == Some(&id))
        {
            self.choice = Some(id);
            self.follow_selection = false;
        }
        if let Some(index) = self
            .rows
            .iter()
            .position(|r| r.id.is_some() && r.id == self.choice)
            && previous_choice.is_some_and(|previous| previous != index)
        {
            self.scroll.scroll_to_item(index, ScrollStrategy::Top);
        }
    }
    /// The disclosure group a thread belongs to in the current view.
    fn group_key(&self, session: &Session) -> &'static str {
        match self.view() {
            _ if session.status == "archived" => "Archived",
            folders::View::Date => recents::group(session, recents::now()),
            folders::View::Chronological => "Chronological",
            folders::View::Repo => "",
        }
    }
    fn view_rows(&self, sessions: &[Session]) -> Vec<Row> {
        let (query, matches) = (&self.query, &self.search_matches);
        let (expanded, branches) = (&self.expanded, &self.branch_ids);
        match self.view() {
            folders::View::Date => recents::rows(sessions, query, matches, expanded, branches),
            folders::View::Chronological => {
                folders::chronological(sessions, query, matches, expanded, branches)
            }
            folders::View::Repo => {
                let keys = self.scope_keys();
                let repos: Vec<_> = self
                    .scope_repos()
                    .into_iter()
                    .filter(|(path, _)| keys.is_empty() || keys.contains(path))
                    .collect();
                folders::by_repo(
                    sessions,
                    query,
                    matches,
                    expanded,
                    branches,
                    &repos,
                    &self.closed,
                    !keys.is_empty(),
                )
            }
        }
    }
    pub fn catalog_changed(&mut self) {
        self.generation += 1;
        self.dirty.get_or_insert_with(Instant::now);
    }
    pub fn load(&mut self, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        if self.saving {
            // The shell may already be awaiting this refresh. Retry after the
            // save settles, including when its mutation is rejected.
            self.dirty.get_or_insert_with(Instant::now);
            return;
        }
        self.loading = true;
        self.dirty = None;
        let generation = self.generation;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let (sessions, branches) = client.sidebar_sessions_with_branches()?;
            let header = match project_header::HeaderSnapshot::load(&client) {
                Ok(header) => Some(header),
                // Older session-only hosts do not provide project routes.
                Err(error) if error.ends_with("Server returned HTTP 404") => None,
                Err(error) => return Err(error),
            };
            let ledger = header.as_ref().map(|header| header.ledger.clone());
            Ok::<_, String>((sessions, ledger, header, branches))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                // Stream updates fence stale catalog snapshots, not transport
                // failures. Suppressing an error leaves the shell waiting for
                // recovery while the next full request deadline runs again.
                if result.is_ok() && generation != this.generation {
                    this.dirty = Some(Instant::now());
                    return;
                }
                this.last_load = Instant::now();
                this.last_inventory = Instant::now();
                match result {
                    Ok((mut sessions, ledger, header, branches)) => {
                        this.branch_ids = branches;
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
                        if let Some(id) = this
                            .pending_open
                            .take_if(|id| this.sessions.iter().any(|s| &s.id == id))
                        {
                            cx.emit(Event::Selected(id));
                        }
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
        if self.last_age.elapsed() >= Duration::from_secs(60) {
            self.last_age = Instant::now();
            self.rebuild();
            cx.notify();
        }
        let messages: Vec<_> = self.subscription.receiver.try_iter().take(64).collect();
        let mut changed = false;
        for message in messages {
            if let Incoming::Frame(frame) = message {
                if frame["type"] == "ui-command" {
                    cx.emit(Event::UiCommand(frame));
                    continue;
                }
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
        self.reveal(&id, cx);
        self.rebuild();
        if self.rows.iter().any(|r| r.id.as_deref() == Some(&id)) {
            self.choice = Some(id);
        } else {
            self.follow_selection = true;
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
        // A choice made before the list carries a new thread cancels its open.
        self.pending_open = None;
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
        if let Some(id) = self.choice.clone() {
            self.archive_id(id, cx);
        }
    }
    fn archive_id(&mut self, id: String, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        let Some(session) = self.sessions.iter().find(|s| s.id == id) else {
            return;
        };
        let archived = session.status == "archived";
        if id.contains(':') {
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
        let archived = if archived {
            serde_json::Value::Null
        } else {
            json!(iso_timestamp(date))
        };
        self.mutate(id, json!({"archivedAt":archived}), cx);
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
        let workspace = self
            .sessions
            .iter()
            .find(|session| session.id == id)
            .and_then(|session| session.repo_path.clone());
        let archive_notice = patch.get("archivedAt").map(|value| {
            if value.is_null() {
                "Thread restored."
            } else {
                "Thread archived."
            }
        });
        let task = cx
            .background_executor()
            .spawn(async move { client.mutate_sidebar(workspace.as_deref(), &id, patch) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                let current_draft = this.edit_generation == edit_generation
                    && this.editor.read(cx).revision == editor_revision
                    && this.rename == draft_owner;
                match result {
                    Ok(()) => {
                        if let Some(message) = archive_notice {
                            crate::shell::toasts::show(
                                crate::shell::toasts::Kind::Chat,
                                message,
                                vec![],
                                Some(crate::shell::toasts::CHAT_TIMEOUT),
                                cx,
                            );
                        }
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
        if self.scope_key(event, cx) {
            return;
        }
        if self.header_key(event, window, cx) {
            return;
        }
        if self.archived_key(event, window, cx) {
            return;
        }
        let key = event.keystroke.key.as_str();
        match key {
            "escape" => {
                self.header_menu = None;
                self.view_menu = false;
                self.new_menu = false;
                self.row_menu = None;
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
                if key == "end" {
                    self.expanded.extend(
                        [
                            "Chronological",
                            "Today",
                            "Previous 7 days",
                            "Previous 30 days",
                            "Older",
                            "Archived",
                        ]
                        .map(str::to_owned),
                    );
                    self.rebuild();
                }
                if key == "down"
                    && let Some(index) = self
                        .rows
                        .iter()
                        .position(|r| r.id.as_ref() == self.choice.as_ref() && r.id.is_some())
                    && let Some(more) = self.rows.get(index + 1).filter(|r| r.kind == "more")
                {
                    self.expanded.insert(more.status.clone());
                    self.rebuild();
                }
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
                self.follow_selection = false;
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

#[path = "recents.rs"]
pub(crate) mod recents;

#[path = "folders.rs"]
pub(crate) mod folders;

#[path = "archive_controls.rs"]
mod archive_controls;
