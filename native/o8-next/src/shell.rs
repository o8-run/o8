//! Opt-in shell. Uses only main's surfaces; unavailable surfaces stay explicit.
use crate::{
    client::{Client, Session},
    shell_state::{State, Workspace},
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
#[path = "surface_registry.rs"]
mod registry;
use registry::{
    EmptyState, NavPosition, Registration, ShellView, WorkspaceLoad, register_surfaces,
};

register_surfaces! {
    tabs {
        session: Session(String) = "surfaces/session.rs";
        brain: Brain = "surfaces/brain.rs";
        grid: Grid = "surfaces/grid.rs";
        inbox: Inbox = "surfaces/inbox.rs";
        issues: Issues = "surfaces/issues.rs";
        #[cfg(test)] fake: Fake = "surfaces/fake.rs";
    }
    commands {
        settings: Settings = "surfaces/settings.rs";
        projects: Projects = "surfaces/projects.rs";
        diff: Diff = "surfaces/diff.rs";
        terminal: Terminal = "surfaces/terminal.rs";
        customize: Customize = "surfaces/customize.rs";
        setup: Setup = "surfaces/setup.rs";
    }
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
    surfaces: SurfaceRuntime,
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
            surfaces: SurfaceRuntime::default(),
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
        let task = cx.background_executor().spawn(async move {
            let sessions = client.sessions()?;
            let mut load = WorkspaceLoad {
                paths: sessions
                    .iter()
                    .filter_map(|s| s.repo_path.clone())
                    .collect(),
                active_project: None,
            };
            for registration in registrations() {
                (registration.workspaces)(&client, &mut load);
            }
            Ok::<_, String>((sessions, load))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok((sessions, load)) => {
                        this.sessions = sessions;
                        this.workspaces = load.paths.into_iter().collect();
                        this.connected = true;
                        if let Some(active) = load.active_project {
                            if !this.state.selected.as_ref().is_some_and(|w| active.contains(w)) {
                                this.state.selected = active.first().cloned();
                            }
                        } else if !this.state.selected.as_ref().is_some_and(|w| this.workspaces.contains(w)) {
                            this.state.selected = this.workspaces.first().cloned();
                        }
                        this.notice = if this.workspaces.is_empty() { "Connected. No saved workspace sessions." } else { "Connected · Ctrl+K / Cmd+K: commands · Ctrl+Tab: next surface" }.into();
                        this.persist();
                        for registration in registrations() {
                            (registration.loaded)(this, cx);
                        }
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
            None if self.active().is_some_and(|tab| tab.registration().global) => String::new(),
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
        let Some(content) = (tab.registration().create)(self, tab, workspace, window, cx) else {
            return;
        };
        self.content.insert(key, content);
        self.restore_focus(window, cx);
    }
    fn restore_focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette {
            self.focus.focus(window);
            return;
        }
        if registrations()
            .iter()
            .any(|r| (r.focus_overlay)(self, window, cx))
        {
            return;
        }
        if let Some(content) = self
            .active()
            .and_then(|tab| self.content.get(&self.key(&tab)))
        {
            content.focus(self.current().is_some_and(|w| w.composer), window, cx);
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
        for registration in registrations() {
            (registration.after_tab)(self);
        }
        self.palette = false;
        self.ensure(window, cx);
        self.restore_focus(window, cx);
        self.persist();
        self.revision += 1;
        cx.notify();
    }
    fn capture(&mut self, window: &Window, cx: &App) {
        if self.palette || registrations().iter().any(|r| (r.overlay_open)(self)) {
            return;
        }
        for registration in registrations() {
            (registration.capture)(self, window, cx);
        }
    }
    fn commands(&self) -> Vec<Command> {
        let mut entries = registrations()
            .iter()
            .filter_map(|r| r.command)
            .collect::<Vec<_>>();
        entries.sort_by_key(|(order, _)| *order);
        let mut commands = entries
            .into_iter()
            .map(|(_, command)| command())
            .collect::<Vec<_>>();
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
        if registrations().iter().any(|r| !(r.allow_open)(self, cx)) {
            return;
        }
        let registration = command.registration();
        if registration.overlay_command {
            (registration.open)(self, command, window, cx);
            return;
        }
        for registration in registrations() {
            (registration.before_tab)(self);
        }
        let Some((tab, composer)) = (registration.open)(self, command, window, cx) else {
            return;
        };
        for registration in registrations() {
            (registration.after_tab)(self);
        }
        // An empty key stores the global Inbox before any workspace exists.
        if let Some(workspace) = self
            .state
            .selected
            .clone()
            .or_else(|| tab.registration().global.then(String::new))
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
    fn key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        if registrations()
            .iter()
            .any(|r| (r.key_down)(self, event, window, cx))
        {
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
                    if !modifiers.control
                        && !modifiers.platform
                        && !modifiers.alt
                        && let Some(text) = &event.keystroke.key_char
                    {
                        self.query.push_str(text);
                        self.choice = 0;
                    }
                }
            }
        } else if modifiers.control && !modifiers.alt && !modifiers.platform && key == "tab" {
            self.capture(window, cx);
            for registration in registrations() {
                (registration.after_tab)(self);
            }
            if let Some(saved) = self
                .state
                .selected
                .as_ref()
                .and_then(|w| self.state.workspaces.get_mut(w))
                && !saved.tabs.is_empty()
            {
                saved.active = (saved.active + 1) % saved.tabs.len();
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
                (tab.registration().remove)(saved, &tab);
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
            content.tick(refresh, cx);
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
#[path = "shell_test_support.rs"]
mod test_support;
