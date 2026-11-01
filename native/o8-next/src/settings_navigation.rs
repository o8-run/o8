//! Search and page history stay local; typing never mounts remote settings pages.
use super::*;
use gpui::{AnyElement, ScrollHandle, div, prelude::*, px};
use std::cmp::Reverse;

pub(super) struct State {
    trail: Vec<&'static str>,
    at: usize,
    target: Option<&'static str>,
    pub(super) list_scroll: ScrollHandle,
}
impl Default for State {
    fn default() -> Self {
        Self {
            trail: vec!["general"],
            at: 0,
            target: None,
            list_scroll: ScrollHandle::new(),
        }
    }
}
impl State {
    pub(super) fn remember(&mut self, section: &'static str) {
        self.target = None;
        if let Some(index) = crate::settings_fields::SECTIONS
            .iter()
            .position(|(id, _)| *id == section)
        {
            self.list_scroll.scroll_to_item(index);
        }
        if self.trail[self.at] != section {
            self.trail.truncate(self.at + 1);
            self.trail.push(section);
            self.at += 1;
        }
    }
}

enum Destination {
    Field(&'static Field),
    Panel(&'static str, &'static str),
}
impl Settings {
    pub(super) fn step_settings_focus(
        &self,
        backward: bool,
        window: &mut Window,
        cx: &Context<Self>,
    ) {
        // The window's Tab order also contains the covered workspace.
        for _ in 0..128 {
            if backward {
                window.focus_prev();
            } else {
                window.focus_next();
            }
            if self.focus.contains_focused(window, cx) {
                return;
            }
        }
        self.search.read(cx).focus.focus(window);
    }
    pub(super) fn keep_navigation_focus_visible(&self, window: &Window) {
        for (index, (id, _)) in crate::settings_fields::SECTIONS.iter().enumerate() {
            if self
                .controls
                .get(&format!("settings-nav-{id}"))
                .is_some_and(|focus| focus.is_focused(window))
            {
                self.navigation.list_scroll.scroll_to_item(index);
                break;
            }
        }
    }
    pub(super) fn visible_fields(&self, query: &str) -> Vec<&'static Field> {
        if query.len() < 2 {
            return fields()
                .filter(|field| field.section == self.section)
                .collect();
        }
        let mut found: Vec<_> = fields()
            .filter_map(|field| field.search_score(query).map(|score| (score, field)))
            .collect();
        found.sort_by_key(|(score, _)| Reverse(*score));
        found.into_iter().map(|(_, field)| field).collect()
    }
    fn first_result(&self, query: &str) -> Option<Destination> {
        if query.len() < 2 {
            return None;
        }
        if let Some(&field) = self.visible_fields(query).first() {
            return Some(Destination::Field(field));
        }
        [
            ("appearance", "Appearance", "appearance theme light dark solid all glass workspace"),
            ("keyboard", "Keyboard", "keyboard shortcuts help keybindings hotkeys"),
            ("about", "About", "about version platform mode updates github documentation releases credits"),
            ("connections", "Connections", "connections adapter capabilities workers actions session transforms usage limits"),
            ("diagnostics", "Diagnostics", "diagnostics shipped feature audit flags maintenance transcript retention"),
            ("storage", "Worktrees & storage", "storage disk worktrees workspace usage free reserved parking categories allocated logical"),
            ("indexing", "Indexing", "indexing repository index engineering brain instructions outcomes knowledge documentation"),
        ].into_iter().find(|(section, _, words)| panels::matches(section, self.section, query, words))
            .map(|(section, label, _)| Destination::Panel(section, label))
    }
    pub(super) fn first_result_label(&self, query: &str) -> Option<String> {
        self.first_result(query)
            .map(|destination| match destination {
                Destination::Field(field) => {
                    format!("Open {} · {}", field.label, field.section_label())
                }
                Destination::Panel(_, label) => format!("Open {label}"),
            })
    }
    pub(super) fn open_first_result(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.editor.is_some() {
            return;
        }
        let query = self.search.read(cx).text.trim().to_lowercase();
        match self.first_result(&query) {
            Some(Destination::Field(field)) => {
                self.select(field.section, cx);
                self.navigation.target = Some(field.id);
            }
            Some(Destination::Panel(section, _)) => self.select(section, cx),
            None => return,
        }
        self.focus.focus(window);
    }
    pub(super) fn reveal_search_target(&mut self, field: &Field, index: usize) {
        if !self.busy && self.navigation.target == Some(field.id) {
            // Direct list children scroll during layout, including in CPU GPUI tests.
            self.scroll.scroll_to_item(index);
            self.navigation.target = None;
        }
    }
    fn browse(&mut self, forward: bool, cx: &mut Context<Self>) {
        if self.busy || self.editor.is_some() {
            return;
        }
        if !forward && self.navigation.at == 0 {
            cx.emit(Close);
            return;
        }
        let next = if forward {
            self.navigation.at + 1
        } else {
            self.navigation.at - 1
        };
        if next < self.navigation.trail.len() {
            self.navigation.at = next;
            self.select(self.navigation.trail[next], cx);
        }
    }
    pub(super) fn history_view(&mut self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let enabled = !self.busy && self.editor.is_none();
        let forward = self.navigation.at + 1 < self.navigation.trail.len();
        div()
            .flex()
            .gap(px(8.))
            .flex_shrink_0()
            .child(
                self.button(
                    "settings-back".into(),
                    if self.navigation.at == 0 {
                        "Back to workspace"
                    } else {
                        "Back"
                    }
                    .into(),
                    enabled,
                    false,
                    window,
                    cx,
                    |this, _, cx| this.browse(false, cx),
                )
                .w(px(150.)),
            )
            .child(self.button(
                "settings-forward".into(),
                "Forward".into(),
                enabled && forward,
                false,
                window,
                cx,
                |this, _, cx| this.browse(true, cx),
            ))
            .into_any_element()
    }
}
