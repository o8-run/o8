use super::palette::target::{Choice, Picker, Port};
use super::*;
use serde_json::Value;

#[path = "diff_git.rs"]
pub(super) mod git;

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Slice {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_packet: Option<String>,
}
pub(super) type Runtime = ();
pub(super) struct PacketDiff;
pub(super) type View = Picker<PacketDiff>;
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((4, || Command::Diff)),
    create: |shell, _, workspace, _, cx| {
        let selected = shell.state.workspaces[&workspace]
            .surfaces
            .diff
            .diff_packet
            .clone();
        let client = shell.panel_client(&workspace);
        Some(Content::Diff(cx.new(|cx| {
            View::new(
                client,
                crate::shell::session::workspace_path(&workspace).to_owned(),
                selected,
                cx,
            )
        })))
    },
    capture: |shell, _, cx| {
        if let Some(Tab::Diff) = shell.active()
            && let Some(Content::Diff(view)) = shell.content.get(&shell.key(&Tab::Diff))
        {
            let selected = view.read(cx).selected.clone();
            shell
                .state
                .workspaces
                .get_mut(shell.state.selected.as_deref().unwrap())
                .unwrap()
                .surfaces
                .diff
                .diff_packet = selected;
        }
    },
    ..Registration::new("Diff", "Open diff for a packet", |_, _, _, _| {
        Some((Tab::Diff, false))
    })
};
/// The Review tab's own target: the workspace's uncommitted changes against
/// HEAD, untracked files included. Packet ids never take this prefix.
const WORKING: &str = "working:";
fn working(workspace: &str) -> Option<Choice> {
    (!workspace.is_empty()).then(|| Choice {
        id: format!("{WORKING}{workspace}"),
        label: "Working changes".into(),
    })
}
impl Port for PacketDiff {
    type View = crate::diff_ui::DiffSurface;
    const TITLE: &'static str = "Packets";
    const EMPTY: &'static str = "No packets";
    const SWITCH: Option<&'static str> = Some("Working changes and packets");
    /// Working changes do not depend on packets: a failed packet read still
    /// lists them.
    fn choices(client: &Client, workspace: &str) -> Result<Vec<Choice>, String> {
        match (client.shell_packets(workspace), working(workspace)) {
            (Ok(mut choices), working) => {
                choices.extend(working);
                Ok(choices)
            }
            (Err(_), Some(working)) => Ok(vec![working]),
            (Err(error), None) => Err(error),
        }
    }
    /// Review opens on the working changes when no packet is restored.
    fn own(_client: &Client, workspace: &str) -> Option<Result<String, String>> {
        working(workspace).map(|choice| Ok(choice.id))
    }
    fn first(choice: &Choice) -> bool {
        choice.id.starts_with(WORKING)
    }
    /// A packet asked for by name (restored, or opened from Activity) that
    /// is not listed shows the list, never the working changes instead.
    const OWN_REPLACES_UNLISTED: bool = false;
    /// The working changes get Commit, Push and Open pull request.
    fn bar(
        client: &Client,
        id: &str,
        child: &Entity<Self::View>,
        cx: &mut App,
    ) -> Option<gpui::AnyView> {
        let workspace = id.strip_prefix(WORKING)?.to_owned();
        let (client, diff) = (client.clone(), child.downgrade());
        Some(
            cx.new(|cx| git::GitActions::new(client, workspace, diff, cx))
                .into(),
        )
    }
    fn create(
        client: Client,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self::View>,
    ) -> Self::View {
        let target = match id.strip_prefix(WORKING) {
            Some(path) => crate::diff::Target::Worktree {
                path: path.to_owned(),
                base: None,
                file: None,
            },
            None => crate::diff::Target::Packet(id),
        };
        crate::diff_ui::DiffSurface::new(client, target, window, cx)
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self::View>, cx: &App) -> bool {
        let view = view.read(cx);
        // A clean working tree has no rows to paint, and a failed read
        // settles on its error notice.
        view.failed
            || view.ready && (!view.painted.borrow().is_empty() || view.document.files.is_empty())
    }
}
impl Client {
    fn shell_packets(&self, workspace: &str) -> Result<Vec<Choice>, String> {
        let state: Value = self.get("/api/orchestrator/state", &[])?;
        Ok(state["mission"]["packets"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| {
                p["status"] != "archived"
                    && p["workspaceTargetPath"]
                        .as_str()
                        .is_some_and(|path| crate::client::same_workspace(path, workspace))
            })
            .filter_map(|p| {
                Some(Choice {
                    id: p["id"].as_str()?.into(),
                    label: p["title"].as_str().or(p["id"].as_str())?.into(),
                })
            })
            .collect())
    }
}

// Request adapters compile with this surface through its existing shell entry.
impl Client {
    pub fn review_state(&self, packet: &str) -> Result<Value, String> {
        self.get("/api/orchestrator/review-state", &[("packetId", packet)])
    }
    pub fn review(&self, body: &Value) -> Result<Value, String> {
        let url = self.url("/api/orchestrator/review").unwrap();
        let request = self.request("POST", &url);
        let response = request
            .send_json(body.clone())
            .map_err(|error| match error {
                ureq::Error::Status(code, _) => {
                    format!("Review rejected (HTTP {code}). Refresh to inspect current state.")
                }
                _ => "Review unconfirmed. Retry reuses the same decision identity.".into(),
            })?;
        Self::read(response)
    }
}
