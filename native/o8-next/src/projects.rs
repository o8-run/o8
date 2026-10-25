//! Project and repository controls hosted by the opt-in shell.
use crate::projects_model::Action;
use crate::{client::Client, composer::Composer, projects_model::*};
use gpui::{prelude::*, *};
use std::{cell::Cell, rc::Rc};

pub struct Changed {
    pub workspace: Option<WorkspaceChange>,
    pub registered: Vec<String>,
    pub removed: Vec<String>,
}
pub struct Projects {
    client: Client,
    snapshot: Snapshot,
    loading: bool,
    busy: bool,
    error: Option<String>,
    detail: Option<String>,
    form: Option<Option<String>>,
    adding: bool,
    confirmation: Option<Action>,
    validation: Option<serde_json::Value>,
    search: Entity<Composer>,
    name: Entity<Composer>,
    slug: Entity<Composer>,
    description: Entity<Composer>,
    path: Entity<Composer>,
    revision: u64,
    pub painted: Rc<Cell<u64>>,
    _subscriptions: Vec<Subscription>,
}
impl EventEmitter<Changed> for Projects {}
impl Projects {
    pub fn new(client: Client, cx: &mut Context<Self>) -> Self {
        let search = cx.new(Composer::new);
        let name = cx.new(Composer::new);
        let slug = cx.new(Composer::new);
        let description = cx.new(Composer::new);
        let path = cx.new(Composer::new);
        let subscriptions = vec![
            cx.observe(&search, |_, _, cx| cx.notify()),
            cx.observe(&path, |this, _, cx| {
                this.validation = None;
                cx.notify();
            }),
        ];
        let mut view = Self {
            client,
            snapshot: Snapshot::default(),
            loading: false,
            busy: false,
            error: None,
            detail: None,
            form: None,
            adding: false,
            confirmation: None,
            validation: None,
            search,
            name,
            slug,
            description,
            path,
            revision: 0,
            painted: Rc::new(Cell::new(u64::MAX)),
            _subscriptions: subscriptions,
        };
        view.load(cx);
        view
    }
    pub(crate) fn load(&mut self, cx: &mut Context<Self>) {
        if self.loading || self.busy {
            return;
        }
        self.loading = true;
        self.error = None;
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { Snapshot::load(&client) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok(snapshot) => this.apply(snapshot, None, cx),
                    Err(error) => this.error = Some(error),
                }
                this.revision += 1;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn apply(
        &mut self,
        snapshot: Snapshot,
        workspace: Option<WorkspaceChange>,
        cx: &mut Context<Self>,
    ) {
        let removed = self
            .snapshot
            .repos
            .iter()
            .filter(|old| {
                !snapshot
                    .repos
                    .iter()
                    .any(|repo| repo.id == old.id && repo.local_path == old.local_path)
            })
            .map(|repo| repo.local_path.clone())
            .collect();
        let registered = snapshot
            .repos
            .iter()
            .map(|repo| repo.local_path.clone())
            .collect();
        self.snapshot = snapshot;
        if !self
            .snapshot
            .projects
            .iter()
            .any(|p| Some(&p.id) == self.detail.as_ref())
        {
            self.detail = None;
        }
        cx.emit(Changed {
            workspace,
            registered,
            removed,
        });
    }
    fn act(&mut self, action: Action, cx: &mut Context<Self>) {
        if self.busy || self.loading {
            return;
        }
        self.busy = true;
        self.error = None;
        let client = self.client.clone();
        let close_form = matches!(action, Action::Save { .. });
        let close_add = matches!(action, Action::Register(..));
        let task = cx
            .background_executor()
            .spawn(async move { action.run(&client) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(outcome) => {
                        this.validation = outcome.validation;
                        this.apply(outcome.snapshot, outcome.workspace, cx);
                        this.confirmation = None;
                        if close_form {
                            this.form = None;
                        }
                        if close_add {
                            this.adding = false;
                        }
                    }
                    Err(error) => this.error = Some(error),
                }
                this.revision += 1;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn edit(&mut self, project: Option<Project>, window: &mut Window, cx: &mut Context<Self>) {
        self.form = Some(project.as_ref().map(|p| p.id.clone()));
        for (input, value) in [
            (
                &self.name,
                project.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
            ),
            (
                &self.slug,
                project.as_ref().map(|p| p.slug.clone()).unwrap_or_default(),
            ),
            (
                &self.description,
                project
                    .as_ref()
                    .and_then(|p| p.description.clone())
                    .unwrap_or_default(),
            ),
        ] {
            input.update(cx, |input, cx| {
                input.clear(cx);
                input.text = value;
                cx.notify();
            });
        }
        self.name.read(cx).focus.focus(window);
        cx.notify();
    }
    fn save(&mut self, cx: &mut Context<Self>) {
        self.act(
            Action::Save {
                id: self.form.clone().flatten(),
                name: self.name.read(cx).text.clone(),
                slug: self.slug.read(cx).text.clone(),
                description: self.description.read(cx).text.clone(),
            },
            cx,
        );
    }
    #[cfg(test)]
    pub(crate) fn pending(&self) -> bool {
        self.loading || self.busy
    }
    #[cfg(test)]
    pub(crate) fn frame_ready(&self) -> bool {
        !self.pending() && self.painted.get() == self.revision
    }
    #[cfg(test)]
    pub(crate) fn error_message(&self) -> Option<&str> {
        self.error.as_deref()
    }
}
#[path = "projects_view.rs"]
mod view;
