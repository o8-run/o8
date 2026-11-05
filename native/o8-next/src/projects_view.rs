use super::*;
use crate::theme::current as theme;

pub(super) fn control(
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
pub(super) fn field(
    selector: &'static str,
    label: &'static str,
    input: Entity<Composer>,
) -> Stateful<Div> {
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
        let open_card = id.clone();
        let edit = project.clone();
        let delete = id.clone();
        let workspace = self.snapshot.workspace(&project).cloned();
        let open_id = id.clone();
        let open_enabled = enabled && workspace.as_ref().is_some_and(|r| r.exists);
        let members = project.repos.clone();
        let detail = self.detail.as_ref() == Some(&id);
        let active = self.snapshot.ledger.projects.iter().any(|p| {
            p.id == self.snapshot.ledger.active_project_id
                && (p.id == id || p.sqlite_project_id.as_ref() == Some(&id))
        });
        let description = project.description.clone().filter(|d| !d.trim().is_empty());
        let count = match members.len() {
            1 => "1 repository".to_owned(),
            n => format!("{n} repositories"),
        };
        let heading = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(px(if detail { 24. } else { 14. }))
                    .when(detail, |d| d.font_weight(gpui::FontWeight::EXTRA_LIGHT))
                    .when(!detail, |d| d.font_weight(gpui::FontWeight::MEDIUM))
                    .child(project.name.clone()),
            )
            .when(active, |row| {
                row.child(
                    div()
                        .flex_none()
                        .px(px(6.))
                        .py(px(1.))
                        .rounded(px(4.))
                        .bg(theme().surface_raised)
                        .text_size(px(10.))
                        .text_color(theme().text_muted)
                        .child("Active"),
                )
            });
        let summary = div()
            .mt(px(4.))
            .text_size(px(12.))
            .text_color(theme().text_muted)
            .when(!detail, |d| d.line_clamp(2))
            .child(
                description
                    .clone()
                    .unwrap_or_else(|| "No instructions yet.".into()),
            );
        let actions = div()
            .flex()
            .flex_wrap()
            .gap(px(6.))
            .mt(px(10.))
            .when(!detail, |row| {
                row.child(
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
            })
            .child(self.action(
                format!("project-activate-{}", project.slug),
                if active {
                    "Active project"
                } else {
                    "Switch project"
                },
                Action::Activate(id.clone()),
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
                            Action::Open(open_id.clone(), workspace.as_ref().unwrap().id.clone()),
                            cx,
                        );
                    }
                })),
            )
            .child(
                control(format!("project-edit-{}", project.slug), "Edit", enabled).on_click(
                    cx.listener(move |this, _, window, cx| {
                        if enabled {
                            this.edit(Some(edit.clone()), window, cx);
                        }
                    }),
                ),
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
            );
        if !detail {
            // A card: its name opens the project page. The card itself
            // takes no click, so its buttons act on their own.
            return div()
                .w(px(300.))
                .p(px(14.))
                .border_1()
                .border_color(theme().border)
                .rounded(px(10.))
                .child(
                    div()
                        .id(ElementId::Name(
                            format!("project-card-{}", project.slug).into(),
                        ))
                        .when(enabled, |name| {
                            name.cursor_pointer()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.detail = Some(open_card.clone());
                                    cx.notify();
                                }))
                        })
                        .child(heading),
                )
                .child(
                    div()
                        .mt(px(2.))
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child(count),
                )
                .child(summary)
                .child(actions)
                .into_any_element();
        }
        let repo_row = |r: usize, repo: &Repo| {
            div()
                .flex()
                .gap(px(8.))
                .items_center()
                .py(px(7.))
                .border_b_1()
                .border_color(theme().border)
                .child(crate::shell::sidebar::repo_identity(
                    &repo.name,
                    None,
                    repo.icon.as_ref(),
                    18.,
                    &format!("project-repo-identity-{r}"),
                ))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(div().truncate().child(repo.name.clone()))
                        .child(
                            div()
                                .truncate()
                                .text_size(px(11.))
                                .text_color(theme().text_muted)
                                .child(repo.local_path.clone()),
                        ),
                )
        };
        let section = |title: &'static str, note: &'static str| {
            div()
                .mt(px(22.))
                .mb(px(4.))
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .child(title),
                )
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child(note),
                )
        };
        let repos: Vec<(usize, Repo)> = self.snapshot.repos.iter().cloned().enumerate().collect();
        let (linked, others): (Vec<_>, Vec<_>) = repos
            .into_iter()
            .partition(|(_, repo)| members.iter().any(|m| m.repo_id == repo.id));
        div()
            .max_w(px(760.))
            .child(heading)
            .child(
                div()
                    .mt(px(2.))
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child(format!("{} · {count}", project.slug)),
            )
            .child(actions)
            .child(section(
                "Instructions",
                "Every agent working in this project reads these first. Edit to change them.",
            ))
            .child(
                div()
                    .p(px(12.))
                    .rounded(px(8.))
                    .bg(theme().surface_raised)
                    .text_size(px(12.))
                    .when(description.is_none(), |d| d.text_color(theme().text_muted))
                    .child(description.unwrap_or_else(|| "No instructions yet.".into())),
            )
            .child(section(
                "In this project",
                "Agents in this project can work across all of these repositories.",
            ))
            .when(linked.is_empty(), |view| {
                view.child(
                    div()
                        .py(px(6.))
                        .text_color(theme().text_muted)
                        .child("No repositories yet. Add one below."),
                )
            })
            .children(linked.into_iter().map(|(r, repo)| {
                let member = members.iter().find(|m| m.repo_id == repo.id);
                let role = member.and_then(|m| m.role.clone()).unwrap_or_default();
                let next = (ROLES.iter().position(|x| *x == role).unwrap_or(0) + 1) % ROLES.len();
                repo_row(r, &repo)
                    .child(self.action(
                        format!("project-role-{r}"),
                        format!("Role: {}", if role.is_empty() { "none" } else { &role }),
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
            }))
            .when(!others.is_empty(), |view| {
                view.child(section(
                    "Add from your repositories",
                    "Link a repository that belongs to this project.",
                ))
            })
            .children(others.into_iter().map(|(r, repo)| {
                repo_row(r, &repo).child(self.action(
                    format!("project-link-{r}"),
                    "Add to project",
                    Action::Link(id.clone(), repo.id),
                    cx,
                ))
            }))
            .when(self.snapshot.repos.is_empty(), |view| {
                view.child("No repositories connected. Add a repository below.")
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
                .child(div().flex_1().text_size(px(24.)).font_weight(gpui::FontWeight::EXTRA_LIGHT).child("Projects"))
                .child(control("project-new", "New project", enabled && self.form.is_none()).on_click(cx.listener(move |this, _, window, cx| {
                    if enabled && this.form.is_none() { this.edit(None, window, cx); }
                })))
                .child(control("projects-refresh", "Refresh", enabled).on_click(cx.listener(|this, _, _, cx| this.load(cx)))))
            .child(div().text_color(theme().text_muted).mb(px(16.)).child("A project links the repositories that belong together and the instructions every agent reads."))
            .when(self.loading || self.busy, |view| view.child(div().debug_selector(|| "projects-loading".into())
                .mb(px(10.)).child(if self.loading { "Loading…" } else { "Saving…" })))
            .when_some(self.error.clone(), |view, error| view.child(div().debug_selector(|| "projects-error".into())
                .mb(px(10.)).text_color(theme().warning).child(error)))
            .when(!self.loading && self.error.is_none() && first_run, |view| view.child(div().debug_selector(|| "projects-empty".into())
                .mb(px(12.)).child("No projects yet. Create a project, then connect a repository to get started.")))
            .when(self.form.is_none(), |view| view.child(field("projects-search", "Search projects", self.search.clone())))
            .when(self.detail.is_some(), |view| view.child(control("projects-all", "‹ All projects", enabled).mb(px(14.))
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
            .when(self.form.is_none(), |view| view.child(div().flex().flex_wrap().gap(px(12.)).mb(px(8.))
                .children(visible.iter().map(|(_, p)| self.card(p.clone(), cx)))))
            .when(!self.loading && self.error.is_none() && !first_run && visible.is_empty() && self.form.is_none(), |view| view.child(div()
                .debug_selector(|| "projects-no-match".into()).child("No projects match your search.")))
            .child(div().flex().gap(px(8.)).items_center().my(px(12.))
                .child(div().flex_1().mt(px(16.)).text_size(px(13.)).font_weight(gpui::FontWeight::MEDIUM).child("All repositories"))
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
                let repo_id = repo.id.clone();
                let open_enabled = enabled && repo.exists;
                let choosing = self.icon.as_ref().is_some_and(|p| p.repo == repo.id);
                let chosen = repo.clone();
                let row = div().flex().gap(px(8.)).items_center().py(px(6.)).border_b_1().border_color(theme().border)
                    .child(crate::shell::sidebar::repo_identity(&repo.name, None, repo.icon.as_ref(), 18., &format!("repo-identity-{i}")))
                    .child(div().flex_1().min_w_0().child(div().truncate().child(repo.name)).child(div().truncate().text_size(px(11.)).text_color(theme().text_muted)
                        .child(if repo.exists { repo.local_path } else { "Folder missing. Locate the repository before opening.".into() })))
                    .child(control(format!("repo-icon-{i}"), "Change icon", enabled).on_click(cx.listener(move |this, _, _, cx| {
                        if enabled { this.open_icon(&chosen, cx); }
                    })))
                    .child(control(format!("repo-open-{i}"), "Open repository", open_enabled).on_click(cx.listener(move |this, _, _, cx| {
                        if open_enabled { this.act(Action::Open(owner.clone(), repo_id.clone()), cx); }
                    })))
                    .child(control(format!("repo-remove-{i}"), "Remove repository", enabled).on_click(cx.listener(move |this, _, _, cx| {
                        if enabled { this.confirmation = Some(Action::Remove(remove.clone())); cx.notify(); }
                    })));
                div().child(row).when(choosing, |view| view.children(self.icon_picker(cx)))
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
