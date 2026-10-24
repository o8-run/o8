//! Retain Brain and its native editor per selected session; never persist drafts.
use super::*;
impl Surface {
    pub(super) fn brain_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = &event.keystroke;
        if (key.modifiers.control || key.modifiers.platform)
            && key.key == "e"
            && !key.modifiers.shift
            && !key.modifiers.alt
        {
            self.toggle_brain(window, cx);
            cx.stop_propagation();
        }
    }
    fn toggle_brain(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self
            .sessions
            .iter()
            .find(|s| Some(&s.id) == self.selected.as_ref())
        else {
            return;
        };
        let Some(repo) = session.repo_path.clone() else {
            return;
        };
        if let Some(brain) = self.brains.get(&session.id) {
            brain.update(cx, |brain, cx| brain.toggle(window, cx));
            if !brain.read(cx).expanded {
                self.composer.read(cx).focus.focus(window);
            }
        } else {
            let client = self.client.clone();
            let preferred = session.backend.clone();
            let brain = cx.new(|cx| crate::brain::Brain::new(client, repo, preferred, window, cx));
            let id = session.id.clone();
            let mut expanded = true;
            self.subscriptions.push(cx.observe_in(
                &brain,
                window,
                move |this, brain, window, cx| {
                    let next = brain.read(cx).expanded;
                    if expanded && !next && this.selected.as_ref() == Some(&id) {
                        this.composer.read(cx).focus.focus(window);
                    }
                    expanded = next;
                    cx.notify();
                },
            ));
            self.brains.insert(session.id.clone(), brain);
        }
        cx.notify();
    }
    pub(super) fn brain_control(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let enabled = self
            .sessions
            .iter()
            .any(|s| Some(&s.id) == self.selected.as_ref() && s.repo_path.is_some());
        div()
            .id("open-brain")
            .debug_selector(|| "open-brain".into())
            .h(px(26.))
            .px(px(10.))
            .rounded(px(7.))
            .text_color(if enabled {
                theme().text_muted
            } else {
                theme().text_faint
            })
            .cursor_pointer()
            .child("Open Brain")
            .on_click(cx.listener(|this, _, window, cx| this.toggle_brain(window, cx)))
            .into_any_element()
    }
    pub(super) fn brain_panel(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        match self.selected.as_ref().and_then(|id| self.brains.get(id)) {
            Some(brain) if brain.read(cx).expanded => div()
                .h(px(360.))
                .max_h(gpui::relative(0.65))
                .flex_shrink_0()
                .child(brain.clone())
                .into_any_element(),
            _ => div().into_any_element(),
        }
    }
}
