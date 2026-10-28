//! Row actions retain the row's identity, independent of the keyboard choice.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, px};
impl ThreadList {
    pub(super) fn toggle_archived(&mut self, cx: &mut Context<Self>) {
        self.archived_open = !self.archived_open;
        self.rebuild();
        if self.archived_open
            && let Some(index) = self
                .rows
                .iter()
                .position(|r| r.kind == "section" && r.title == "Archived")
        {
            self.scroll
                .scroll_to_item_strict(index, ScrollStrategy::Top);
        }
        cx.notify();
    }
    // Both render locations share one focus handle, so toggling never loses focus.
    pub(super) fn archived_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.editing {
            return false;
        }
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        let header = self
            .rows
            .iter()
            .position(|r| r.kind == "section" && r.title == "Archived");
        let focused = self.archived_focus.is_focused(window);
        match key {
            "tab"
                if !modifiers.control
                    && !modifiers.platform
                    && !modifiers.alt
                    && (self.query.is_empty() || header.is_some()) =>
            {
                if focused {
                    if modifiers.shift {
                        self.focus.focus(window);
                    } else {
                        window.focus_next();
                    }
                } else {
                    if let Some(index) = header {
                        self.scroll
                            .scroll_to_item_strict(index, ScrollStrategy::Top);
                    }
                    self.archived_focus.focus(window);
                }
            }
            // GPUI's focused on_click activates on key-up. Own key-down so it
            // cannot submit a thread, and let the native click run exactly once.
            "enter" | "space" if focused => {}
            "home" | "end" if focused => {
                self.focus.focus(window);
                return false; // Keep the existing full-list navigation.
            }
            "up" | "down" if focused => {
                self.focus.focus(window);
                let next = if key == "up" {
                    self.rows
                        .iter()
                        .enumerate()
                        .rev()
                        .find(|(i, r)| r.id.is_some() && header.is_none_or(|h| *i < h))
                } else {
                    self.rows
                        .iter()
                        .enumerate()
                        .find(|(i, r)| r.id.is_some() && header.is_none_or(|h| *i > h))
                };
                if let Some((index, row)) = next {
                    self.choice = row.id.clone();
                    self.scroll.scroll_to_item(index, ScrollStrategy::Top);
                }
            }
            "delete" | "f2" if focused => {} // Disclosure focus never mutates a thread.
            _ => return false,
        }
        cx.stop_propagation();
        cx.notify();
        true
    }
    pub(super) fn archived_control(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("sidebar-archived")
            .debug_selector(|| "sidebar-archived".into())
            .track_focus(&self.archived_focus)
            .focus(|style| style.bg(theme().selection).text_color(theme().text))
            .h(px(28.))
            .px(px(12.))
            .flex()
            .items_center()
            .text_size(px(12.))
            .text_color(theme().text_faint)
            .cursor_pointer()
            .child("Archived")
            .on_click(cx.listener(|this, _, window, cx| {
                this.archived_focus.focus(window);
                this.toggle_archived(cx);
            }))
            .into_any_element()
    }
    pub(super) fn row_archive_control(
        &self,
        row: &Row,
        keyboard: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = row.id.clone().unwrap();
        let selector = id.clone();
        div()
            .id(gpui::ElementId::Name(format!("archive:{id}").into()))
            .debug_selector(move || format!("thread-archive-{selector}"))
            .w(px(38.))
            .h(px(20.))
            .flex()
            .items_center()
            .text_size(px(9.5))
            .flex_shrink_0()
            .text_color(theme().text_muted)
            .when(!keyboard || self.choice.as_ref() != Some(&id), |v| {
                v.invisible().group_hover("thread-row", |s| s.visible())
            })
            .opacity(if self.saving { 0.5 } else { 1. })
            .cursor_pointer()
            .child(if row.status == "archived" {
                "Restore"
            } else {
                "Archive"
            })
            .on_click(cx.listener(move |this, _, _, cx| {
                cx.stop_propagation();
                this.archive_id(id.clone(), cx);
            }))
            .into_any_element()
    }
}
