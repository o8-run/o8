//! Opt-in shell. Uses only main's surfaces; unavailable surfaces stay explicit.
use crate::{
    client::{Client, Session},
    pane_grid::Grid,
    pane_layout,
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
    Session(String),
    Grid,
    Message(String),
    Diff,
    Terminal,
}
impl Command {
    fn label(&self, sessions: &[Session]) -> String {
        match self {
            Self::Session(id) => format!(
                "Open session: {}",
                sessions
                    .iter()
                    .find(|s| &s.id == id)
                    .map(|s| s.title.as_str())
                    .unwrap_or("Unavailable")
            ),
            Self::Grid => "Open grid".into(),
            Self::Message(_) => "New message in selected session".into(),
            Self::Diff => "Open diff for a packet".into(),
            Self::Terminal => "Open terminal".into(),
        }
    }
}
enum Content {
    Session(Entity<Surface>),
    Grid(Entity<Grid>),
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
    customize: Option<Entity<crate::customize::Customize>>,
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
            customize: None,
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
    fn load(&mut self, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        self.loading = true;
        self.notice = "Connecting to local o8 server…".into();
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.sessions() });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok(sessions) => {
                        this.sessions = sessions;
                        this.workspaces = this.sessions.iter().filter_map(|s| s.repo_path.clone()).collect::<BTreeSet<_>>().into_iter().collect();
                        this.connected = true;
                        if !this.state.selected.as_ref().is_some_and(|w| this.workspaces.contains(w)) {
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
            .selected
            .as_ref()
            .and_then(|w| self.state.workspaces.get(w))
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
        let Some(workspace) = self.state.selected.clone() else {
            return;
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
            Tab::Session(id) => {
                let id = self
                    .current()
                    .and_then(|w| w.selections.get(&id))
                    .cloned()
                    .unwrap_or(id);
                let sessions = self.workspace_sessions();
                if !sessions.iter().any(|s| s.id == id) {
                    return;
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
        if self.palette {
            self.focus.focus(window);
            return;
        }
        if let Some(tab) = self.active() {
            match self.content.get(&self.key(&tab)) {
                Some(Content::Session(session)) => session.read(cx).shell_focus(
                    self.current().is_some_and(|w| w.composer),
                    window,
                    cx,
                ),
                // Grid reestablishes its own keyboard focus when opened or clicked.
                Some(Content::Grid(grid)) => grid.update(cx, |g, cx| g.shell_focus(window, cx)),
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
        self.palette = false;
        self.ensure(window, cx);
        self.restore_focus(window, cx);
        self.persist();
        self.revision += 1;
        cx.notify();
    }
    fn capture(&mut self, window: &Window, cx: &App) {
        if self.palette {
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
        let mut commands = vec![Command::Grid, Command::Diff, Command::Terminal];
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
        let (tab, composer) = match command {
            Command::Session(id) => (Tab::Session(id), false),
            Command::Message(id) => (Tab::Session(id), true),
            Command::Grid => (Tab::Grid, false),
            Command::Diff | Command::Terminal => {
                self.notice = "This surface is not available in this build. The terminal and packet diff changes must land before the shell can open them.".into();
                self.palette = false;
                self.restore_focus(window, cx);
                cx.notify();
                return;
            }
        };
        if let Some(workspace) = self.state.selected.as_ref() {
            let saved = self.state.workspaces.entry(workspace.clone()).or_default();
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
    fn key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.customize.is_some() {
            return;
        }
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        if (modifiers.control || modifiers.platform) && key == "k" {
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
                    .get_mut(self.state.selected.as_ref().unwrap())
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
                Content::Session(s) => s.update(cx, |s, cx| s.shell_tick(refresh, cx)),
                Content::Grid(g) => g.update(cx, |g, cx| {
                    g.poll(cx);
                    if refresh {
                        g.load(cx);
                    }
                }),
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
