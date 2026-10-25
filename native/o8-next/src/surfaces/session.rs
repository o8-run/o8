use super::*;
use crate::ui::Surface;
pub(super) type Runtime = ();
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Slice {
    pub composer: bool,
    #[serde(default)]
    pub selections: std::collections::BTreeMap<String, String>,
}
pub(super) type View = Surface;
pub(super) const REGISTRATION: Registration = Registration {
    create,
    capture: |shell, window, cx| shell.capture_session(window, cx),
    remove: |saved, tab| {
        if let Tab::Session(id) = tab {
            saved.selections.remove(id);
        }
    },
    ..Registration::new("Session", "", |_, command, _, _| match command {
        Command::Session(id) => Some((Tab::Session(id), false)),
        Command::Message(id) => Some((Tab::Session(id), true)),
        _ => unreachable!(),
    })
};
fn create(
    shell: &mut Shell,
    tab: Tab,
    workspace: String,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Option<Content> {
    let Tab::Session(id) = tab else {
        return None;
    };
    let client = shell.client.in_workspace(&workspace);

    let id = shell
        .current()
        .and_then(|w| w.selections.get(&id))
        .cloned()
        .unwrap_or(id);
    let mut sessions = shell.workspace_sessions();
    if !sessions.iter().any(|s| s.id == id) {
        let session = shell.sessions.iter().find(|s| s.id == id)?;
        sessions.push(session.clone());
    }
    Some(Content::Session(cx.new(|cx| {
        Surface::shell_new(client, sessions, id, window, cx)
    })))
}
impl ShellView for Surface {
    fn focus(view: &Entity<Self>, composer: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).shell_focus(composer, window, cx);
    }
    fn tick(view: &Entity<Self>, refresh: bool, cx: &mut Context<Shell>) {
        view.update(cx, |s, cx| s.shell_tick(refresh, cx));
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        view.read(cx).shell_ready()
    }
}
pub(super) fn label(id: &str, sessions: &[Session]) -> String {
    format!(
        "Open session: {}",
        sessions
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.title.as_str())
            .unwrap_or("Unavailable")
    )
}
impl Shell {
    fn capture_session(&mut self, window: &Window, cx: &App) {
        if self.palette || self.surfaces.settings.view.is_some() || self.surfaces.projects.open {
            return;
        }
        if let Some(tab) = self.active()
            && let Some(Content::Session(session)) = self.content.get(&self.key(&tab))
        {
            let (id, composer) = session.read(cx).shell_selection(window, cx);
            let workspace = self.state.selected.as_ref().unwrap();
            if let Some(saved) = self.state.workspaces.get_mut(workspace) {
                if let (Tab::Session(original), Some(id)) = (&tab, id) {
                    saved.selections.insert(original.clone(), id);
                }
                saved.composer = composer;
            }
        }
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
