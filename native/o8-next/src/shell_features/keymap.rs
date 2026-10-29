use super::*;
struct Keymap;
register_shell_feature!(Keymap);
impl ShellFeature for Keymap {
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 100,
            dispatch,
        }]
    }
}
fn dispatch(
    s: &mut Shell,
    event: &KeyDownEvent,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> KeyResult {
    let key = event.keystroke.key.as_str();
    let modifiers = event.keystroke.modifiers;
    if registrations()
        .iter()
        .any(|r| (r.key_down)(s, event, window, cx))
    {
    } else if (modifiers.control || modifiers.platform) && !modifiers.shift && !modifiers.alt && key == "b" {
        super::header::toggle_sidebar(s, window, cx);
    } else if (modifiers.control || modifiers.platform) && key == "k" {
        if !s.palette {
            s.capture(window, cx);
        }
        s.palette = !s.palette;
        s.workspace_picker = false;
        s.shortcuts = false;
        s.query.clear();
        s.choice = 0;
        s.restore_focus(window, cx);
    } else if s.shortcuts && key == "escape" {
        s.shortcuts = false;
        s.restore_focus(window, cx);
    } else if s.palette {
        match key {
            "escape" => {
                s.palette = false;
                s.restore_focus(window, cx);
            }
            "up" => s.choice = s.choice.saturating_sub(1),
            "down" => s.choice = (s.choice + 1).min(s.commands().len().saturating_sub(1)),
            "enter" => {
                if let Some(command) = s.commands().get(s.choice).cloned() {
                    command.run(s, window, cx);
                }
            }
            "backspace" => {
                s.query.pop();
                s.choice = 0;
            }
            _ => {
                if !modifiers.control
                    && !modifiers.platform
                    && !modifiers.alt
                    && let Some(text) = &event.keystroke.key_char
                {
                    s.query.push_str(text);
                    s.choice = 0;
                }
            }
        }
    } else if modifiers.control && !modifiers.alt && !modifiers.platform && key == "tab" {
        s.capture(window, cx);
        for registration in registrations() {
            (registration.after_tab)(s);
        }
        if let Some(saved) = s
            .state
            .selected
            .as_ref()
            .and_then(|w| s.state.workspaces.get_mut(w))
            && !saved.tabs.is_empty()
        {
            saved.active = (saved.active + 1) % saved.tabs.len();
        }
        s.ensure(window, cx);
        s.restore_focus(window, cx);
        s.persist();
    } else if modifiers.control
        && !modifiers.alt
        && !modifiers.platform
        && !modifiers.shift
        && key == "w"
    {
        if s.active().is_some() {
            let index = s.current().map_or(0, |w| w.active);
            super::header::close_tab(s, index, window, cx);
        }
    } else {
        return KeyResult::Unhandled;
    }
    if s.palette {
        // The palette header is the first child of the scrolling container.
        s.palette_scroll.scroll_to_item(s.choice + 1);
    }
    KeyResult::Handled
}
