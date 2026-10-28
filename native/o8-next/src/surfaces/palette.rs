//! Palette rendering, filtering, workspace routing and keyboard ownership.
use super::registry::ShellExtension;
use super::*;
use crate::theme::current as theme;
#[path = "palette_target.rs"]
pub(super) mod target;
pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) const REGISTRATION: Registration = Registration {
    extension: Some(&Palette),
    ..Registration::new("", "", |_, _, _, _| None)
};
struct Palette;
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
fn set_open(shell: &mut Shell, opened: bool, workspace_picker: bool, window: &mut Window, cx: &mut Context<Shell>) {
    if opened && !shell.palette {
        shell.capture(window, cx);
    }
    shell.palette = opened;
    shell.workspace_picker = workspace_picker;
    shell.shortcuts = false;
    shell.query.clear();
    shell.palette_input.update(cx, |input, cx| input.clear(cx));
    shell.choice = 0;
    shell.palette_scroll.scroll_to_item(1);
    shell.restore_focus(window, cx);
}
pub(super) fn open_commands(shell: &mut Shell, workspace_picker: bool, window: &mut Window, cx: &mut Context<Shell>) {
    set_open(shell, true, workspace_picker, window, cx);
}
fn toggle(shell: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    set_open(shell, !shell.palette, false, window, cx);
}
impl ShellExtension for Palette {
    fn action(
        &self,
        s: &mut Shell,
        action: &crate::keymap::Shortcut,
        window: &mut Window,
        cx: &mut Context<Shell>,
    ) -> bool {
        use crate::keymap::Shortcut;
        match *action {
            Shortcut::Palette | Shortcut::PaletteGlobal => toggle(s, window, cx),
            Shortcut::PaletteCancel => {
                s.palette = false;
                s.restore_focus(window, cx);
            }
            Shortcut::PaletteMove(next) => {
                s.choice = if next {
                    (s.choice + 1).min(entries(s).len().saturating_sub(1))
                } else {
                    s.choice.saturating_sub(1)
                };
            }
            Shortcut::PaletteAccept => {
                if let Some(entry) = entries(s).get(s.choice).cloned() {
                    entry.run(s, window, cx);
                }
            }
            _ => return false,
        }
        if s.palette {
            s.palette_scroll.scroll_to_item(s.choice + 1);
        }
        true
    }
    fn palette(&self, shell: &Shell, cx: &mut Context<Shell>) -> Option<gpui::AnyElement> {
        Some(
            div()
                .id("command-palette")
                .occlude()
                .absolute()
                .top(px(54.))
                .left(px(12.))
                .right(px(12.))
                .debug_selector(|| "command-palette".into())
                .max_h(px(300.))
                .overflow_y_scroll()
                .track_scroll(&shell.palette_scroll)
                .p(px(12.))
                .bg(theme().surface_raised)
                .child(shell.palette_input.clone())
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
                        .on_click(
                            cx.listener(move |s, _, window, cx| entry.clone().run(s, window, cx)),
                        )
                }))
                .into_any_element(),
        )
    }
}
#[cfg(test)]
#[path = "palette_tests.rs"]
pub(super) mod tests;
