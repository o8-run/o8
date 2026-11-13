use super::*;

impl ActivityPane {
    /// The scope menu row for the current scope.
    pub(super) fn checked_scope(&self) -> String {
        self.repos
            .iter()
            .position(|repo| self.scope != "*" && repo.local_path == self.scope)
            .map_or_else(
                || "activity-scope-all".into(),
                |i| format!("activity-scope-{i}"),
            )
    }
    pub(super) fn key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if event.keystroke.key == "escape" && self.packet.recovery.ask.is_some() {
            if !self.pending && self.unsettled.is_none() {
                self.packet.recovery.ask = None;
                self.focus(window);
                self.changed(cx);
            }
            cx.stop_propagation();
            return;
        }
        if self.packet.corrections.values().any(|control| control.read(cx).editing(window, cx)) {
            return;
        }
        if self.recovery_editing(window, cx)
            || self
                .packet
                .editor
                .as_ref()
                .is_some_and(|editor| editor.input.read(cx).focus.is_focused(window))
        {
            return;
        }
        if event.keystroke.modifiers.control || event.keystroke.modifiers.platform {
            return;
        }
        match event.keystroke.key.as_str() {
            "tab" | "down" | "up" => {
                let length = self.controls.len().max(1);
                let current = self
                    .keyboard
                    .as_ref()
                    .and_then(|id| self.controls.iter().position(|(control, _)| control == id));
                let index = if event.keystroke.key == "up" || event.keystroke.modifiers.shift {
                    current.unwrap_or(0).wrapping_add(length - 1) % length
                } else {
                    current.map(|index| (index + 1) % length).unwrap_or(0)
                };
                self.keyboard = self.controls.get(index).map(|(id, _)| id.clone());
            }
            "enter" | "space" => {
                if let Some((_, action)) = self
                    .keyboard
                    .as_ref()
                    .and_then(|id| self.controls.iter().find(|(control, _)| control == id))
                    .cloned()
                {
                    let opening = matches!(action, Action::ScopeMenu(true));
                    self.act(action, cx);
                    self.packet_focus_editor(window, cx);
                    // As classic, the open menu starts on the checked scope.
                    if opening {
                        self.keyboard = Some(self.checked_scope());
                    }
                }
            }
            "escape" if self.commit.is_some() => self.commit = None,
            "escape" if self.scope_menu => {
                self.scope_menu = false;
                self.keyboard = Some("activity-scope".into());
            }
            "escape" => {
                self.expanded = None;
                self.keyboard = None;
            }
            _ => return,
        }
        self.changed(cx);
        cx.stop_propagation();
    }
}
