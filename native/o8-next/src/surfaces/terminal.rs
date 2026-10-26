use super::palette::target::{Choice, Picker, Port};
use super::*;

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Slice {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_session: Option<String>,
}
pub(super) type Runtime = ();
pub(super) struct Terminal;
pub(super) type View = Picker<Terminal>;
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((5, || Command::Terminal)),
    create: |shell, _, workspace, _, cx| {
        let selected = shell.state.workspaces[&workspace]
            .surfaces
            .terminal
            .terminal_session
            .clone();
        let client = shell.client.in_workspace(&workspace);
        Some(Content::Terminal(
            cx.new(|cx| View::new(client, workspace, selected, cx)),
        ))
    },
    capture: |shell, _, cx| {
        if let Some(Tab::Terminal) = shell.active()
            && let Some(Content::Terminal(view)) = shell.content.get(&shell.key(&Tab::Terminal))
        {
            let selected = view.read(cx).selected.clone();
            shell
                .state
                .workspaces
                .get_mut(shell.state.selected.as_deref().unwrap())
                .unwrap()
                .surfaces
                .terminal
                .terminal_session = selected;
        }
    },
    ..Registration::new("Terminal", "Open terminal", |_, _, _, _| {
        Some((Tab::Terminal, false))
    })
};
impl Port for Terminal {
    type View = crate::terminal::Pane;
    const TITLE: &'static str = "Terminals";
    const EMPTY: &'static str = "No terminals";
    fn choices(client: &Client, workspace: &str) -> Result<Vec<Choice>, String> {
        client.shell_terminals(workspace)
    }
    fn create(
        client: Client,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self::View>,
    ) -> Self::View {
        crate::terminal::Pane::new(client, id, window, cx)
    }
    fn tick(view: &Entity<Self::View>, cx: &mut Context<Shell>) {
        view.update(cx, |pane, cx| pane.poll(cx));
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self::View>, cx: &App) -> bool {
        view.read(cx).ready && view.read(cx).painted_bytes.get() > 0
    }
}
impl Client {
    fn shell_terminals(&self, workspace: &str) -> Result<Vec<Choice>, String> {
        let state: serde_json::Value = self.get("/api/mobile/terminal-sessions", &[])?;
        Ok(state["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|s| {
                s["cwd"]
                    .as_str()
                    .is_some_and(|path| crate::client::same_workspace(path, workspace))
            })
            .filter_map(|s| {
                Some(Choice {
                    id: s["name"].as_str()?.into(),
                    label: s["name"].as_str()?.into(),
                })
            })
            .collect())
    }
}
