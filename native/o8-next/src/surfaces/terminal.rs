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
    fn own(client: &Client, workspace: &str) -> Option<Result<String, String>> {
        // Fixture servers in unit tests host no terminal process.
        (!cfg!(test)).then(|| client.own_terminal(workspace))
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

impl Client {
    /// The desktop workspace shell: `terminal-create` with a stable owner key adopts
    /// the session that survived a restart, or reserves one in the workspace that
    /// the pane then attaches to (DesktopWebSocketContext.tsx).
    fn own_terminal(&self, workspace: &str) -> Result<String, String> {
        self.create_terminal(workspace, &format!("o8-next:{workspace}:terminal"))
    }
    /// Reserves the shell an owner keeps across restarts: the workspace's own,
    /// or a split pane's (`o8-next:<workspace>:pane:<id>`).
    pub(super) fn create_terminal(&self, workspace: &str, owner: &str) -> Result<String, String> {
        use std::time::{Duration, Instant};
        use tungstenite::Message;
        let (url, address) = self.websocket()?;
        let tcp = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(2))
            .map_err(|e| e.to_string())?;
        tcp.set_read_timeout(Some(Duration::from_secs(1)))
            .map_err(|e| e.to_string())?;
        let (mut socket, _) = tungstenite::client(url.as_str(), tcp).map_err(|e| e.to_string())?;
        let request = format!("o8-next-{}", std::process::id());
        socket
            .send(Message::Text(
                serde_json::json!({
                    "type": "terminal-create", "cols": 120, "rows": 30, "requestId": request,
                    "cwd": workspace, "ownerKey": owner,
                })
                .to_string()
                .into(),
            ))
            .map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let result = loop {
            if Instant::now() > deadline {
                break Err("Terminal did not start".into());
            }
            let text = match socket.read() {
                Ok(Message::Text(text)) => text,
                Ok(_) => continue,
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue;
                }
                Err(e) => break Err(e.to_string()),
            };
            let message: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            if message["channel"] != "terminal" {
                continue;
            }
            let data = &message["data"];
            match message["event"].as_str() {
                Some("created") if data["requestId"] == request.as_str() => {
                    break data["sessionName"]
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| "Terminal did not start".into());
                }
                Some("error") if data["sessionName"] == "" => {
                    break Err(data["error"]
                        .as_str()
                        .unwrap_or("Terminal did not start")
                        .into());
                }
                _ => {}
            }
        };
        let _ = socket.close(None);
        result
    }
}
