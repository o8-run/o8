use super::*;

impl Inbox {
    pub(in crate::inbox) fn view_loading(&self) -> bool {
        if self.lane == LANE {
            self.audit.loading
        } else {
            self.loading
        }
    }
    pub(in crate::inbox) fn load_audit(&mut self, cx: &mut Context<Self>) {
        if !self.audit.begin() {
            return;
        }
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            client.get::<ApprovalsResponse>("/api/panel/approvals", &[("status", "all")])
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.audit.accept(result);
                if this.lane == LANE {
                    this.selected = this
                        .selected
                        .min(this.audit.visible(now()).len().saturating_sub(1));
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(in crate::inbox) fn audit_control(&mut self, control: usize, cx: &mut Context<Self>) {
        match control {
            0..=2 => {
                self.audit.menu = if self.audit.menu == Some(control) {
                    None
                } else {
                    Some(control)
                };
                self.audit.cursor = 0;
                self.audit.menu_scroll.scroll_to_item(0);
            }
            3 => {
                self.audit.clear();
                self.selected = 0;
            }
            6 => {
                if !self.audit.loading {
                    self.audit.shown = self.audit.shown.saturating_add(50);
                }
            }
            _ => self.load_audit(cx),
        }
        cx.notify();
    }
    pub(in crate::inbox) fn audit_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.lane != LANE {
            return false;
        }
        let key = event.keystroke.key.as_str();
        if let Some(filter) = self.audit.menu {
            let count = self.audit.options(filter).len() + 1;
            match key {
                "escape" => self.audit.menu = None,
                "up" => self.audit.cursor = (self.audit.cursor.min(count - 1) + count - 1) % count,
                "down" => self.audit.cursor = (self.audit.cursor + 1) % count,
                "enter" | "space" => {
                    if self.audit.cursor >= count - 1 {
                        self.audit.menu = None;
                    } else {
                        self.audit.choose(filter, self.audit.cursor);
                        self.selected = 0;
                    }
                }
                "tab" => {
                    self.audit.menu = None;
                }
                _ => {
                    cx.stop_propagation();
                    return true;
                }
            }
            self.audit.menu_scroll.scroll_to_item(self.audit.cursor);
            if key != "tab" {
                cx.stop_propagation();
                cx.notify();
                return true;
            }
        }
        match key {
            "tab" => {
                let controls = self.audit.focusable_controls();
                let count = controls.len();
                let current = controls
                    .iter()
                    .position(|i| self.audit.focus[*i].is_focused(window));
                let next = if event.keystroke.modifiers.shift {
                    current
                        .map(|i| (i + count - 1) % count)
                        .unwrap_or(count - 1)
                } else {
                    current.map(|i| (i + 1) % count).unwrap_or(0)
                };
                self.audit.focus[controls[next]].focus(window);
            }
            "up" | "down" => {
                self.selected = if key == "up" {
                    self.selected.saturating_sub(1)
                } else {
                    (self.selected + 1).min(
                        self.audit
                            .visible(now())
                            .len()
                            .min(self.audit.shown)
                            .saturating_sub(1),
                    )
                };
                self.audit.scroll.scroll_to_item(self.selected);
            }
            "enter" | "space" => {
                if let Some(i) = self
                    .audit
                    .focusable_controls()
                    .into_iter()
                    .find(|i| self.audit.focus[*i].is_focused(window))
                {
                    self.audit_control(i, cx);
                }
            }
            "escape" => self.audit.menu = None,
            _ => return false,
        }
        cx.stop_propagation();
        cx.notify();
        true
    }
}
