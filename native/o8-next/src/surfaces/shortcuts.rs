use super::*;
#[path = "shortcuts/dialog.rs"]
mod dialog;
pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    pub view: Option<Entity<dialog::Dialog>>,
    scroll: gpui::ScrollHandle,
    subscription: Option<gpui::Subscription>,
}
pub(super) const REGISTRATION: Registration = Registration {
    overlay_command: true,
    overlay: |s| {
        s.surfaces
            .shortcuts
            .view
            .as_ref()
            .map(|v| v.clone().into_any_element())
    },
    overlay_open: |s| s.surfaces.shortcuts.view.is_some(),
    key_down: keys,
    pass_key: |s, event, window, cx| {
        s.surfaces.shortcuts.view.is_none()
            && (event.keystroke.modifiers.control || event.keystroke.modifiers.platform)
            && event.keystroke.key == "w"
            && editing(s, window, cx)
    },
    nav: |_, position, cx| {
        if position != NavPosition::AfterWorkspaces {
            return vec![];
        }
        vec![
            div()
                .id("shortcuts-open")
                .debug_selector(|| "shortcuts-open".into())
                .p(px(6.))
                .cursor_pointer()
                .child("Shortcuts")
                .on_click(cx.listener(|s, _, window, cx| s.execute(Command::Shortcuts, window, cx)))
                .into_any_element(),
        ]
    },
    ..Registration::new("", "Open keyboard shortcuts", |s, _, window, cx| {
        s.set_help(true, window, cx);
        None
    })
};
impl Shell {
    fn set_help(&mut self, open: bool, window: &mut Window, cx: &mut Context<Self>) {
        if open == self.surfaces.shortcuts.view.is_some() {
            return;
        }
        if open {
            self.capture(window, cx);
            let view = cx.new(|cx| dialog::Dialog {
                close_focus: cx.focus_handle(),
                list_focus: cx.focus_handle(),
                return_focus: window.focused(cx),
                scroll: self.surfaces.shortcuts.scroll.clone(),
            });
            view.read(cx).close_focus.focus(window);
            self.surfaces.shortcuts.subscription = Some(cx.subscribe_in(
                &view,
                window,
                |s, _, _: &dialog::Close, window, cx| s.set_help(false, window, cx),
            ));
            self.surfaces.shortcuts.view = Some(view);
        } else {
            let view = self.surfaces.shortcuts.view.take().unwrap();
            if let Some(focus) = &view.read(cx).return_focus {
                focus.focus(window);
            } else {
                self.restore_focus(window, cx);
            }
            self.surfaces.shortcuts.subscription = None;
        }
        self.revision += 1;
        cx.notify();
    }
}
fn editing(s: &Shell, window: &Window, cx: &App) -> bool {
    if window
        .context_stack()
        .iter()
        .any(|context| context.contains("o8-editable"))
    {
        return true;
    }
    s.active()
        .and_then(|t| s.content.get(&s.key(&t)))
        .is_some_and(|content| match content {
            Content::Session(session) => session.read(cx).shell_selection(window, cx).1,
            _ => false,
        })
}
fn keys(s: &mut Shell, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Shell>) -> bool {
    let key = event.keystroke.key.as_str();
    let m = event.keystroke.modifiers;
    let command = m.control || m.platform;
    let help_key = command && !m.alt && !m.shift && key == "/";
    if let Some(view) = s.surfaces.shortcuts.view.clone() {
        match key {
            "escape" => s.set_help(false, window, cx),
            "enter" | "space" if view.read(cx).close_focus.is_focused(window) => {
                s.set_help(false, window, cx)
            }
            "tab" => {
                let v = view.read(cx);
                if v.list_focus.is_focused(window) {
                    v.close_focus.focus(window);
                } else {
                    v.list_focus.focus(window);
                }
            }
            "/" if help_key => s.set_help(false, window, cx),
            "down" | "up" | "pagedown" | "pageup" | "home" | "end" => {
                let scroll = &view.read(cx).scroll;
                let offset = scroll.offset();
                let y = match key {
                    "down" => offset.y - px(32.),
                    "up" => offset.y + px(32.),
                    "pagedown" => offset.y - px(200.),
                    "pageup" => offset.y + px(200.),
                    "home" => px(0.),
                    _ => -scroll.max_offset().height,
                };
                scroll.set_offset(point(offset.x, y));
            }
            _ => {}
        }
        s.revision += 1;
        cx.notify();
        return true;
    }
    let question = !command && !m.alt && (key == "?" || (key == "/" && m.shift));
    let is_editing = editing(s, window, cx);
    if (help_key || question) && !is_editing && !s.palette {
        s.set_help(true, window, cx);
        return true;
    }
    if command
        && !m.shift
        && ((m.platform && !m.control && m.alt && ["left", "right"].contains(&key))
            || (!m.alt && key.parse::<usize>().is_ok_and(|i| (1..=9).contains(&i))))
    {
        s.capture(window, cx);
        if let Some(saved) = s
            .state
            .selected
            .as_ref()
            .and_then(|w| s.state.workspaces.get_mut(w))
            && !saved.tabs.is_empty()
        {
            saved.active = match key {
                "left" => (saved.active + saved.tabs.len() - 1) % saved.tabs.len(),
                "right" => (saved.active + 1) % saved.tabs.len(),
                _ => {
                    let index = key.parse::<usize>().unwrap() - 1;
                    if index < saved.tabs.len() {
                        index
                    } else {
                        saved.active
                    }
                }
            };
        }
        s.ensure(window, cx);
        s.restore_focus(window, cx);
        s.persist();
        s.revision += 1;
        cx.notify();
        return true;
    }
    if command && !m.alt && !m.shift && key == "w" && !is_editing {
        if let Some(tab) = s.active() {
            s.content.remove(&s.key(&tab));
            let saved = s
                .state
                .workspaces
                .get_mut(s.state.selected.as_deref().unwrap_or(""))
                .unwrap();
            (tab.registration().remove)(saved, &tab);
            saved.tabs.remove(saved.active);
            saved.active = saved.active.min(saved.tabs.len().saturating_sub(1));
            s.ensure(window, cx);
            s.restore_focus(window, cx);
            s.persist();
            s.revision += 1;
            cx.notify();
        }
        return true;
    }
    false
}
#[cfg(test)]
#[path = "shortcuts/tests.rs"]
mod tests;
