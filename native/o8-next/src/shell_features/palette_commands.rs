use super::*;
struct Commands;
register_shell_feature!(Commands);
impl ShellFeature for Commands {
    fn execute(
        &self,
        s: &mut Shell,
        command: &Command,
        window: &mut Window,
        cx: &mut Context<Shell>,
    ) -> bool {
        execute(s, command, window, cx)
    }
    fn commands(&self) -> &'static [PaletteCommands] {
        &[PaletteCommands { order: 0, collect }]
    }
}
fn collect(s: &Shell) -> Vec<Command> {
    let mut entries = registrations()
        .iter()
        .filter_map(|r| r.command)
        .collect::<Vec<_>>();
    entries.sort_by_key(|(order, _)| *order);
    let mut commands = entries
        .into_iter()
        .map(|(_, command)| command())
        .collect::<Vec<_>>();
    if let Some(id) = match s.active() {
        Some(Tab::Session(id)) => Some(
            s.current()
                .and_then(|w| w.selections.get(&id))
                .cloned()
                .unwrap_or(id),
        ),
        _ => s.workspace_sessions().first().map(|s| s.id.clone()),
    } {
        commands.insert(0, Command::Message(id));
    }
    commands.extend(
        s.workspace_sessions()
            .iter()
            .map(|s| Command::Session(s.id.clone())),
    );
    commands.extend([Command::Refresh, Command::Shortcuts]);
    commands
}

pub(super) fn execute(
    s: &mut Shell,
    command: &Command,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> bool {
    match command {
        Command::Refresh => {
            s.capture(window, cx);
            if let Some(content) = s.active().and_then(|tab| s.content.get(&s.key(&tab))) {
                content.refresh(cx);
            }
            s.palette = false;
            s.load(cx);
            s.restore_focus(window, cx);
        }
        Command::Shortcuts => {
            s.palette = false;
            s.shortcuts = true;
            s.shortcuts_focus.focus(window);
            cx.notify();
        }
        _ => return false,
    }
    true
}
