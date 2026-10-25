//! Project navigation uses the existing Projects action and desktop routes.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, px};

impl ThreadList {
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
        let task = cx
            .background_executor()
            .spawn(async move { action.run(&client) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.header_busy = false;
                match result {
                    Ok(outcome) => {
                        let path = match outcome.workspace {
                            Some(WorkspaceChange::Open(path)) => Some(path),
                            Some(WorkspaceChange::Select(path)) => path,
                            None => this.workspace.clone(),
                        };
                        this.workspace = path.clone();
                        this.header = outcome.snapshot;
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
        let project = active.and_then(|p| {
            self.header
                .projects
                .iter()
                .find(|item| p.sqlite_project_id.as_ref() == Some(&item.id) || p.id == item.id)
        });
        let name = project
            .map(|p| p.name.clone())
            .unwrap_or_else(|| "Projects".into());
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
                    font: gpui::font(theme().font_ui),
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
                    .px(px(7.))
                    .rounded(px(7.))
                    .flex()
                    .items_center()
                    .text_size(px(10.5))
                    .text_ellipsis()
                    .bg(if self.workspace.as_ref() == Some(&repo.local_path) {
                        theme().hover
                    } else {
                        theme().surface
                    })
                    .child(crate::text::sanitize(&repo.name))
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.header_select(Action::Open(project.clone(), id.clone()), cx)
                    }))
            })
            .collect::<Vec<_>>();
        let mut view = div()
            .px(px(8.))
            .py(px(3.))
            .flex()
            .flex_col()
            .child(
                div()
                    .id("sidebar-project-switcher")
                    .debug_selector(|| "sidebar-project-switcher".into())
                    .h(px(32.))
                    .px(px(2.))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .cursor_pointer()
                    .child(
                        div()
                            .w(px(17.))
                            .h(px(17.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                div()
                                    .size(px(6.))
                                    .rounded_full()
                                    .border_1()
                                    .border_color(theme().accent),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(13.5))
                            .text_ellipsis()
                            .flex_1()
                            .child(crate::text::sanitize(&name)),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(theme().text_faint)
                            .child("⌄"),
                    )
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
                    .pl(px(29.))
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
                                .rounded(px(7.))
                                .text_size(px(10.5))
                                .child(format!("+{}", repos.len() - count))
                                .cursor_pointer()
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.header_menu = if this.header_menu == Some(false) {
                                        None
                                    } else {
                                        Some(false)
                                    };
                                    this.focus.focus(window);
                                    cx.notify();
                                })),
                        )
                    }),
            );
        if let Some(projects) = self.header_menu {
            let mut menu = div()
                .id("sidebar-header-menu")
                .max_h(px(240.))
                .overflow_y_scroll()
                .rounded(px(14.))
                .p(px(6.))
                .bg(theme().surface_raised);
            if projects {
                for item in &self.header.ledger.projects {
                    let id = item.id.clone();
                    let selector = id.clone();
                    let name = self
                        .header
                        .projects
                        .iter()
                        .find(|p| item.sqlite_project_id.as_ref() == Some(&p.id) || item.id == p.id)
                        .map(|p| p.name.as_str())
                        .unwrap_or("Projects");
                    menu = menu.child(
                        div()
                            .id(gpui::ElementId::Name(
                                format!("sidebar-project-{id}").into(),
                            ))
                            .debug_selector(move || format!("sidebar-project-{selector}"))
                            .h(px(34.))
                            .px(px(9.))
                            .flex()
                            .items_center()
                            .rounded(px(9.))
                            .text_size(px(13.))
                            .text_ellipsis()
                            .cursor_pointer()
                            .hover(|s| s.bg(theme().hover))
                            .child(crate::text::sanitize(name))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.header_select(Action::Activate(id.clone()), cx)
                            })),
                    );
                }
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
                            .text_size(px(12.))
                            .text_ellipsis()
                            .cursor_pointer()
                            .hover(|s| s.bg(theme().hover))
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
