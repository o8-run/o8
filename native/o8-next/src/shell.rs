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

// The parent waits only for the first paint of the open window. This channel
// carries only fixed control signals, never diagnostics or credentials.
fn report_startup() {
    use std::{
        io::Write,
        sync::atomic::{AtomicBool, Ordering},
    };
    static REPORTED: AtomicBool = AtomicBool::new(false);
    if std::env::var("O8_NEXT_PARENT_PIPE").as_deref() != Ok("1")
        || REPORTED.swap(true, Ordering::SeqCst)
    {
        return;
    }
    let mut output = std::io::stdout().lock();
    let _ = output
        .write_all(b"o8-next-ready\n")
        .and_then(|_| output.flush());
}

pub const HELP: &str = "App shell: --app-shell --shell-state ABSOLUTE_FILE --server ORIGIN [--offscreen]. The o8 next launcher resolves existing local configuration.";
#[path = "surface_registry.rs"]
mod registry;
use registry::{
    EmptyState, NavPosition, Registration, ShellView, WorkspaceLoad, github_item, register_surfaces,
};

register_surfaces! {
    tabs {
        session: Session(String) = "surfaces/session.rs";
        brain: Brain = "surfaces/brain.rs";
        grid: Grid = "surfaces/grid.rs";
        activity: Activity = "surfaces/activity.rs";
        workers: Workers = "surfaces/workers.rs";
        pull_requests: PullRequests = "surfaces/pull_requests.rs";
        bots: Bot(String) = "surfaces/bots.rs";
        inbox: Inbox = "surfaces/inbox.rs";
        issues: Issues = "surfaces/issues.rs";
        diff: Diff = "surfaces/diff.rs";
        terminal: Terminal = "surfaces/terminal.rs";
        scheduled: Scheduled = "surfaces/scheduled.rs";
        usage: Usage = "surfaces/usage.rs";
        #[cfg(test)] fake: Fake = "surfaces/fake.rs";
    }
    commands {
        shortcuts: ShortcutReference = "surfaces/shortcuts.rs";
        sidebar: Sidebar = "surfaces/sidebar.rs";
        settings: Settings = "surfaces/settings.rs";
        projects: Projects = "surfaces/projects.rs";
        customize: Customize = "surfaces/customize.rs";
        setup: Setup = "surfaces/setup.rs";
        palette: Palette = "surfaces/palette.rs";
    }
}

#[path = "shell_features.rs"]
mod features;
pub(crate) use features::toasts_api as toasts;

pub struct Shell {
    features: features::State,
    system_glass: bool,
    /// A window drawn without being shown keeps an opaque root.
    offscreen: bool,
    chrome: crate::render_region::Regions<Shell>,
    client: Client,
    file: PathBuf,
    state: State,
    sessions: Vec<Session>,
    workspaces: Vec<String>,
    /// Tunnels to saved machines, shared with the sidebar.
    links: crate::shell::settings::machine_links::Links,
    content: HashMap<String, Content>,
    focus: FocusHandle,
    palette: bool,
    workspace_picker: bool,
    shortcuts: bool,
    query: String,
    choice: usize,
    palette_scroll: gpui::ScrollHandle,
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
        mut state: State,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        // No tunnel is up yet at launch, so a far machine can't be the first
        // thing this window shows.
        if state
            .selected
            .as_deref()
            .is_some_and(|workspace| session::machine_workspace(workspace).is_some())
        {
            state.selected = state.local_selected.clone();
        }
        let focus = cx.focus_handle();
        focus.focus(window);
        let mut shell = Self {
            features: features::State::default(),
            system_glass: false,
            offscreen: false,
            chrome: crate::render_region::Regions::default(),
            client,
            file,
            state,
            sessions: vec![],
            workspaces: vec![],
            links: Default::default(),
            content: HashMap::new(),
            focus,
            palette: false,
            workspace_picker: false,
            shortcuts: false,
            query: String::new(),
            choice: 0,
            palette_scroll: gpui::ScrollHandle::new(),
            notice: "Connecting to local o8 server…".into(),
            loading: false,
            connected: false,
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            subscriptions: vec![],
            surfaces: SurfaceRuntime::default(),
        };
        features::observe(&mut shell, window, cx);
        shell.load(cx);
        shell
    }
    fn persist(&mut self) {
        if let Some(local) = self
            .state
            .selected
            .as_deref()
            .filter(|workspace| session::machine_workspace(workspace).is_none())
        {
            self.state.local_selected = Some(local.to_owned());
        }
        features::persist_window_state(self);
    }
    fn load(&mut self, cx: &mut Context<Self>) {
        if registry::extensions().any(|extension| extension.load(self, cx)) {
            return;
        }
        if registrations().iter().any(|r| (r.load)(self, cx)) {
            return;
        }
        if self.loading {
            return;
        }
        self.loading = true;
        // Background refreshes run on every stream wakeup; only the first connect is announced.
        if !self.connected {
            self.notice = "Connecting to local o8 server…".into();
        }
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let sessions = client.sessions()?;
            let mut load = WorkspaceLoad {
                paths: sessions
                    .iter()
                    .filter_map(|s| s.repo_path.clone())
                    .collect(),
                active_project: None,
                active_project_id: None,
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
                        this.settings_project(load.active_project_id.clone(), cx);
                        this.sessions = sessions;
                        this.workspaces = load.paths.into_iter().collect();
                        this.connected = true;
                        // Home stays selected: it belongs to no project.
                        let home = this.state.selected.as_deref().is_some_and(session::is_home);
                        if let Some(active) = load.active_project.filter(|_| !home) {
                            if !this.state.selected.as_ref().is_some_and(|w| active.contains(w)) {
                                this.state.selected = active.first().cloned();
                            }
                        } else if !home && !this.state.selected.as_ref().is_some_and(|w| this.workspaces.contains(w)) {
                            this.state.selected = this.workspaces.first().cloned();
                        }
                        this.notice.clear();
                        this.persist();
                    }
                    // A busy server keeps the shell connected; a hung one is down.
                    Err(error)
                        if this.connected
                            && crate::client::transient(&error)
                            && !error.ends_with("Request timed out") =>
                    {
                        this.notice = crate::client::stale_notice(&error);
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
            .filter(|s| Some(s.workspace().as_str()) == self.state.selected.as_deref())
            .cloned()
            .collect()
    }
    /// The client a workspace's surfaces use. A machine's workspace has none
    /// while its tunnel is down.
    fn workspace_client(&self, workspace: &str) -> Option<Client> {
        match session::machine_workspace(workspace) {
            Some((machine, repo)) => Some(self.links.client(machine)?.in_workspace(repo)),
            None => Some(self.client.in_workspace(workspace)),
        }
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
    /// The name of the machine holding a sidebar thread, while it can't be
    /// reached.
    fn unreachable_machine(&self, id: &str) -> Option<String> {
        let (machine, _) = session::machine_thread(id)?;
        self.links.client(machine).is_none().then(|| {
            let label = self
                .sessions
                .iter()
                .find(|s| s.list_id() == id)
                .and_then(|s| s.machine_label.as_deref())
                .unwrap_or("That machine");
            label.split(" · ").next().unwrap_or(label).to_owned()
        })
    }

    /// A panel's client. A far machine's panel never falls back to this
    /// computer's data: while it's offline the client can only fail, and the
    /// panel shows its normal error.
    pub(crate) fn panel_client(&self, workspace: &str) -> Client {
        match session::machine_workspace(workspace) {
            Some((machine, repo)) => self.links.client_or_offline(machine).in_workspace(repo),
            None => self.client.in_workspace(workspace),
        }
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
        if !registry::extensions().all(|extension| extension.allow_switch(self))
            || !(self.workspaces.contains(&workspace) || session::is_home(&workspace))
        {
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
        if self.palette
            || registrations().iter().any(|r| (r.overlay_open)(self))
            || registry::extensions().any(|extension| extension.capture_blocked(self))
        {
            return;
        }
        for registration in registrations() {
            (registration.capture)(self, window, cx);
        }
    }
    fn commands(&self) -> Vec<palette::Entry> {
        palette::entries(self)
    }
    fn surface_commands(&self) -> Vec<Command> {
        features::commands(self)
            .into_iter()
            .filter(|command| {
                registry::extensions().all(|extension| extension.allow_command(self, command))
                    && command
                        .label(&self.sessions)
                        .to_lowercase()
                        .contains(&self.query.to_lowercase())
            })
            .collect()
    }
    /// Opens a registered surface by its tab label, for callers that must keep
    /// compiling when that registration is removed. False when it is absent.
    pub(super) fn open_registered(
        &mut self,
        tab_label: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let command = registrations()
            .iter()
            .find(|registration| registration.tab_label == tab_label)
            .and_then(|registration| registration.command)
            .map(|(_, command)| command());
        command.is_some_and(|command| {
            self.execute(command, window, cx);
            true
        })
    }
    /// Opens a GitHub link in the surface that claims it, else in the browser.
    pub(super) fn open_link(&mut self, url: &str, window: &mut Window, cx: &mut Context<Self>) {
        if !registrations()
            .iter()
            .any(|registration| (registration.claim_link)(self, url, window, cx))
        {
            cx.open_url(url);
        }
    }
    /// Threads open in place, issues and pull requests open beside the chat, and
    /// other web links leave o8.
    pub(super) fn open_transcript_link(
        &mut self,
        url: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A sent mention's pill opens its thread or agent the same way.
        let mention = crate::composer::mention::groups::sent_link(url);
        let url = mention.as_deref().unwrap_or(url);
        if let Some(id) = crate::lineage::parse_link(url) {
            self.open_thread_by_id(id.to_owned(), window, cx);
        } else if let Some(number) = url.strip_prefix('#').and_then(|n| n.parse().ok()) {
            self.open_issue_in_panel(None, number, window, cx);
        } else if let Some((repo, number)) = github_item(url, "issues") {
            self.open_issue_in_panel(Some(repo), number, window, cx);
        } else if let Some((repo, number)) = github_item(url, "pull") {
            self.open_pr_in_panel(repo, number, window, cx);
        } else if url.starts_with("https://") || url.starts_with("http://") {
            cx.open_url(url);
        } else if let Some(path) = url.strip_prefix("o8-change:") {
            self.open_change_link(path.to_owned(), window, cx);
        } else if let Some(repo) = url.strip_prefix("o8-new-thread:") {
            // An empty chat's project bar: start (or reuse) the empty chat in
            // that project, as the sidebar's New thread menu does. Only a
            // registered project, since a transcript link can name any path.
            if let Some(list) = self.surfaces.sidebar.view.clone()
                && (self.workspaces.iter().any(|w| w == repo) || list.read(cx).knows_repo(repo))
            {
                let repo = repo.to_owned();
                list.update(cx, |list, cx| list.new_thread(repo, cx));
            }
        } else if let Some((path, line)) = crate::text::file_ref(url.trim_start_matches("file:")) {
            self.open_file_link(path.to_owned(), line, window, cx);
        }
    }
    fn execute(&mut self, command: Command, window: &mut Window, cx: &mut Context<Self>) {
        if !registry::extensions().all(|extension| extension.allow_command(self, &command)) {
            return;
        }
        if features::execute(self, &command, window, cx) {
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
                toasts::show(
                    toasts::Kind::Info,
                    "Close a surface before opening another.",
                    vec![],
                    Some(toasts::NOTICE_TIMEOUT),
                    cx,
                );
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
        // Shortcut overrides route first; handlers then see default chords.
        let translated = match shortcuts::pre_key(self, event, window, cx) {
            shortcuts::Pre::Pass => None,
            shortcuts::Pre::Translate(event) => Some(event),
            shortcuts::Pre::Release => return,
            shortcuts::Pre::Handled => {
                self.revision += 1;
                cx.notify();
                cx.stop_propagation();
                return;
            }
        };
        let event = translated.as_ref().unwrap_or(event);
        if features::key(self, event, window, cx) == registry::KeyResult::Handled {
            self.revision += 1;
            cx.notify();
            cx.stop_propagation();
        }
    }
    fn tick(&mut self, refresh: bool, window: &mut Window, cx: &mut Context<Self>) {
        features::tick(self, refresh, window, cx);
    }
}
#[path = "shell_material.rs"]
mod material;
#[path = "shell_rail.rs"]
mod rail;
#[path = "shell_view.rs"]
mod view;
pub use view::try_launch;

#[cfg(test)]
#[path = "shell_window_tests.rs"]
mod window_tests;

#[cfg(test)]
#[path = "shell_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "shell_test_support.rs"]
pub(crate) mod test_support;

#[cfg(test)]
#[path = "shell_feature_tests.rs"]
mod feature_tests;

#[cfg(test)]
#[path = "startup_tests.rs"]
mod startup_tests;

// UI tests use the production shell without exposing its private view type.
#[cfg(test)]
pub(crate) fn notes_test_window(
    client: Client,
    file: PathBuf,
    state: State,
    cx: &mut gpui::App,
) -> gpui::AnyWindowHandle {
    view::open_window(client, file, state, true, cx).into()
}
