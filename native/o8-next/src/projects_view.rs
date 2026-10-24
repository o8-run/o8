use super::*;
use crate::theme::current as theme;

fn control(
    selector: impl Into<String>,
    label: impl Into<SharedString>,
    enabled: bool,
) -> Stateful<Div> {
    let selector = selector.into();
    div()
        .id(ElementId::Name(selector.clone().into()))
        .debug_selector(move || selector.clone())
        .px(px(8.))
        .py(px(5.))
        .rounded(px(6.))
        .bg(theme().surface_raised)
        .text_color(if enabled {
            theme().text
        } else {
            theme().text_muted
        })
        .when(enabled, |view| view.cursor_pointer())
        .child(label.into())
}
fn field(selector: &'static str, label: &'static str, input: Entity<Composer>) -> Stateful<Div> {
    div()
        .id(selector)
        .debug_selector(move || selector.into())
        .mb(px(8.))
        .child(div().text_color(theme().text_muted).child(label))
        .child(input)
}
impl Projects {
    fn action(
        &self,
        selector: impl Into<String>,
        label: impl Into<SharedString>,
        action: Action,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        control(selector, label, !self.busy && !self.loading)
            .on_click(cx.listener(move |this, _, _, cx| this.act(action.clone(), cx)))
    }
    fn card(&self, project: Project, cx: &mut Context<Self>) -> AnyElement {
        let enabled = !self.busy && !self.loading && self.form.is_none();
        let id = project.id.clone();
        let detail_id = id.clone();
        let edit = project.clone();
        let delete = self.snapshot.ledger_id(&project).to_owned();
        let workspace = self.snapshot.workspace(&project).cloned();
        let open_id = self.snapshot.ledger_id(&project).to_owned();
        let open_enabled = enabled && workspace.as_ref().is_some_and(|r| r.exists);
        let members = project.repos.clone();
        let detail = self.detail.as_ref() == Some(&id);
        div()
            .p(px(10.))
            .mb(px(8.))
            .border_1()
            .border_color(theme().border)
            .rounded(px(8.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div().flex_1().child(project.name.clone()).child(
                            div()
                                .text_size(px(11.))
                                .text_color(theme().text_muted)
                                .child(format!(
                                    "{} · {} repositories",
                                    project.slug,
                                    members.len()
                                )),
                        ),
                    )
                    .child(
                        control(
                            format!("project-details-{}", project.slug),
                            "Details",
                            enabled,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if enabled {
                                this.detail = Some(detail_id.clone());
                                cx.notify();
                            }
                        })),
                    )
                    .child(self.action(
                        format!("project-activate-{}", project.slug),
                        if self.snapshot.ledger.active_project_id
                            == self.snapshot.ledger_id(&project)
                        {
                            "Active project"
                        } else {
                            "Switch project"
                        },
                        Action::Activate(self.snapshot.ledger_id(&project).to_owned()),
                        cx,
                    ))
                    .child(
                        control(
                            format!("project-open-{}", project.slug),
                            "Open workspace",
                            open_enabled,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if open_enabled {
                                this.act(
                                    Action::Open(
                                        open_id.clone(),
                                        workspace.as_ref().unwrap().local_path.clone(),
                                    ),
                                    cx,
                                );
                            }
                        })),
                    )
                    .child(
                        control(format!("project-edit-{}", project.slug), "Edit", enabled)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                if enabled {
                                    this.edit(Some(edit.clone()), window, cx);
                                }
                            })),
                    )
                    .child(
                        control(
                            format!("project-delete-{}", project.slug),
                            "Delete",
                            enabled,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if enabled {
                                this.confirmation = Some(Action::Delete(delete.clone()));
                                cx.notify();
                            }
                        })),
                    ),
            )
            .when(detail, |view| {
                view.child(
                    div()
                        .my(px(8.))
                        .text_color(theme().text_muted)
                        .child(project.description.clone().unwrap_or_default()),
                )
                .children(
                    self.snapshot
                        .repos
                        .iter()
                        .cloned()
                        .enumerate()
                        .map(|(r, repo)| {
                            let member = members.iter().find(|m| m.repo_id == repo.id);
                            let row = div()
                                .flex()
                                .gap(px(8.))
                                .items_center()
                                .py(px(5.))
                                .child(div().flex_1().child(repo.name.clone()));
                            if let Some(member) = member {
                                let role = member.role.as_deref().unwrap_or("");
                                let next = (ROLES.iter().position(|r| *r == role).unwrap_or(0) + 1)
                                    % ROLES.len();
                                row.child(self.action(
                                    format!("project-role-{r}"),
                                    format!(
                                        "Role: {}",
                                        if role.is_empty() { "none" } else { role }
                                    ),
                                    Action::Role(
                                        id.clone(),
                                        repo.id.clone(),
                                        (!ROLES[next].is_empty()).then(|| ROLES[next].into()),
                                    ),
                                    cx,
                                ))
                                .child(self.action(
                                    format!("project-main-{r}"),
                                    if project.main_repo_id.as_ref() == Some(&repo.id) {
                                        "Main repository"
                                    } else {
                                        "Set main"
                                    },
                                    Action::Main(id.clone(), repo.id.clone()),
                                    cx,
                                ))
                                .child(self.action(
                                    format!("project-unlink-{r}"),
                                    "Remove from project",
                                    Action::Unlink(id.clone(), repo.id),
                                    cx,
                                ))
                            } else {
                                row.child(self.action(
                                    format!("project-link-{r}"),
                                    "Add to project",
                                    Action::Link(id.clone(), repo.id),
                                    cx,
                                ))
                            }
                        }),
                )
                .when(self.snapshot.repos.is_empty(), |view| {
                    view.child("No repositories connected. Add a repository below.")
                })
            })
            .into_any_element()
    }
}
impl Render for Projects {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let enabled = !self.busy && !self.loading;
        let query = self.search.read(cx).text.to_lowercase();
        let visible: Vec<_> = self
            .snapshot
            .projects
            .iter()
            .cloned()
            .enumerate()
            .filter(|(_, p)| {
                self.detail.as_ref().is_none_or(|id| id == &p.id)
                    && format!("{} {}", p.name, p.description.as_deref().unwrap_or(""))
                        .to_lowercase()
                        .contains(&query)
            })
            .collect();
        let first_run = self.snapshot.repos.is_empty()
            && self
                .snapshot
                .projects
                .iter()
                .all(|p| p.slug == "workspace" && p.repos.is_empty());
        let painted = self.painted.clone();
        let revision = self.revision;
        div().id("projects-surface").size_full().overflow_y_scroll().p(px(20.))
            .bg(theme().background).text_color(theme().text).font_family(theme().font_ui).text_size(px(13.))
            .child(div().flex().items_center().gap(px(12.)).mb(px(12.))
                .child(div().flex_1().text_size(px(18.)).child("Projects"))
                .child(control("project-new", "New project", enabled && self.form.is_none()).on_click(cx.listener(move |this, _, window, cx| {
                    if enabled && this.form.is_none() { this.edit(None, window, cx); }
                })))
                .child(control("projects-refresh", "Refresh", enabled).on_click(cx.listener(|this, _, _, cx| this.load(cx)))))
            .child(div().text_color(theme().text_muted).mb(px(12.)).child("Group repositories and shared instructions for your project."))
            .when(self.loading || self.busy, |view| view.child(div().debug_selector(|| "projects-loading".into())
                .mb(px(10.)).child(if self.loading { "Loading…" } else { "Saving…" })))
            .when_some(self.error.clone(), |view, error| view.child(div().debug_selector(|| "projects-error".into())
                .mb(px(10.)).text_color(theme().warning).child(error)))
            .when(!self.loading && self.error.is_none() && first_run, |view| view.child(div().debug_selector(|| "projects-empty".into())
                .mb(px(12.)).child("No projects yet. Create a project, then connect a repository to get started.")))
            .when(self.form.is_none(), |view| view.child(field("projects-search", "Search projects", self.search.clone())))
            .when(self.detail.is_some(), |view| view.child(control("projects-all", "All projects", enabled)
                .on_click(cx.listener(move |this, _, _, cx| { if enabled { this.detail = None; cx.notify(); } }))))
            .when(self.form.is_some(), |view| view.child(div().mb(px(12.))
                .child(field("project-name", "Project name", self.name.clone()))
                .when(self.form == Some(None), |view| view.child(field("project-slug", "Slug (optional; generated from name)", self.slug.clone())))
                .child(field("project-description", "Description", self.description.clone()))
                .child(div().flex().gap(px(8.))
                    .child(control("project-save", "Save project", enabled).on_click(cx.listener(|this, _, _, cx| this.save(cx))))
                    .child(control("project-cancel", "Cancel", enabled).on_click(cx.listener(move |this, _, _, cx| {
                        if enabled { this.form = None; cx.notify(); }
                    }))))))
            .when(self.form.is_none(), |view| view.children(visible.iter().map(|(_, p)| self.card(p.clone(), cx))))
            .when(!self.loading && self.error.is_none() && !first_run && visible.is_empty() && self.form.is_none(), |view| view.child(div()
                .debug_selector(|| "projects-no-match".into()).child("No projects match your search.")))
            .child(div().flex().gap(px(8.)).items_center().my(px(12.))
                .child(div().flex_1().child("Repositories"))
                .child(control("repo-add", "Add repository", enabled).on_click(cx.listener(move |this, _, window, cx| {
                    if enabled { this.adding = true; this.validation = None; this.path.read(cx).focus.focus(window); cx.notify(); }
                }))))
            .when(!self.loading && self.error.is_none() && self.snapshot.repos.is_empty(), |view| view.child(div()
                .debug_selector(|| "repositories-empty".into()).mb(px(8.)).child("No repositories connected. Use an existing local Git folder.")))
            .when(self.adding, |view| view.child(div().mb(px(12.))
                .child(field("repo-path", "Local repository folder", self.path.clone()))
                .when_some(self.validation.clone(), |view, validation| view.child(div().debug_selector(|| "repo-validation".into())
                    .mb(px(8.)).child(format!("Validated: {}", validation["name"].as_str().unwrap_or("Git repository")))))
                .child(div().flex().gap(px(8.))
                    .child(control("repo-validate", "Validate folder", enabled).on_click(cx.listener(|this, _, _, cx| {
                        this.act(Action::Validate(this.path.read(cx).text.clone()), cx);
                    })))
                    .child(control("repo-register", "Add repository", enabled).on_click(cx.listener(|this, _, _, cx| {
                        this.act(Action::Register(this.path.read(cx).text.clone(), this.detail.clone()), cx);
                    })))
                    .child(control("repo-cancel", "Cancel", enabled).on_click(cx.listener(move |this, _, _, cx| {
                        if enabled { this.adding = false; cx.notify(); }
                    }))))))
            .children(self.snapshot.repos.iter().cloned().enumerate().map(|(i, repo)| {
                let remove = repo.id.clone();
                let owner = self.snapshot.ledger.projects.iter().find(|p| p.repo_paths.contains(&repo.local_path))
                    .map(|p| p.id.clone()).unwrap_or_else(|| self.snapshot.ledger.active_project_id.clone());
                let path = repo.local_path.clone();
                let open_enabled = enabled && repo.exists;
                div().flex().gap(px(8.)).items_center().py(px(6.)).border_b_1().border_color(theme().border)
                    .child(div().flex_1().child(repo.name).child(div().text_size(px(11.)).text_color(theme().text_muted)
                        .child(if repo.exists { repo.local_path } else { "Folder missing. Locate the repository before opening.".into() })))
                    .child(control(format!("repo-open-{i}"), "Open repository", open_enabled).on_click(cx.listener(move |this, _, _, cx| {
                        if open_enabled { this.act(Action::Open(owner.clone(), path.clone()), cx); }
                    })))
                    .child(control(format!("repo-remove-{i}"), "Remove repository", enabled).on_click(cx.listener(move |this, _, _, cx| {
                        if enabled { this.confirmation = Some(Action::Remove(remove.clone())); cx.notify(); }
                    })))
            }))
            .when_some(self.confirmation.clone(), |view, action| view.child(div().mt(px(12.)).p(px(12.)).bg(theme().surface_raised)
                .child(if matches!(action, Action::Delete(_)) {
                    "Delete this project? Its exclusive repositories will be disconnected. Local folders are kept."
                } else { "Remove this repository? Its runtime sessions must stop before it is disconnected. Local files are kept." })
                .child(div().flex().gap(px(8.)).mt(px(8.))
                    .child(self.action("projects-confirm", "Confirm", action, cx))
                    .child(control("projects-cancel-confirm", "Cancel", enabled).on_click(cx.listener(move |this, _, _, cx| {
                        if enabled { this.confirmation = None; cx.notify(); }
                    }))))))
            .child(canvas(|_, _, _| (), move |_, _, _, _| painted.set(revision)).size(px(1.)))
    }
}
