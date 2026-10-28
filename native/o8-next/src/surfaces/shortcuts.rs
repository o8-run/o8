use super::*;
#[path = "shortcuts/dialog.rs"]
mod dialog;
#[path = "shortcuts/input.rs"]
mod input;
pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    pub view: Option<Entity<dialog::Dialog>>,
    scroll: gpui::ScrollHandle,
    subscription: Option<gpui::Subscription>,
    inputs: input::Inputs,
}
pub(super) const REGISTRATION: Registration =
    Registration {
        overlay_command: true,
        overlay: |s| {
            s.surfaces
                .shortcuts
                .view
                .as_ref()
                .map(|v| v.clone().into_any_element())
        },
        overlay_open: |s| s.surfaces.shortcuts.view.is_some(),
        // Creating a recovered session focuses it. Defer hidden content until
        // dismissal so the active dialog keeps its current control.
        block_ensure: |s| s.surfaces.shortcuts.view.is_some(),
        key_down: keys,
        nav: |s, position, cx| {
            s.surfaces.shortcuts.inputs.watch(cx);
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
                    .on_click(cx.listener(|s, _, window, cx| {
                        s.execute(Command::ShortcutReference, window, cx)
                    }))
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
    if s.surfaces.shortcuts.inputs.field_focused(window)
        || s.surfaces.shortcuts.inputs.terminal(window, cx).is_some()
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
    let select_tab = command
        && !m.shift
        && ((m.platform && !m.control && m.alt && ["left", "right"].contains(&key))
            || (!m.alt && key.parse::<usize>().is_ok_and(|i| (1..=9).contains(&i))));
    let close_tab = command && !m.alt && !m.shift && key == "w";
    let cycle_tab = m.control && !m.alt && !m.platform && key == "tab";
    if (select_tab || close_tab || cycle_tab)
        && (s.palette || s.shortcuts || registrations().iter().any(|r| (r.overlay_open)(s)))
    {
        // An open surface owns these keys before any underlying tab action.
        if s.palette || s.shortcuts || editing(s, window, cx) {
            return true;
        }
        if close_tab {
            for registration in registrations() {
                if (registration.overlay_open)(s) && (registration.key_down)(s, event, window, cx) {
                    break;
                }
            }
            return true;
        }
        // Full surfaces such as Projects explicitly dismiss on navigation.
        // A modal that stays open must keep navigation off its hidden tabs.
        for registration in registrations() {
            if (registration.overlay_open)(s) {
                (registration.after_tab)(s);
            }
        }
        if registrations().iter().any(|r| (r.overlay_open)(s)) {
            return true;
        }
    }
    let terminal = s.surfaces.shortcuts.inputs.terminal(window, cx);
    if let Some(terminal) = terminal
        && input::core_chord(event)
    {
        input::deliver_core_chord(&terminal, event, window, cx);
        return true;
    }
    if editing(s, window, cx) {
        // Text fields pass palette, Settings and legacy Ctrl+Tab chords.
        // Keep Ctrl+W from closing the editor or its underlying tab.
        return m.control && !m.alt && key == "w";
    }
    let question = !command && !m.alt && (key == "?" || (key == "/" && m.shift));
    if (help_key || question) && !s.palette {
        s.set_help(true, window, cx);
        return true;
    }
    if select_tab {
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
    if close_tab {
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
