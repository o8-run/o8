//! Opt-in shell. Uses only main's surfaces; unavailable surfaces stay explicit.
use crate::{
    client::{Client, Session},
    inbox::{Inbox, OpenSession},
    pane_grid::Grid,
    pane_layout,
    projects::{Changed, Projects},
    projects_model::{Ledger, WorkspaceChange},
    settings::Settings,
    shell_state::{State, Tab, Workspace},
    ui::Surface,
};
use gpui::{
    App, Application, Bounds, Context, Entity, FocusHandle, KeyDownEvent, Render, Window,
    WindowBounds, WindowOptions, canvas, div, point, prelude::*, px, size,
};
use std::{
    cell::Cell,
    collections::{BTreeSet, HashMap},
    path::PathBuf,
    rc::Rc,
    time::Duration,
};

pub const HELP: &str = "App shell: --app-shell --shell-state ABSOLUTE_FILE --server ORIGIN [--offscreen]. The o8 next launcher resolves existing local configuration.";
#[derive(Clone)]
enum Command {
    Projects,
    Session(String),
    Brain,
    Grid,
    Message(String),
    Diff,
    Terminal,
    Inbox,
    Settings,
    Issues,
}
impl Command {
    fn label(&self, sessions: &[Session]) -> String {
        match self {
            Self::Projects => "Open projects and repositories".into(),
            Self::Session(id) => format!(
                "Open session: {}",
                sessions
                    .iter()
                    .find(|s| &s.id == id)
                    .map(|s| s.title.as_str())
                    .unwrap_or("Unavailable")
            ),
            Self::Brain => "Open Brain".into(),
            Self::Grid => "Open grid".into(),
            Self::Message(_) => "New message in selected session".into(),
            Self::Diff => "Open diff for a packet".into(),
            Self::Terminal => "Open terminal".into(),
            Self::Inbox => "Open Inbox".into(),
            Self::Settings => "Open settings".into(),
            Self::Issues => "Open issues".into(),
        }
    }
}
enum Content {
    Session(Entity<Surface>),
    Brain(Entity<crate::brain::Brain>),
    Grid(Entity<Grid>),
    Inbox(Entity<Inbox>),
    Issues(Entity<crate::issues::Issues>),
}
pub struct Shell {
    client: Client,
    file: PathBuf,
    state: State,
    sessions: Vec<Session>,
    workspaces: Vec<String>,
    content: HashMap<String, Content>,
    focus: FocusHandle,
    palette: bool,
    query: String,
    choice: usize,
    notice: String,
    loading: bool,
    connected: bool,
    revision: u64,
    painted: Rc<Cell<u64>>,
    subscriptions: Vec<gpui::Subscription>,
    settings: Option<Entity<Settings>>,
    settings_subscription: Option<gpui::Subscription>,
    projects: Option<Entity<Projects>>,
    projects_open: bool,
}
impl Shell {
    fn new(
        client: Client,
        file: PathBuf,
        state: State,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle();
        focus.focus(window);
        let mut shell = Self {
            client,
            file,
            state,
            sessions: vec![],
            workspaces: vec![],
            content: HashMap::new(),
            focus,
            palette: false,
            query: String::new(),
            choice: 0,
            notice: "Connecting to local o8 server…".into(),
            loading: false,
            connected: false,
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            subscriptions: vec![],
            settings: None,
            settings_subscription: None,
            projects: None,
            projects_open: false,
        };
        shell
            .subscriptions
            .push(cx.observe_window_bounds(window, |this, window, _| {
                let bounds = window.window_bounds().get_bounds();
                this.state.bounds = [
                    bounds.origin.x.into(),
                    bounds.origin.y.into(),
                    bounds.size.width.into(),
                    bounds.size.height.into(),
                ];
                this.persist();
            }));
        let view = cx.weak_entity();
        window.on_window_should_close(cx, move |window, cx| {
            let _ = view.update(cx, |this, cx| {
                this.capture(window, cx);
                this.persist();
            });
            true
        });
        shell.load(cx);
        shell
    }
    fn persist(&mut self) {
        if let Err(error) = self.state.save(&self.file) {
            self.notice = format!("{error}. View state remains in memory.");
        }
    }
    fn open_projects(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.capture(window, cx);
        if self.projects.is_none() {
            let client = self.client.clone();
            let projects = cx.new(|cx| Projects::new(client, cx));
            self.subscriptions.push(cx.subscribe_in(
                &projects,
                window,
                |this, _, event: &Changed, window, cx| {
                    for path in &event.removed {
                        this.workspaces.retain(|w| w != path);
                        this.state.workspaces.remove(path);
                        this.content
                            .retain(|key, _| !key.starts_with(&format!("{path}|")));
                        if this.state.selected.as_ref() == Some(path) {
                            this.state.selected = None;
                        }
                    }
                    for path in &event.registered {
                        if !this.workspaces.contains(path) {
                            this.workspaces.push(path.clone());
                        }
                    }
                    match &event.workspace {
                        Some(WorkspaceChange::Select(path)) => this.state.selected = path.clone(),
                        Some(WorkspaceChange::Open(path)) => {
                            this.state.selected = Some(path.clone());
                            this.projects_open = false;
                            this.ensure(window, cx);
                            this.restore_focus(window, cx);
                        }
                        None => {}
                    }
                    this.persist();
                    this.revision += 1;
                    cx.notify();
                },
            ));
            self.projects = Some(projects);
        } else if let Some(projects) = &self.projects {
            projects.update(cx, |view, cx| view.load(cx));
        }
        self.projects_open = true;
        self.palette = false;
        self.focus.focus(window);
        cx.notify();
    }
    fn load(&mut self, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        self.loading = true;
        self.notice = "Connecting to local o8 server…".into();
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let sessions = client.sessions()?;
            // Older fixture modes only expose session routes. The app server
            // also supplies the desktop ledger, including empty projects.
            let ledger = client.get::<Ledger>("/api/panel/projects", &[]).ok();
            Ok::<_, String>((sessions, ledger))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok((sessions, ledger)) => {
                        this.sessions = sessions;
                        let mut workspaces = this.sessions.iter().filter_map(|s| s.repo_path.clone()).collect::<BTreeSet<_>>();
                        if let Some(ledger) = &ledger {
                            workspaces.extend(ledger.projects.iter().flat_map(|p| p.repo_paths.clone()));
                        }
                        this.workspaces = workspaces.into_iter().collect();
                        this.connected = true;
                        let active = ledger.as_ref().and_then(|ledger| ledger.projects.iter().find(|p| p.id == ledger.active_project_id && p.id != "default"));
                        if let Some(active) = active {
                            if !this.state.selected.as_ref().is_some_and(|w| active.repo_paths.contains(w)) {
                                this.state.selected = active.repo_paths.first().cloned();
                            }
                        } else if !this.state.selected.as_ref().is_some_and(|w| this.workspaces.contains(w)) {
                            this.state.selected = this.workspaces.first().cloned();
                        }
                        this.notice = if this.workspaces.is_empty() { "Connected. No saved workspace sessions." } else { "Connected · Ctrl+K / Cmd+K: commands · Ctrl+Tab: next surface" }.into();
                        this.persist();
                    }
                    Err(error) => {
                        this.connected = false;
                        this.notice = format!("Local server unavailable: {error}. Start the local o8 server, then Retry.");
                    }
                }
                cx.notify();
            });
        }).detach();
        cx.notify();
    }
    fn workspace_sessions(&self) -> Vec<Session> {
        self.sessions
            .iter()
            .filter(|s| s.repo_path.as_ref() == self.state.selected.as_ref())
            .cloned()
            .collect()
    }
    fn current(&self) -> Option<&Workspace> {
        self.state
            .workspaces
            .get(self.state.selected.as_deref().unwrap_or(""))
    }
    fn key(&self, tab: &Tab) -> String {
        format!("{}|{:?}", self.state.selected.as_deref().unwrap_or(""), tab)
    }
    fn active(&self) -> Option<Tab> {
        self.current().and_then(|w| w.tabs.get(w.active)).cloned()
    }
    fn ensure(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.connected {
            return;
        }
        let workspace = match self.state.selected.clone() {
            Some(workspace) => workspace,
            None if self.active() == Some(Tab::Inbox) => String::new(),
            None => return,
        };
        if !self.state.workspaces.contains_key(&workspace) {
            let tabs = self
                .workspace_sessions()
                .first()
                .map(|s| vec![Tab::Session(s.id.clone())])
                .unwrap_or_default();
            self.state.workspaces.insert(
                workspace.clone(),
                Workspace {
                    tabs,
                    ..Default::default()
                },
            );
            self.persist();
        }
        let Some(tab) = self.active() else {
            return;
        };
        let key = self.key(&tab);
        if self.content.contains_key(&key) {
            return;
        }
        let client = self.client.in_workspace(&workspace);
        let content = match tab {
            Tab::Brain => Content::Brain(
                cx.new(|cx| crate::brain::Brain::new(client, workspace, None, window, cx)),
            ),
            Tab::Inbox => {
                let inbox = cx.new(|cx| Inbox::new(client, workspace, cx));
                self.subscriptions.push(cx.subscribe_in(&inbox, window, |this, _, event: &OpenSession, window, cx| {
                    if let Some(session) = this.sessions.iter().find(|s| s.key() == event.0 || s.id == event.0).cloned() {
                        if let Some(workspace) = session.repo_path {
                            this.switch(workspace, window, cx);
                        }
                        let id = session.id;
                        this.execute(Command::Session(id.clone()), window, cx);
                        if let Some(Content::Session(surface)) = this.content.get(&this.key(&Tab::Session(id.clone()))) {
                            surface.update(cx, |surface, cx| surface.shell_open(id, cx));
                        }
                        this.capture(window, cx);
                        this.persist();
                    } else {
                        this.notice = "Related session is unavailable. Refresh the server connection and try again.".into();
                        cx.notify();
                    }
                }));
                Content::Inbox(inbox)
            }
            Tab::Issues => Content::Issues(cx.new(|cx| {
                crate::issues::Issues::new(self.client.clone(), Some(workspace.clone()), window, cx)
            })),
            Tab::Session(id) => {
                let id = self
                    .current()
                    .and_then(|w| w.selections.get(&id))
                    .cloned()
                    .unwrap_or(id);
                let mut sessions = self.workspace_sessions();
                if !sessions.iter().any(|s| s.id == id) {
                    if let Some(session) = self.sessions.iter().find(|s| s.id == id) {
                        sessions.push(session.clone());
                    } else {
                        return;
                    }
                }
                Content::Session(cx.new(|cx| Surface::shell_new(client, sessions, id, window, cx)))
            }
            Tab::Grid => {
                let options = pane_layout::Options {
                    size: 4,
                    workspace,
                    file: self.file.with_extension("grid.json"),
                };
                if let Err(error) = options.load() {
                    self.notice = error;
                    return;
                }
                let grid = cx.new(|cx| Grid::new(client, options, window, cx));
                grid.update(cx, |g, cx| g.load(cx));
                Content::Grid(grid)
            }
        };
        self.content.insert(key, content);
        self.restore_focus(window, cx);
    }
    fn restore_focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette || self.projects_open {
            self.focus.focus(window);
            return;
        }
        if let Some(settings) = &self.settings {
            settings.read(cx).focus(window);
            return;
        }
        if let Some(tab) = self.active() {
            match self.content.get(&self.key(&tab)) {
                Some(Content::Session(session)) => session.read(cx).shell_focus(
                    self.current().is_some_and(|w| w.composer),
                    window,
                    cx,
                ),
                Some(Content::Brain(brain)) => brain.read(cx).focus(window, cx),
                // Grid reestablishes its own keyboard focus when opened or clicked.
                Some(Content::Grid(grid)) => grid.update(cx, |g, cx| g.shell_focus(window, cx)),
                Some(Content::Inbox(inbox)) => inbox.read(cx).focus(window),
                Some(Content::Issues(issues)) => issues.read(cx).focus(window, cx),
                _ => self.focus.focus(window),
            }
        } else {
            self.focus.focus(window);
        }
    }
    fn switch(&mut self, workspace: String, window: &mut Window, cx: &mut Context<Self>) {
        if !self.workspaces.contains(&workspace) {
            return;
        }
        self.capture(window, cx);
        self.state.selected = Some(workspace);
        self.projects_open = false;
        self.palette = false;
        self.ensure(window, cx);
        self.restore_focus(window, cx);
        self.persist();
        self.revision += 1;
        cx.notify();
    }
    fn capture(&mut self, window: &Window, cx: &App) {
        if self.palette || self.settings.is_some() || self.projects_open {
            return;
        }
        if let Some(tab) = self.active() {
            if let Some(Content::Session(session)) = self.content.get(&self.key(&tab)) {
                let (id, composer) = session.read(cx).shell_selection(window, cx);
                let workspace = self.state.selected.as_ref().unwrap();
                if let Some(saved) = self.state.workspaces.get_mut(workspace) {
                    if let (Tab::Session(original), Some(id)) = (&tab, id) {
                        saved.selections.insert(original.clone(), id);
                    }
                    saved.composer = composer;
                }
            }
        }
    }
    fn commands(&self) -> Vec<Command> {
        let mut commands = vec![
            Command::Brain,
            Command::Inbox,
            Command::Projects,
            Command::Grid,
            Command::Diff,
            Command::Terminal,
            Command::Settings,
            Command::Issues,
        ];
        if let Some(id) = match self.active() {
            Some(Tab::Session(id)) => Some(
                self.current()
                    .and_then(|w| w.selections.get(&id))
                    .cloned()
                    .unwrap_or(id),
            ),
            _ => self.workspace_sessions().first().map(|s| s.id.clone()),
        } {
            commands.insert(0, Command::Message(id));
        }
        commands.extend(
            self.workspace_sessions()
                .iter()
                .map(|s| Command::Session(s.id.clone())),
        );
        commands
            .into_iter()
            .filter(|c| {
                c.label(&self.sessions)
                    .to_lowercase()
                    .contains(&self.query.to_lowercase())
            })
            .collect()
    }
    fn execute(&mut self, command: Command, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(command, Command::Settings) {
            self.open_settings(window, cx);
            return;
        }
        if matches!(command, Command::Projects) {
            self.open_projects(window, cx);
            return;
        }
        self.settings = None;
        self.settings_subscription = None;
        let (tab, composer) = match command {
            Command::Projects => unreachable!(),
            Command::Session(id) => (Tab::Session(id), false),
            Command::Message(id) => (Tab::Session(id), true),
            Command::Brain => (Tab::Brain, false),
            Command::Grid => (Tab::Grid, false),
            Command::Inbox => (Tab::Inbox, false),
            Command::Settings => unreachable!(),
            Command::Issues => (Tab::Issues, false),
            Command::Diff | Command::Terminal => {
                self.notice = "This surface is not available in this build. The terminal and packet diff changes must land before the shell can open them.".into();
                self.palette = false;
                self.restore_focus(window, cx);
                cx.notify();
                return;
            }
        };
        self.projects_open = false;
        // An empty key stores the global Inbox before any workspace exists.
        if let Some(workspace) = self
            .state
            .selected
            .clone()
            .or_else(|| (tab == Tab::Inbox).then(String::new))
        {
            let saved = self.state.workspaces.entry(workspace).or_default();
            let index = saved.tabs.iter().position(|t| t == &tab);
            if index.is_none() && saved.tabs.len() >= 32 {
                self.notice = "Close a surface before opening another.".into();
                return;
            }
            saved.active = index.unwrap_or_else(|| {
                saved.tabs.push(tab);
                saved.tabs.len() - 1
            });
            saved.composer = composer;
        }
        self.palette = false;
        self.ensure(window, cx);
        self.restore_focus(window, cx);
        self.persist();
        self.revision += 1;
        cx.notify();
    }
    fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.capture(window, cx);
        self.palette = false;
        self.projects_open = false;
        let client = self.client.clone();
        let settings = cx.new(|cx| Settings::new(client, window, cx));
        self.settings_subscription = Some(cx.subscribe_in(
            &settings,
            window,
            |this, _, _: &crate::settings::Close, window, cx| this.close_settings(window, cx),
        ));
        self.settings = Some(settings);
        self.revision += 1;
        cx.notify();
    }
    fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings = None;
        self.settings_subscription = None;
        self.restore_focus(window, cx);
        self.revision += 1;
        cx.notify();
    }
    fn key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        if (modifiers.control || modifiers.platform) && key == "," {
            if self.settings.is_some() {
                self.close_settings(window, cx);
            } else {
                self.open_settings(window, cx);
            }
        } else if self.settings.is_some() && modifiers.control && !modifiers.alt && key == "w" {
            self.close_settings(window, cx);
        } else if (modifiers.control || modifiers.platform) && key == "k" {
            if !self.palette {
                self.capture(window, cx);
            }
            self.palette = !self.palette;
            self.query.clear();
            self.choice = 0;
            self.restore_focus(window, cx);
        } else if self.palette {
            match key {
                "escape" => {
                    self.palette = false;
                    self.restore_focus(window, cx);
                }
                "up" => self.choice = self.choice.saturating_sub(1),
                "down" => {
                    self.choice = (self.choice + 1).min(self.commands().len().saturating_sub(1))
                }
                "enter" => {
                    if let Some(command) = self.commands().get(self.choice).cloned() {
                        self.execute(command, window, cx);
                    }
                }
                "backspace" => {
                    self.query.pop();
                    self.choice = 0;
                }
                _ => {
                    if !modifiers.control && !modifiers.platform && !modifiers.alt {
                        if let Some(text) = &event.keystroke.key_char {
                            self.query.push_str(text);
                            self.choice = 0;
                        }
                    }
                }
            }
        } else if modifiers.control && !modifiers.alt && !modifiers.platform && key == "tab" {
            self.capture(window, cx);
            self.projects_open = false;
            if let Some(saved) = self
                .state
                .selected
                .as_ref()
                .and_then(|w| self.state.workspaces.get_mut(w))
            {
                if !saved.tabs.is_empty() {
                    saved.active = (saved.active + 1) % saved.tabs.len();
                }
            }
            self.ensure(window, cx);
            self.restore_focus(window, cx);
            self.persist();
        } else if modifiers.control
            && !modifiers.alt
            && !modifiers.platform
            && !modifiers.shift
            && key == "w"
        {
            if let Some(tab) = self.active() {
                self.content.remove(&self.key(&tab));
                let saved = self
                    .state
                    .workspaces
                    .get_mut(self.state.selected.as_deref().unwrap_or(""))
                    .unwrap();
                if let Tab::Session(id) = &tab {
                    saved.selections.remove(id);
                }
                saved.tabs.remove(saved.active);
                saved.active = saved.active.min(saved.tabs.len().saturating_sub(1));
                self.ensure(window, cx);
                self.restore_focus(window, cx);
                self.persist();
            }
        } else {
            return;
        }
        self.revision += 1;
        cx.notify();
        cx.stop_propagation();
    }
    fn tick(&mut self, refresh: bool, window: &mut Window, cx: &mut Context<Self>) {
        let before = serde_json::to_vec(&self.state).unwrap();
        self.capture(window, cx);
        if before != serde_json::to_vec(&self.state).unwrap() {
            self.persist();
        }
        for content in self.content.values() {
            match content {
                Content::Brain(_) => {}
                Content::Issues(issues) => issues.update(cx, |s, cx| s.tick(refresh, cx)),
                Content::Session(s) => s.update(cx, |s, cx| s.shell_tick(refresh, cx)),
                Content::Grid(g) => g.update(cx, |g, cx| {
                    g.poll(cx);
                    if refresh {
                        g.load(cx);
                    }
                }),
                Content::Inbox(inbox) => inbox.update(cx, |inbox, cx| inbox.tick(cx)),
            }
        }
    }
}
#[path = "shell_view.rs"]
mod view;
pub use view::try_launch;

#[cfg(test)]
#[path = "shell_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "inbox_tests.rs"]
mod inbox_tests;

#[cfg(test)]
#[path = "issue_tests.rs"]
mod issue_tests;
