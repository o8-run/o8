use super::*;
use crate::{
    projects::{Changed, Projects},
    projects_model::{Ledger, WorkspaceChange},
};
pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    pub view: Option<Entity<Projects>>,
    pub open: bool,
}
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((2, || Command::Projects)),
    overlay_command: true,
    overlay: |s| {
        if s.surfaces.projects.open {
            s.surfaces
                .projects
                .view
                .as_ref()
                .map(|v| v.clone().into_any_element())
        } else {
            None
        }
    },
    overlay_open: |s| s.surfaces.projects.open,
    block_ensure: |s| s.surfaces.projects.open,
    focus_overlay: |s, window, _| {
        if s.surfaces.projects.open {
            s.focus.focus(window);
            true
        } else {
            false
        }
    },
    after_tab: |s| s.surfaces.projects.open = false,
    workspaces: |client, load| {
        // Older fixture modes only expose session routes.
        if let Ok(ledger) = client.get::<Ledger>("/api/panel/projects", &[]) {
            load.paths
                .extend(ledger.projects.iter().flat_map(|p| p.repo_paths.clone()));
            load.active_project = ledger
                .projects
                .iter()
                .find(|p| p.id == ledger.active_project_id && p.id != "default")
                .map(|p| p.repo_paths.clone());
        }
    },
    nav: |s, position, cx| {
        if position != NavPosition::BeforeWorkspaces {
            return vec![];
        }
        let mut nav = vec![
            div()
                .id("shell-projects")
                .debug_selector(|| "shell-projects".into())
                .cursor_pointer()
                .p(px(6.))
                .child("Projects")
                .on_click(cx.listener(|this, _, window, cx| this.open_projects(window, cx)))
                .into_any_element(),
        ];
        if s.surfaces.projects.open {
            nav.push(
                div()
                    .id("shell-workspace")
                    .debug_selector(|| "shell-workspace".into())
                    .cursor_pointer()
                    .p(px(6.))
                    .child("Back to workspace")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.surfaces.projects.open = false;
                        this.restore_focus(window, cx);
                        cx.notify();
                    }))
                    .into_any_element(),
            );
        }
        nav
    },
    ..Registration::new("", "Open projects and repositories", |s, _, window, cx| {
        s.open_projects(window, cx);
        None
    })
};
impl Shell {
    fn open_projects(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.capture(window, cx);
        self.surfaces.settings.view = None;
        self.surfaces.settings.subscription = None;
        if self.surfaces.projects.view.is_none() {
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
                            this.surfaces.projects.open = false;
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
            self.surfaces.projects.view = Some(projects);
        } else if let Some(projects) = &self.surfaces.projects.view {
            projects.update(cx, |view, cx| view.load(cx));
        }
        self.surfaces.projects.open = true;
        self.palette = false;
        self.focus.focus(window);
        cx.notify();
    }
}

#[cfg(test)]
#[path = "../projects_tests.rs"]
mod tests;
