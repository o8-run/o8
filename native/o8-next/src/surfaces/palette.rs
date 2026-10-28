//! Palette rendering, filtering, workspace routing and keyboard ownership.
use super::registry::KeyResult;
use super::*;
use crate::theme::current as theme;
#[path = "palette_target.rs"]
pub(super) mod target;
pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) const REGISTRATION: Registration = Registration {
    ..Registration::new("", "", |_, _, _, _| None)
};
#[derive(Clone)]
pub(super) enum Entry {
    Surface(Command),
    Workspace(String),
}
impl Entry {
    pub(super) fn label(&self, sessions: &[Session]) -> String {
        match self {
            Self::Workspace(path) => format!(
                "Switch workspace: {}",
                std::path::Path::new(path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            ),
            Self::Surface(Command::Message(_)) => "New message".into(),
            Self::Surface(command) => command.label(sessions),
        }
    }
    fn identity(&self) -> String {
        match self {
            Self::Workspace(path) => format!("workspace:{path}"),
            Self::Surface(Command::Session(id)) => format!("session:{id}"),
            Self::Surface(Command::Message(id)) => format!("message:{id}"),
            Self::Surface(Command::Feature(command)) => format!("command:{}", command.id),
            Self::Surface(Command::Refresh) => "command:refresh".into(),
            Self::Surface(Command::Shortcuts) => "command:shortcuts".into(),
            Self::Surface(command) => format!("surface:{}", command.registration().command_label),
        }
    }
    pub(super) fn run(self, shell: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
        match self {
            Self::Surface(command) => shell.execute(command, window, cx),
            Self::Workspace(path) => shell.switch(path, window, cx),
        }
    }
}
pub(super) fn entries(shell: &Shell) -> Vec<Entry> {
    let mut entries = if shell.workspace_picker {
        Vec::new()
    } else {
        shell
            .surface_commands()
            .into_iter()
            .map(Entry::Surface)
            .collect::<Vec<_>>()
    };
    if registry::extensions().all(|extension| extension.allow_switch(shell)) {
        entries.extend(shell.workspaces.iter().cloned().map(Entry::Workspace));
    }
    let query = shell.query.to_lowercase();
    entries
        .into_iter()
        .filter(|entry| entry.label(&shell.sessions).to_lowercase().contains(&query))
        .collect()
}
fn toggle(shell: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    if !shell.palette {
        shell.capture(window, cx);
    }
    shell.palette = !shell.palette;
    shell.workspace_picker = false;
    shell.shortcuts = false;
    shell.query.clear();
    shell.choice = 0;
    shell.palette_scroll.scroll_to_item(1);
    shell.restore_focus(window, cx);
}
fn focused_control_owns_keys(shell: &Shell, window: &Window, cx: &App) -> bool {
    if shell.focus.is_focused(window) {
        return false;
    }
    match shell
        .active()
        .and_then(|tab| shell.content.get(&shell.key(&tab)))
    {
        Some(Content::Session(view)) => !view.read(cx).shell_reading_focused(window),
        Some(Content::Grid(view)) => !view.read(cx).shell_reading_focused(window),
        _ => true,
    }
}
pub(super) fn key(
    s: &mut Shell,
    event: &KeyDownEvent,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> KeyResult {
    let key = event.keystroke.key.as_str();
    let modifiers = event.keystroke.modifiers;
    let command = modifiers.control || modifiers.platform;
    let global = command && modifiers.shift && !modifiers.alt && key == "p";
    if command
        && key == "k"
        && (modifiers.shift
            || modifiers.alt
            || (!s.palette && focused_control_owns_keys(s, window, cx)))
    {
        return KeyResult::Propagate;
    }
    if (global || (command && key == "k") || s.palette)
        && registrations()
            .iter()
            .any(|registration| (registration.key_down)(s, event, window, cx))
    {
        return KeyResult::Handled;
    }
    if global || (command && key == "k") {
        toggle(s, window, cx);
    } else if s.palette {
        match key {
            "escape" => {
                s.palette = false;
                s.restore_focus(window, cx);
            }
            "up" => s.choice = s.choice.saturating_sub(1),
            "down" => s.choice = (s.choice + 1).min(entries(s).len().saturating_sub(1)),
            "enter" => {
                if let Some(entry) = entries(s).get(s.choice).cloned() {
                    entry.run(s, window, cx);
                }
            }
            "backspace" => {
                s.query.pop();
                s.choice = 0;
            }
            _ if !command && !modifiers.alt => {
                if let Some(text) = &event.keystroke.key_char {
                    s.query.push_str(text);
                    s.choice = 0;
                }
            }
            _ => return KeyResult::Propagate,
        }
    } else {
        return KeyResult::Unhandled;
    }
    if s.palette {
        s.palette_scroll.scroll_to_item(s.choice + 1);
    }
    KeyResult::Handled
}
pub(super) fn render(shell: &Shell, cx: &mut Context<Shell>) -> Option<gpui::AnyElement> {
    Some(
        div()
            .id("command-palette")
            .debug_selector(|| "command-palette".into())
            .max_h(px(300.))
            .overflow_y_scroll()
            .track_scroll(&shell.palette_scroll)
            .p(px(12.))
            .bg(theme().surface_raised)
            .child(if shell.query.is_empty() {
                "Commands".into()
            } else {
                shell.query.clone()
            })
            .children(entries(shell).into_iter().enumerate().map(|(row, entry)| {
                div()
                    .id(gpui::SharedString::from(entry.identity()))
                    .debug_selector(move || format!("command-{row}"))
                    .p(px(6.))
                    .cursor_pointer()
                    .bg(if row == shell.choice {
                        theme().selection
                    } else {
                        theme().surface_raised
                    })
                    .child(entry.label(&shell.sessions))
                    .on_click(cx.listener(move |s, _, window, cx| entry.clone().run(s, window, cx)))
            }))
            .into_any_element(),
    )
}
#[cfg(test)]
#[path = "palette_tests.rs"]
pub(super) mod tests;
