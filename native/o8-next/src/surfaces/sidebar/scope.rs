//! The repository scope: T3 Code's project scope picker and row filter, with
//! the active o8 project's repositories as its projects.
//!
//! Adapted from T3 Code (https://github.com/pingdotgg/t3code),
//! apps/web/src/components/Sidebar.tsx and
//! apps/web/src/components/threadActionMenu.logic.ts, commit
//! f58fad04162165653bf06f0c987bbfb0074a8a4b. Copyright (c) 2026 T3 Tools Inc.
//! MIT; full notice retained in src/lib/usage/history-readers/LICENSE.txt.
//! Adaptations: Rust and GPUI, repositories of the active o8 project as the
//! logical projects, scope kept per o8 project, o8 presentation.
use super::*;
use gpui::{Corner, MouseButton, Pixels, Point, anchored, deferred};

/// The open scope picker: its search text and highlighted item.
#[derive(Default)]
pub(in crate::shell::sidebar) struct Menu {
    pub query: String,
    pub highlight: usize,
}
/// A thread row's right-click menu, where it opened.
pub(in crate::shell::sidebar) struct RowMenu {
    pub repo: String,
    pub position: Point<Pixels>,
}

/// Lucide list-filter: the trigger while every repository shows.
const FILTER: &str = "M3 6h18M7 12h10M10 18h4";
/// Lucide folder: the All repositories item.
const FOLDER: &str = "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";
/// Lucide check, drawn in the selection badge.
const CHECK: &str = "M20 6 9 17l-5-5";

impl ThreadList {
    fn active_project(&self) -> Option<&crate::projects_model::LedgerProject> {
        self.header
            .ledger
            .projects
            .iter()
            .find(|p| p.id == self.header.ledger.active_project_id)
    }
    /// The active project's repositories as (path, name), in the project's order.
    pub(in crate::shell::sidebar) fn scope_repos(&self) -> Vec<(String, String)> {
        self.active_project()
            .into_iter()
            .flat_map(|p| p.repo_paths.iter())
            .map(|path| {
                let name = self
                    .header
                    .repos
                    .iter()
                    .find(|r| &r.local_path == path)
                    .map(|r| r.name.clone())
                    .unwrap_or_else(|| label(path));
                (path.clone(), name)
            })
            .collect()
    }
    /// The chosen scope: stored repositories the active project still has. A
    /// scope whose repositories are gone reads as every repository, and the
    /// stored keys stay, so it returns with them (resolveSidebarProjectScopeKeys).
    pub(in crate::shell::sidebar) fn scope_keys(&self) -> Vec<String> {
        let Some(project) = self.active_project() else {
            return vec![];
        };
        self.scopes
            .get(&project.id)
            .into_iter()
            .flatten()
            .filter(|key| project.repo_paths.contains(key))
            .cloned()
            .collect()
    }
    /// Restores each project's saved scope from the shell state.
    pub fn restore_scopes(&mut self, scopes: std::collections::BTreeMap<String, Vec<String>>) {
        self.scopes = scopes.into_iter().collect();
        self.rebuild();
    }
    pub(in crate::shell::sidebar) fn set_scope(
        &mut self,
        keys: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = self.active_project().map(|p| p.id.clone()) else {
            return;
        };
        if keys.is_empty() {
            self.scopes.remove(&project);
        } else {
            self.scopes.insert(project.clone(), keys.clone());
        }
        self.rebuild();
        cx.emit(Event::Scope(project, keys));
        cx.notify();
    }
    fn toggle_scope(&mut self, key: String, cx: &mut Context<Self>) {
        let mut keys = self.scope_keys();
        match keys.iter().position(|k| *k == key) {
            Some(index) => {
                keys.remove(index);
            }
            None => keys.push(key),
        }
        self.set_scope(keys, cx);
    }
    /// Sessions the scope shows; every session while no repository is chosen.
    pub(in crate::shell::sidebar) fn scoped_sessions(&self) -> Vec<Session> {
        let keys = self.scope_keys();
        self.sessions
            .iter()
            .filter(|s| {
                keys.is_empty() || s.repo_path.as_ref().is_some_and(|path| keys.contains(path))
            })
            .cloned()
            .collect()
    }
    /// Opening a thread the scope hides widens it to every repository, as
    /// T3's route reveal does.
    pub(in crate::shell::sidebar) fn reveal(&mut self, id: &str, cx: &mut Context<Self>) {
        let keys = self.scope_keys();
        if !keys.is_empty()
            && self.sessions.iter().any(|s| {
                s.id == id && !s.repo_path.as_ref().is_some_and(|path| keys.contains(path))
            })
        {
            self.set_scope(vec![], cx);
        }
    }
    /// "All repositories", then each repository, filtered by the picker's search.
    fn scope_items(&self) -> Vec<(Option<String>, String)> {
        let query = self
            .scope_menu
            .as_ref()
            .map(|m| m.query.trim().to_lowercase())
            .unwrap_or_default();
        std::iter::once((None, "All repositories".to_owned()))
            .chain(
                self.scope_repos()
                    .into_iter()
                    .map(|(path, name)| (Some(path), name)),
            )
            .filter(|(_, name)| query.is_empty() || name.to_lowercase().contains(&query))
            .collect()
    }
    fn toggle_scope_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.scope_menu = match self.scope_menu {
            Some(_) => None,
            None => Some(Menu::default()),
        };
        self.focus.focus(window);
        cx.notify();
    }
    /// A pick: All clears the scope; Shift adds or removes one repository and
    /// keeps the picker open; otherwise the scope becomes that repository.
    fn pick_scope(&mut self, key: Option<String>, add: bool, cx: &mut Context<Self>) {
        match key {
            Some(key) if add => return self.toggle_scope(key, cx),
            Some(key) => self.set_scope(vec![key], cx),
            None => self.set_scope(vec![], cx),
        }
        self.scope_menu = None;
        cx.notify();
    }
    /// The open picker owns typing, movement, Enter and Escape.
    pub(in crate::shell::sidebar) fn scope_key(
        &mut self,
        event: &KeyDownEvent,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(menu) = self.scope_menu.as_mut() else {
            return false;
        };
        let keystroke = &event.keystroke;
        let modifiers = keystroke.modifiers;
        if modifiers.control || modifiers.alt || modifiers.platform {
            return false;
        }
        match keystroke.key.as_str() {
            "escape" => self.scope_menu = None,
            "up" => menu.highlight = menu.highlight.saturating_sub(1),
            "down" => menu.highlight += 1,
            "backspace" => {
                menu.query.pop();
                menu.highlight = 0;
            }
            "enter" => {
                let items = self.scope_items();
                let highlight = self.scope_menu.as_ref().map_or(0, |m| m.highlight);
                if let Some((key, _)) = items.get(highlight.min(items.len().saturating_sub(1))) {
                    self.pick_scope(key.clone(), modifiers.shift, cx);
                }
            }
            key => {
                // A printable key; tests and some layouts leave key_char unset.
                let text = keystroke
                    .key_char
                    .clone()
                    .or_else(|| (key.chars().count() == 1).then(|| key.to_owned()));
                match text {
                    Some(text) if !text.chars().any(char::is_control) => {
                        menu.query.push_str(&text);
                        menu.highlight = 0;
                    }
                    _ => return false,
                }
            }
        }
        let count = self.scope_items().len();
        if let Some(menu) = self.scope_menu.as_mut() {
            menu.highlight = menu.highlight.min(count.saturating_sub(1));
        }
        cx.stop_propagation();
        cx.notify();
        true
    }
    /// The trigger: a filter glyph for every repository, else the chosen
    /// repositories' marks, up to two.
    pub(in crate::shell::sidebar) fn scope_trigger(
        &mut self,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let chosen: Vec<_> = {
            let keys = self.scope_keys();
            self.scope_repos()
                .into_iter()
                .filter(|(path, _)| keys.contains(path))
                .collect()
        };
        let label = if chosen.is_empty() {
            "Filter threads by repository".to_owned()
        } else {
            format!(
                "Filter threads by repository: {}",
                chosen
                    .iter()
                    .map(|(_, name)| name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let marks = match chosen.as_slice() {
            [] => div()
                .child(crate::icon::stroke(FILTER, theme().text_muted, 15., 1.7))
                .into_any_element(),
            [(_, name)] => identity(name, None, 16., "sidebar-scope-identity").into_any_element(),
            [(_, first), (_, second), ..] => div()
                .flex()
                .child(identity(first, None, 14., "sidebar-scope-identity"))
                .child(div().ml(px(-6.)).child(identity(
                    second,
                    None,
                    14.,
                    "sidebar-scope-identity",
                )))
                .into_any_element(),
        };
        div()
            .id("sidebar-scope")
            .debug_selector(|| "sidebar-scope".into())
            .size(px(28.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(8.))
            .cursor_pointer()
            .hover(|style| style.bg(theme().hover))
            .when(self.scope_menu.is_some(), |v| v.bg(theme().hover))
            .when(self.scope_menu.is_none(), |v| {
                v.tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(label.clone().into())).into())
            })
            .child(marks)
            .on_click(cx.listener(|this, event: &gpui::ClickEvent, window, cx| {
                if !this.dismissing(event) {
                    this.toggle_scope_menu(window, cx)
                }
            }))
            .into_any_element()
    }
    /// The picker under the scope trigger: its search line, then each item
    /// with a check badge on its mark while chosen.
    pub(in crate::shell::sidebar) fn scope_picker(
        &mut self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let menu = self.scope_menu.as_ref()?;
        let query = menu.query.clone();
        let items = self.scope_items();
        let highlight = menu.highlight.min(items.len().saturating_sub(1));
        let keys = self.scope_keys();
        let mut picker = div()
            .id("sidebar-scope-menu")
            .debug_selector(|| "sidebar-scope-menu".into())
            .occlude()
            .mt(px(32.))
            .w(px(256.))
            .max_h(px(320.))
            .overflow_y_scroll()
            .rounded(px(12.))
            .p(px(5.))
            .bg(crate::theme::popover_background())
            .border_1()
            .border_color(theme().border)
            .shadow_lg()
            .on_mouse_down_out(cx.listener(|this, event: &gpui::MouseDownEvent, _, cx| {
                this.scope_menu = None;
                this.dismissed(event);
                cx.notify();
            }))
            .child(
                div()
                    .debug_selector(|| "sidebar-scope-query".into())
                    .h(px(28.))
                    .px(px(9.))
                    .flex()
                    .items_center()
                    .text_size(px(12.5))
                    .text_color(if query.is_empty() {
                        theme().text_faint
                    } else {
                        theme().text
                    })
                    .child(if query.is_empty() {
                        "Search repositories…".to_owned()
                    } else {
                        query
                    }),
            );
        if items.is_empty() {
            picker = picker.child(
                div()
                    .px(px(9.))
                    .py(px(6.))
                    .text_size(px(12.))
                    .text_color(theme().text_muted)
                    .child("No matching repositories."),
            );
        }
        for (index, (key, name)) in items.into_iter().enumerate() {
            let chosen = match &key {
                Some(key) => keys.contains(key),
                None => keys.is_empty(),
            };
            let selector = match &key {
                Some(_) => format!("sidebar-scope-item-{name}"),
                None => "sidebar-scope-all".to_owned(),
            };
            let mark = match &key {
                Some(_) => {
                    identity(&name, None, 16., "sidebar-scope-item-identity").into_any_element()
                }
                None => div()
                    .child(crate::icon::stroke(FOLDER, theme().text_muted, 16., 1.7))
                    .into_any_element(),
            };
            picker = picker.child(
                div()
                    .id(gpui::ElementId::Name(selector.clone().into()))
                    .debug_selector(move || selector.clone())
                    .h(px(32.))
                    .px(px(9.))
                    .gap(px(10.))
                    .flex()
                    .items_center()
                    .rounded(px(9.))
                    .text_size(px(13.))
                    .cursor_pointer()
                    .when(index == highlight, |v| v.bg(theme().hover))
                    .hover(|s| s.bg(theme().hover))
                    .child(
                        div()
                            .relative()
                            .flex_shrink_0()
                            .child(mark)
                            .when(chosen, |v| {
                                v.child(
                                    div()
                                        .debug_selector(|| "sidebar-scope-check".into())
                                        .absolute()
                                        .right(px(-4.))
                                        .bottom(px(-4.))
                                        .size(px(12.))
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .rounded_full()
                                        .border_2()
                                        .border_color(crate::theme::popover_background())
                                        .bg(theme().accent)
                                        .child(crate::icon::stroke(
                                            CHECK,
                                            theme().background,
                                            8.,
                                            4.,
                                        )),
                                )
                            }),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .whitespace_normal()
                            .line_clamp(1)
                            .text_ellipsis()
                            .child(crate::text::sanitize(&name)),
                    )
                    .on_click(cx.listener(move |this, event: &gpui::ClickEvent, _, cx| {
                        this.pick_scope(key.clone(), event.modifiers().shift, cx)
                    })),
            );
        }
        Some(
            deferred(
                anchored()
                    .anchor(Corner::TopRight)
                    // Right edges align: the trigger is 28px wide.
                    .position_mode(gpui::AnchoredPositionMode::Local)
                    .position(gpui::point(px(28.), px(0.)))
                    .snap_to_window_with_margin(px(12.))
                    .child(picker),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }
    /// A thread row's right-click: its repository's filter, when it has one.
    pub(in crate::shell::sidebar) fn open_row_menu(
        &mut self,
        id: &str,
        position: Point<Pixels>,
        cx: &mut Context<Self>,
    ) {
        let repos = self.scope_repos();
        self.row_menu = self
            .sessions
            .iter()
            .find(|s| s.id == id)
            .and_then(|s| s.repo_path.clone())
            .filter(|repo| repos.iter().any(|(path, _)| path == repo))
            .map(|repo| RowMenu { repo, position });
        cx.notify();
    }
    /// The row menu's Filter by <repository> / Show all repositories.
    pub(in crate::shell::sidebar) fn row_menu(
        &mut self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let menu = self.row_menu.as_ref()?;
        let repo = menu.repo.clone();
        let active = self.scope_keys().contains(&repo);
        let name = self
            .scope_repos()
            .into_iter()
            .find(|(path, _)| *path == repo)
            .map(|(_, name)| name)
            .unwrap_or_else(|| label(&repo));
        let text = if active {
            "Show all repositories".to_owned()
        } else {
            format!("Filter by {}", crate::text::sanitize(&name))
        };
        Some(
            deferred(
                anchored()
                    .position(menu.position)
                    .anchor(Corner::TopLeft)
                    .snap_to_window_with_margin(px(12.))
                    .child(
                        div()
                            .id("sidebar-row-menu")
                            .debug_selector(|| "sidebar-row-menu".into())
                            .occlude()
                            .min_w(px(180.))
                            .rounded(px(12.))
                            .p(px(5.))
                            .bg(crate::theme::popover_background())
                            .border_1()
                            .border_color(theme().border)
                            .shadow_lg()
                            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                                this.row_menu = None;
                                cx.notify();
                            }))
                            .child(
                                div()
                                    .id("sidebar-row-filter")
                                    .debug_selector(|| "sidebar-row-filter".into())
                                    .h(px(28.))
                                    .px(px(8.))
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .rounded(px(7.))
                                    .text_size(px(12.5))
                                    .cursor_pointer()
                                    .hover(|s| s.bg(theme().hover))
                                    .child(crate::icon::stroke(
                                        FOLDER,
                                        theme().text_muted,
                                        14.,
                                        1.7,
                                    ))
                                    .child(text)
                                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                        cx.stop_propagation()
                                    })
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.row_menu = None;
                                        let keys = if active { vec![] } else { vec![repo.clone()] };
                                        this.set_scope(keys, cx);
                                    })),
                            ),
                    ),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }
}
