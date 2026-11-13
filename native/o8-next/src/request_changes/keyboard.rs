use super::*;

impl RequestChanges {
    pub(super) fn key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if event.keystroke.key == "escape" && self.open {
            self.close(window, cx);
            cx.stop_propagation();
            return;
        }
        if event.keystroke.key == "enter" && event.keystroke.modifiers.platform && self.open {
            self.send(cx);
            cx.stop_propagation();
            return;
        }
        if matches!(event.keystroke.key.as_str(), "enter" | "space") {
            if self.focus[2].is_focused(window) {
                self.send(cx);
                cx.stop_propagation();
            } else if self.focus[3].is_focused(window) {
                self.close(window, cx);
                cx.stop_propagation();
            } else if self.focus[4].is_focused(window) {
                self.discard_and_recheck(window, cx);
                cx.stop_propagation();
            } else if self.focus[1].is_focused(window) {
                self.refresh(cx);
                cx.stop_propagation();
            }
            return;
        }
        if event.keystroke.key != "tab" {
            return;
        }
        let mut stops = vec![self.focus[0].clone()];
        if self.open && !self.busy {
            if self.pending.is_none() {
                stops.push(self.input.read(cx).focus.clone());
            }
            if self.enabled() {
                stops.push(self.focus[2].clone());
            }
            if self.pending.is_some() && !self.loading {
                stops.push(self.focus[4].clone());
            }
            stops.push(self.focus[3].clone());
        }
        if self.availability["available"] != true
            && !self.busy
            && !self.loading
            && self.pending.is_none()
        {
            stops.push(self.focus[1].clone());
        }
        let current = stops.iter().position(|focus| focus.is_focused(window));
        let Some(current) = current else {
            return;
        };
        let next = if event.keystroke.modifiers.shift {
            current.checked_sub(1)
        } else {
            (current + 1 < stops.len()).then_some(current + 1)
        };
        if let Some(next) = next {
            stops[next].focus(window);
            cx.stop_propagation();
        }
    }
}
