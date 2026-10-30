//! Project navigation uses the existing Projects action and desktop routes.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, px};
#[path = "project_header_data.rs"]
mod data;
pub(super) use data::HeaderSnapshot;
#[path = "project_identity.rs"]
mod identity;
#[path = "scope.rs"]
mod scope;
pub(super) use scope::{Menu as ScopeMenu, RowMenu};
use identity::glyph;
pub(super) use identity::identity;

impl ThreadList {
    /// An open header menu owns input before shell or row shortcut dispatch.
    pub fn header_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if (self.header_menu.is_none() && !self.header_busy)
            || !self.focus.contains_focused(window, cx)
        {
            return false;
        }
        if event.keystroke.key == "escape" {
            self.header_menu = None;
            if self.editing {
                self.editor.read(cx).focus.focus(window);
            } else {
                self.focus.focus(window);
            }
            cx.notify();
        }
        cx.stop_propagation();
        true
    }

    pub fn set_workspace(&mut self, workspace: Option<String>) {
        self.workspace = workspace;
    }
    fn header_select(&mut self, action: Action, cx: &mut Context<Self>) {
        if self.header_busy {
            return;
        }
        self.header_busy = true;
        self.generation += 1;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let outcome = action.run(&client)?;
            // Read the same names, colors and canonical active ID as the desktop.
            let header = HeaderSnapshot::with_repos(&client, outcome.snapshot.repos)?;
            Ok::<_, String>((outcome.workspace, header))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.header_busy = false;
                match result {
                    Ok((workspace, header)) => {
                        let active = header
                            .ledger
                            .projects
                            .iter()
                            .find(|p| p.id == header.ledger.active_project_id);
                        let canonical = active.and_then(|p| p.repo_paths.first()).cloned();
                        let path = match workspace {
                            Some(WorkspaceChange::Open(path)) => active
                                .filter(|p| p.repo_paths.contains(&path))
                                .map(|_| path)
                                .or(canonical),
                            Some(WorkspaceChange::Select(path)) => path
                                .filter(|path| active.is_some_and(|p| p.repo_paths.contains(path)))
                                .or(canonical),
                            None => this.workspace.clone(),
                        };
                        this.workspace = path.clone();
                        this.header = header;
                        this.header_menu = None;
                        this.notice.clear();
                        cx.emit(Event::Workspace(path, this.header.ledger.clone()));
                    }
                    Err(error) => this.notice = error,
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn header_add_repository(&mut self, cx: &mut Context<Self>) {
        if self.header_busy {
            return;
        }
        self.header_busy = true;
        self.header_menu = None;
        let project = self
            .header
            .ledger
            .projects
            .iter()
            .find(|p| p.id == self.header.ledger.active_project_id)
            .and_then(|p| {
                p.sqlite_project_id.clone().or_else(|| {
                    (p.id != "default" && !p.id.starts_with("repo:")).then(|| p.id.clone())
                })
            });
        let prompt = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Add repository".into()),
        });
        cx.spawn(async move |this, cx| {
            let result = prompt.await;
            let _ = this.update(cx, |this, cx| {
                this.header_busy = false;
                match result {
                    Ok(Ok(Some(paths))) => {
                        if let Some(path) = paths.first() {
                            this.header_select(
                                Action::Register(path.to_string_lossy().into_owned(), project),
                                cx,
                            );
                        }
                    }
                    Ok(Ok(None)) => {}
                    _ => this.notice = "Could not choose a repository folder".into(),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn project_header(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let active = self
            .header
            .ledger
            .projects
            .iter()
            .find(|p| p.id == self.header.ledger.active_project_id);
        let project = active.and_then(|p| self.header.identities.get(&p.id));
        let name = project
            .map(|p| p.name.clone())
            .unwrap_or_else(|| "Projects".into());
        let color = project.and_then(|p| p.color.as_deref());
        let project_id = active.map(|p| p.id.clone()).unwrap_or_default();
        let mut repos: Vec<_> = active
            .into_iter()
            .flat_map(|p| p.repo_paths.iter())
            .filter_map(|path| {
                self.header
                    .repos
                    .iter()
                    .find(|r| &r.local_path == path)
                    .cloned()
            })
            .collect();
        repos.sort_by_key(|r| self.workspace.as_ref() != Some(&r.local_path));
        // Match the desktop: selected first, max 140px per chip, at most three.
        let widths: Vec<f32> = repos
            .iter()
            .map(|r| {
                let text = crate::text::sanitize(&r.name);
                let run = gpui::TextRun {
                    len: text.len(),
                    font: gpui::Font {
                        weight: gpui::FontWeight::LIGHT,
                        ..gpui::font(theme().font_ui)
                    },
                    color: theme().text.into(),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                let line = window
                    .text_system()
                    .shape_line(text.into(), px(10.5), &[run], None);
                (f32::from(line.width) + 30.).min(140.)
            })
            .collect();
        let mut count = repos.len().min(3);
        while count > 1
            && widths[..count].iter().sum::<f32>()
                + (count - 1) as f32 * 3.
                + if count < repos.len() { 41. } else { 0. }
                > 237.
        {
            count -= 1;
        }
        let chips = repos
            .iter()
            .take(count)
            .enumerate()
            .map(|(index, repo)| {
                let id = repo.id.clone();
                let project = project_id.clone();
                div()
                    .id(gpui::ElementId::Name(format!("sidebar-chip-{id}").into()))
                    .debug_selector(move || format!("sidebar-repo-{index}"))
                    .h(px(24.))
                    .max_w(px(140.))
                    .min_w_0()
                    .pl(px(4.))
                    .pr(px(7.))
                    .py(px(3.))
                    .rounded(px(7.))
                    .flex()
                    .items_center()
                    .text_size(px(10.5))
                    .gap(px(5.))
                    .text_color(theme().text_muted)
                    .bg(if self.workspace.as_ref() == Some(&repo.local_path) {
                        theme().hover
                    } else {
                        theme().surface
                    })
                    .child(identity(&repo.name, None, 14., "sidebar-repo-identity"))
                    .child(
                        div()
                            .min_w_0()
                            .text_ellipsis()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .child(crate::text::sanitize(&repo.name)),
                    )
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.header_select(Action::Open(project.clone(), id.clone()), cx)
                    }))
            })
            .collect::<Vec<_>>();
        let mut view = div()
            .debug_selector(|| "sidebar-project-header".into())
            .py(px(3.))
            .flex()
            .flex_col()
            .child(
                div()
                    .pl(px(8.))
                    .pr(px(5.))
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .child(
                        div()
                            .id("sidebar-project-switcher")
                            .debug_selector(|| "sidebar-project-switcher".into())
                            .h(px(32.))
                            .pl(px(2.))
                            .pr(px(4.))
                            .min_w_0()
                            .flex_1()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .cursor_pointer()
                            .child(
                                div()
                                    .size(px(17.))
                                    .flex_shrink_0()
                                    .relative()
                                    .left(px(-2.))
                                    .child(identity(&name, color, 17., "sidebar-project-identity")),
                            )
                            .child(
                                div()
                                    .debug_selector({
                                        let name = name.clone();
                                        move || format!("sidebar-project-name:{name}")
                                    })
                                    .text_size(px(13.5))
                                    .min_w_0()
                                    .flex_1()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .child(crate::text::sanitize(&name)),
                            )
                            .when(repos.len() > 1, |v| {
                                v.child(
                                    div()
                                        .debug_selector({
                                            let count = repos.len();
                                            move || format!("sidebar-project-count:{count}")
                                        })
                                        .text_size(px(10.))
                                        .text_color(theme().text_muted)
                                        .child(repos.len().to_string()),
                                )
                            })
                            .child(
                                div()
                                    .debug_selector(|| "sidebar-project-chevron".into())
                                    .size(px(13.))
                                    .flex_shrink_0()
                                    .child(glyph(false, 13., theme().text_faint)),
                            )
                            .capture_any_mouse_down(cx.listener(
                                |this, event: &gpui::MouseDownEvent, window, cx| {
                                    if event.button == gpui::MouseButton::Left
                                        && this.header_menu != Some(true)
                                    {
                                        this.header_focus = window.focused(cx);
                                    }
                                },
                            ))
                            .on_click(cx.listener(|this, _, window, cx| {
                                if !this.header_busy {
                                    this.header_menu = if this.header_menu == Some(true) {
                                        None
                                    } else {
                                        Some(true)
                                    };
                                }
                                this.focus.focus(window);
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("sidebar-project-add")
                            .debug_selector(|| "sidebar-project-add".into())
                            .size(px(28.))
                            .flex_shrink_0()
                            .p(px(6.))
                            .cursor_pointer()
                            .child(glyph(true, 16., theme().text_muted))
                            .on_click(cx.listener(|this, _, _, cx| this.header_add_repository(cx))),
                    ),
            )
            .when(repos.len() > 1, |v| {
                v.child(
                    div()
                        .pl(px(37.))
                        .pr(px(6.))
                        .pb(px(5.))
                        .flex()
                        .gap(px(3.))
                        .children(chips)
                        .when(count < repos.len(), |v| {
                            v.child(
                                div()
                                    .id("sidebar-repo-overflow")
                                    .debug_selector(|| "sidebar-repo-overflow".into())
                                    .h(px(24.))
                                    .w(px(38.))
                                    .flex_shrink_0()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .gap(px(2.))
                                    .rounded(px(7.))
                                    .text_size(px(10.5))
                                    .child(format!("+{}", repos.len() - count))
                                    .child(glyph(false, 10., theme().text_muted))
                                    .cursor_pointer()
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        if !this.header_busy {
                                            this.header_menu = if this.header_menu == Some(false) {
                                                None
                                            } else {
                                                Some(false)
                                            };
                                        }
                                        this.focus.focus(window);
                                        cx.notify();
                                    })),
                            )
                        }),
                )
            });
        if let Some(projects) = self.header_menu {
            let mut menu = div()
                .id("sidebar-header-menu")
                .debug_selector(|| "sidebar-header-menu".into())
                .max_h(px(240.))
                .overflow_y_scroll()
                .rounded(px(14.))
                .p(px(6.))
                .bg(theme().surface_raised);
            if projects {
                let has_project_outside_default = self
                    .header
                    .ledger
                    .projects
                    .iter()
                    .any(|p| p.id != "default");
                for item in self
                    .header
                    .ledger
                    .projects
                    .iter()
                    .filter(|p| !has_project_outside_default || p.id != "default")
                {
                    let id = item.id.clone();
                    let selector = id.clone();
                    let project = self.header.identities.get(&item.id);
                    let name = project.map(|p| p.name.as_str()).unwrap_or("Projects");
                    let color = project.and_then(|p| p.color.as_deref());
                    menu = menu.child(
                        div()
                            .id(gpui::ElementId::Name(
                                format!("sidebar-project-{id}").into(),
                            ))
                            .debug_selector(move || format!("sidebar-project-{selector}"))
                            .h(px(43.))
                            .px(px(9.))
                            .gap(px(10.))
                            .flex()
                            .items_center()
                            .rounded(px(9.))
                            .text_size(px(13.))
                            .text_ellipsis()
                            .cursor_pointer()
                            .hover(|s| s.bg(theme().hover))
                            .child(identity(
                                name,
                                color,
                                22.,
                                "sidebar-project-choice-identity",
                            ))
                            .child(crate::text::sanitize(name))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.header_select(Action::Activate(id.clone()), cx)
                            })),
                    );
                }
                menu = menu.child(
                    div()
                        .id("sidebar-workspace-picker")
                        .debug_selector(|| "sidebar-workspace-picker".into())
                        .h(px(34.))
                        .px(px(9.))
                        .flex()
                        .items_center()
                        .rounded(px(9.))
                        .text_size(px(12.))
                        .cursor_pointer()
                        .hover(|s| s.bg(theme().hover))
                        .child("Switch workspace…")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.header_menu = None;
                            cx.emit(Event::WorkspacePicker(this.header_focus.take()));
                            cx.notify();
                        })),
                );
            } else {
                for (index, repo) in repos.iter().enumerate().skip(count) {
                    let id = repo.id.clone();
                    let project = project_id.clone();
                    menu = menu.child(
                        div()
                            .id(gpui::ElementId::Name(
                                format!("sidebar-overflow-{id}").into(),
                            ))
                            .debug_selector(move || format!("sidebar-repo-{index}"))
                            .h(px(34.))
                            .px(px(8.))
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .text_size(px(12.))
                            .text_ellipsis()
                            .cursor_pointer()
                            .hover(|s| s.bg(theme().hover))
                            .child(identity(&repo.name, None, 14., "sidebar-overflow-identity"))
                            .child(crate::text::sanitize(&repo.name))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.header_select(Action::Open(project.clone(), id.clone()), cx)
                            })),
                    );
                }
            }
            view = view.child(menu);
        }
        view.opacity(if self.header_busy { 0.6 } else { 1. })
            .into_any_element()
    }
}
