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
            Self::Workspace(path) if super::session::is_home(path) => {
                "Work without a project: Home".into()
            }
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
    pub(super) fn identity(&self) -> String {
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
        entries.extend(
            super::session::home_workspace()
                .filter(|home| !shell.workspaces.contains(home))
                .map(Entry::Workspace),
        );
    }
    let query = shell.query.to_lowercase();
    entries
        .into_iter()
        .filter(|entry| entry.label(&shell.sessions).to_lowercase().contains(&query))
        .collect()
}
pub(super) fn toggle(shell: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    if !shell.palette {
        shell.capture(window, cx);
    }
    shell.palette = !shell.palette;
    shell.workspace_picker = false;
    shell.shortcuts = false;
    shell.query.clear();
    shell.choice = 0;
    shell.palette_scroll.scroll_to_item(0);
    shell.restore_focus(window, cx);
}
/// Workspace navigation from the sidebar's project menu, retaining editor focus.
pub(super) fn open_workspaces(shell: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    shell.capture(window, cx);
    shell.palette = true;
    shell.workspace_picker = true;
    shell.shortcuts = false;
    shell.query.clear();
    shell.choice = 0;
    shell.palette_scroll.scroll_to_item(0);
    shell.restore_focus(window, cx);
    cx.notify();
}
/// Whether a focused control keeps Cmd/Ctrl+K. `cmd` is Cmd+K rather than Ctrl+K.
fn focused_control_owns_keys(shell: &Shell, window: &Window, cx: &App, cmd: bool) -> bool {
    if shell.focus.is_focused(window) || super::features::panel_chrome_focused(shell, window) {
        return false;
    }
    match shell
        .active()
        .and_then(|tab| shell.content.get(&shell.key(&tab)))
    {
        // The composer keeps Ctrl+K (delete to end of line) but has no Cmd+K,
        // so Cmd+K opens the palette from it, as classic's hotkey does.
        Some(Content::Session(view)) => {
            let view = view.read(cx);
            !view.shell_reading_focused(window) && !(cmd && view.shell_selection(window, cx).1)
        }
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
            || (!s.palette
                && focused_control_owns_keys(
                    s,
                    window,
                    cx,
                    modifiers.platform && !modifiers.control,
                )))
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
        s.palette_scroll.scroll_to_item(s.choice);
    }
    KeyResult::Handled
}
/// The palette's search glyph.
const SEARCH: &str = "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z M16 16l5 5";

/// A floating card under the header, over everything: the query on top, then
/// the matching chats, commands and workspaces. A press outside closes it.
pub(super) fn render(shell: &Shell, cx: &mut Context<Shell>) -> Option<gpui::AnyElement> {
    let entries = entries(shell);
    let empty = entries.is_empty();
    let query = shell.query.clone();
    let search = div()
        .h(px(46.))
        .px(px(16.))
        .flex()
        .items_center()
        .gap(px(10.))
        .flex_shrink_0()
        .border_b_1()
        .border_color(theme().border)
        .child(crate::icon::stroke(SEARCH, theme().text_muted, 16., 1.7))
        .child(
            div()
                .flex()
                .items_center()
                .min_w_0()
                .text_size(px(14.))
                .map(|row| {
                    if query.is_empty() {
                        row.child(div().w(px(1.5)).h(px(18.)).bg(theme().accent))
                            .child(
                                div()
                                    .pl(px(2.))
                                    .text_color(theme().text_faint)
                                    .child("Search chats and commands"),
                            )
                    } else {
                        row.text_color(theme().text)
                            .child(div().truncate().child(query))
                            .child(div().w(px(1.5)).h(px(18.)).bg(theme().accent))
                    }
                }),
        );
    let list = div()
        .id("command-palette")
        .debug_selector(|| "command-palette".into())
        .max_h(px(360.))
        .overflow_y_scroll()
        .track_scroll(&shell.palette_scroll)
        .p(px(6.))
        .when(empty, |list| {
            list.child(
                div()
                    .px(px(10.))
                    .py(px(14.))
                    .text_size(px(13.))
                    .text_color(theme().text_muted)
                    .child("No chats or commands match"),
            )
        })
        .children(entries.into_iter().enumerate().map(|(row, entry)| {
            let kind = match &entry {
                Entry::Surface(Command::Session(_)) => "Chat",
                Entry::Workspace(_) => "Workspace",
                _ => "",
            };
            let chosen = row == shell.choice;
            div()
                .id(gpui::SharedString::from(entry.identity()))
                .debug_selector(move || format!("command-{row}"))
                .h(px(34.))
                .px(px(10.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(8.))
                .cursor_pointer()
                .text_size(px(13.))
                .text_color(if chosen {
                    theme().text
                } else {
                    theme().text_secondary
                })
                .when(chosen, |row| row.bg(theme().selection))
                .when(!chosen, |row| row.hover(|row| row.bg(theme().hover)))
                .child(div().flex_1().min_w_0().truncate().child({
                    // The kind tag says Chat; the row needs only the title.
                    let label = entry.label(&shell.sessions);
                    label
                        .strip_prefix("Open session: ")
                        .map(str::to_owned)
                        .unwrap_or(label)
                }))
                .when(!kind.is_empty(), |row| {
                    row.child(
                        div()
                            .text_size(px(11.))
                            .text_color(theme().text_faint)
                            .child(kind),
                    )
                })
                .on_click(cx.listener(move |s, _, window, cx| entry.clone().run(s, window, cx)))
        }));
    let card = div()
        .w(px(600.))
        .max_w(gpui::relative(0.9))
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(px(12.))
        .border_1()
        .border_color(theme().border)
        .bg(crate::theme::menu_fill())
        .shadow(vec![gpui::BoxShadow {
            color: gpui::black().opacity(0.35),
            offset: gpui::point(px(0.), px(16.)),
            blur_radius: px(40.),
            spread_radius: px(0.),
        }])
        // Presses inside the card stay with it.
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(search)
        .child(list);
    Some(
        gpui::deferred(
            div()
                .id("command-palette-scrim")
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .flex()
                .justify_center()
                .items_start()
                .pt(px(72.))
                .occlude()
                .on_mouse_down(
                    gpui::MouseButton::Left,
                    cx.listener(|s, _, window, cx| {
                        s.palette = false;
                        s.restore_focus(window, cx);
                        cx.notify();
                    }),
                )
                .child(card),
        )
        // Above menus and drawers (priority 3 at most), as a modal is.
        .with_priority(4)
        .into_any_element(),
    )
}
#[cfg(test)]
#[path = "palette_tests.rs"]
pub(super) mod tests;
