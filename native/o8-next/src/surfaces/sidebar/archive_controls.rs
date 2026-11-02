//! Row actions retain the row's identity, independent of the keyboard choice.
use super::*;
impl ThreadList {
    pub(super) fn toggle_archived(&mut self, cx: &mut Context<Self>) {
        self.archived_open = !self.archived_open;
        self.rebuild();
        // Both ways: closing shortens the list under a heading that keeps focus.
        if let Some(index) = self
            .rows
            .iter()
            .position(|r| r.kind == "section" && r.title == "Archived")
        {
            self.scroll_row(index, ScrollStrategy::Top, true);
        }
        cx.notify();
    }
    // The heading keeps one focus handle, so toggling never loses focus.
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
                        self.scroll_row(index, ScrollStrategy::Top, true);
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
                    self.scroll_row(index, ScrollStrategy::Top, false);
                }
            }
            "delete" | "f2" if focused => {} // Disclosure focus never mutates a thread.
            _ => return false,
        }
        cx.stop_propagation();
        cx.notify();
        true
    }
}
