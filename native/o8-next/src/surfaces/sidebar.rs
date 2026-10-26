//! Persistent workspace rail. Owns its lifecycle, layout, navigation and fixtures.
use super::*;
use crate::projects_model::Ledger;
#[path = "sidebar/thread_list.rs"]
mod thread_list;
#[path = "sidebar/thread_list_client.rs"]
mod thread_list_client;
use thread_list::{Event as ThreadEvent, ThreadList};
pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    pub view: Option<Entity<ThreadList>>,
    workspace_ledger: Option<Ledger>,
}
pub(super) const REGISTRATION: Registration = Registration {
    initialize,
    overlay_command: true,
    load: |shell, cx| {
        if !shell.loading {
            shell.loading = true;
            shell.notice = "Connecting to local o8 server…".into();
            shell
                .surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .update(cx, |sidebar, cx| sidebar.load(cx));
            cx.notify();
        }
        true
    },
    tick: |shell, window, cx| {
        let selected = shell
            .active()
            .and_then(|tab| shell.content.get(&shell.key(&tab)))
            .and_then(|content| match content {
                Content::Session(surface) => surface.read(cx).shell_selection(window, cx).0,
                _ => None,
            });
        shell
            .surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .update(cx, |sidebar, cx| {
                if let Some(id) = selected {
                    sidebar.sync_selection(id, cx);
                }
                sidebar.tick(cx);
            });
    },
    decorate: |shell, content| {
        div()
            .flex()
            .flex_1()
            .min_h_0()
            .child(
                gpui::AnyView::from(shell.surfaces.sidebar.view.as_ref().unwrap().clone()).cached(
                    gpui::StyleRefinement::default()
                        .w(px(280.))
                        .h_full()
                        .flex_shrink_0(),
                ),
            )
            .child(div().flex().flex_col().flex_1().min_w_0().child(content))
            .into_any_element()
    },
    key_down: |shell, event, window, cx| {
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        let search = shell.surfaces.settings.view.is_none()
            && (modifiers.control || modifiers.platform)
            && key == "f";
        if search || key == "f8" {
            if search {
                shell
                    .surfaces
                    .sidebar
                    .view
                    .as_ref()
                    .unwrap()
                    .update(cx, |sidebar, cx| sidebar.search(window, cx));
            } else {
                shell.execute(Command::Sidebar, window, cx);
            }
            true
        } else {
            false
        }
    },
    catalog_changed: |shell, cx| {
        if let Some(projects) = &shell.surfaces.projects.view {
            shell.surfaces.sidebar.workspace_ledger = Some(projects.read(cx).workspace_ledger());
            shell
                .surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .update(cx, |sidebar, _| sidebar.catalog_changed());
        }
    },
    ..Registration::new("", "", |shell, _, window, cx| {
        shell
            .surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .update(cx, |sidebar, cx| sidebar.focus(window, cx));
        None
    })
};
fn initialize(shell: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    let sidebar = cx.new(|cx| ThreadList::new(shell.client.clone(), cx));
    shell.subscriptions.push(
        cx.subscribe_in(&sidebar, window, |shell, _, event, window, cx| {
            match event {
                ThreadEvent::Loaded(sessions) => {
                    shell.install_sessions(sessions.clone(), false, cx)
                }
                ThreadEvent::Refreshed(sessions, ledger) => {
                    shell.surfaces.sidebar.workspace_ledger = ledger.clone();
                    shell.install_sessions(sessions.clone(), true, cx);
                }
                ThreadEvent::Selected(id) => shell.open_thread(id.clone(), window, cx),
                ThreadEvent::Error(error) => {
                    shell.loading = false;
                    shell.connected = false;
                    shell.notice = format!(
                        "Local server unavailable: {error}. Start the local o8 server, then Retry."
                    );
                }
            }
            cx.notify();
        }),
    );
    shell.surfaces.sidebar.view = Some(sidebar);
}
impl Shell {
    fn install_sessions(
        &mut self,
        sessions: Vec<Session>,
        refreshed: bool,
        cx: &mut Context<Self>,
    ) {
        let bootstrap = self.loading || !self.connected;
        self.sessions = sessions;
        let mut workspaces = self
            .sessions
            .iter()
            .map(|s| s.repo_path.clone().unwrap_or_else(|| "Unassigned".into()))
            .collect::<BTreeSet<_>>();
        if let Some(ledger) = &self.surfaces.sidebar.workspace_ledger {
            workspaces.extend(ledger.projects.iter().flat_map(|p| p.repo_paths.clone()));
        }
        self.workspaces = workspaces.into_iter().collect();
        if refreshed {
            self.loading = false;
            self.connected = true;
            let missing = self
                .state
                .selected
                .as_ref()
                .is_some_and(|w| !self.workspaces.contains(w));
            if bootstrap || missing {
                let active = self
                    .surfaces
                    .sidebar
                    .workspace_ledger
                    .as_ref()
                    .and_then(|ledger| {
                        ledger
                            .projects
                            .iter()
                            .find(|p| p.id == ledger.active_project_id && p.id != "default")
                    });
                if let Some(active) = active {
                    if !self
                        .state
                        .selected
                        .as_ref()
                        .is_some_and(|w| active.repo_paths.contains(w))
                    {
                        self.state.selected = active.repo_paths.first().cloned();
                    }
                } else if !self
                    .state
                    .selected
                    .as_ref()
                    .is_some_and(|w| self.workspaces.contains(w))
                {
                    self.state.selected = self.workspaces.first().cloned();
                }
            }
        }
        if self.connected {
            self.notice.clear();
        }
        for content in self.content.values() {
            if let Content::Grid(grid) = content {
                grid.update(cx, |g, cx| g.load(cx));
            }
        }
        self.persist();
    }
    fn open_thread(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(workspace) = self
            .sessions
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.repo_path.clone().unwrap_or_else(|| "Unassigned".into()))
        else {
            return;
        };
        self.surfaces.projects.open = false;
        self.surfaces.settings.view = None;
        self.surfaces.settings.subscription = None;
        if self.state.selected.as_ref() != Some(&workspace) {
            self.switch(workspace, window, cx);
        }
        if let Some(Tab::Session(original)) = self.active() {
            let key = self.key(&Tab::Session(original.clone()));
            let sessions = self.workspace_sessions();
            if let Some(Content::Session(surface)) = self.content.get(&key) {
                surface.update(cx, |s, cx| s.shell_select(sessions, id.clone(), cx));
                self.state
                    .workspaces
                    .get_mut(self.state.selected.as_ref().unwrap())
                    .unwrap()
                    .selections
                    .insert(original, id);
                self.persist();
                cx.notify();
                return;
            }
        }
        self.execute(Command::Session(id), window, cx);
    }
}
#[cfg(test)]
#[path = "sidebar/sidebar_tests.rs"]
mod tests;
