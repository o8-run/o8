use super::*;
use crate::model::History;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::ui::Surface;
#[cfg(test)]
#[path = "../composer/image_loaded_shell_tests.rs"]
mod image_loaded_shell_tests;
#[cfg(test)]
#[path = "../composer/loaded_shell_tests.rs"]
mod loaded_shell_tests;
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
/// The path a workspace has on its own machine.
pub(crate) fn workspace_path(workspace: &str) -> &str {
    machine_workspace(workspace).map_or(workspace, |(_, path)| path)
}
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
    let client = shell.workspace_client(&workspace)?;

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
impl Session {
    /// The workspace this thread opens in. A machine's threads get their own,
    /// so the same path on two machines stays apart.
    pub(crate) fn workspace(&self) -> String {
        let repo = self.repo_path.as_deref().unwrap_or("Unassigned");
        match &self.machine {
            Some(machine) => format!("{MACHINE_WORKSPACE}{machine}|{repo}"),
            None => repo.to_owned(),
        }
    }
}
/// Ids repeat across computers when a data folder was cloned, so a far thread's
/// sidebar id carries its machine. No `:`, which marks a worker's id.
const MACHINE_THREAD: &str = "machine~";
pub(crate) fn machine_thread_id(machine: &str, id: &str) -> String {
    format!("{MACHINE_THREAD}{machine}|{id}")
}
/// A server's own thread can't use the sidebar's form, or it would read as a
/// machine's thread.
pub(crate) fn reserved_thread_id(id: &str) -> bool {
    id.starts_with(MACHINE_THREAD)
}
/// The machine and its own thread id inside a sidebar id.
pub(crate) fn machine_thread(id: &str) -> Option<(&str, &str)> {
    id.strip_prefix(MACHINE_THREAD)?.split_once('|')
}
/// The sidebar's sessions as the shell keeps them: under each server's own id,
/// and told apart by workspace.
pub(crate) fn with_server_ids(sessions: &[Session]) -> Vec<Session> {
    sessions
        .iter()
        .cloned()
        .map(|mut session| {
            if let Some((_, id)) = machine_thread(&session.id) {
                session.id = id.to_owned();
            }
            session
        })
        .collect()
}
const MACHINE_WORKSPACE: &str = "machine:";
/// The machine and repository inside a machine workspace's key.
pub(crate) fn machine_workspace(workspace: &str) -> Option<(&str, &str)> {
    workspace.strip_prefix(MACHINE_WORKSPACE)?.split_once('|')
}
impl ShellView for Surface {
    fn focus(view: &Entity<Self>, composer: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).shell_focus(composer, window, cx);
    }
    fn tick(view: &Entity<Self>, refresh: bool, cx: &mut Context<Shell>) {
        view.update(cx, |s, cx| s.shell_tick(refresh, cx));
    }
    fn refresh(view: &Entity<Self>, cx: &mut Context<Shell>) {
        view.update(cx, |session, cx| session.shell_refresh(cx));
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

/// Actual current-generation parking receipts. Signed deltas preserve net space loss too.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParkedWorkspace {
    pub packet_id: String,
    pub repository_uuid: String,
    #[serde(default)]
    pub reclaimed_available_bytes: Option<i64>,
}

// Request adapters compile with this surface through its existing shell entry.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// The saved machine this thread lives on; None is this computer.
    #[serde(skip)]
    pub machine: Option<String>,
    #[serde(skip)]
    pub machine_label: Option<String>,
    #[serde(default)]
    pub parked_workspaces: Vec<ParkedWorkspace>,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub runtime: String,
    pub status: String,
    #[serde(default)]
    pub message_count: usize,
    #[serde(default)]
    pub last_message_at: String,
    #[serde(default)]
    pub repo_path: Option<String>,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub rejected: bool,
    #[serde(default)]
    pub unread: bool,
    #[serde(default)]
    pub packet_header: Option<Value>,
    #[serde(default)]
    pub tmux_session: Option<String>,
    #[serde(default)]
    pub packet_state: bool,
    /// Inbox settlement (docs/internals/inbox-settlement.md); older hosts
    /// omit these and the sidebar stays as it was.
    #[serde(default)]
    pub inbox_subject: Option<Value>,
    /// Set on a child worker, which its parent conversation already lists.
    #[serde(default)]
    pub parent_inbox_subject: Option<Value>,
    #[serde(default)]
    pub settled_override: Option<String>,
    #[serde(default)]
    pub settled_at: Option<String>,
    /// Why the server settled it on its own ("pr-merged", "released",
    /// "cleaned"), while that automatic settle is the current one.
    #[serde(default)]
    pub auto_settled_reason: Option<String>,
    /// This thread opted out of auto-settle (inboxAction `auto-settle`).
    #[serde(default)]
    pub auto_settle_disabled_at: Option<String>,
    /// `owner/repo` from the repo's git remote, else its folder; older hosts omit it.
    #[serde(default)]
    pub repo_slug: Option<String>,
    /// A worker's model and what it's working on, from the runtime inventory.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub current_task: Option<String>,
    /// The worktree's current branch; older hosts omit it.
    #[serde(default)]
    pub branch: Option<String>,
    /// Actual linked checkout membership; older hosts omit it.
    #[serde(default)]
    pub is_worktree: Option<bool>,
    #[serde(default)]
    pub worktree_path: Option<String>,
    /// When the current run started; null when idle or on older hosts.
    #[serde(default)]
    pub run_started_at: Option<String>,
    /// Inbox pin (#5141), its order key and the preference revision a
    /// pin/unpin must quote; older hosts omit them.
    #[serde(default)]
    pub pinned_at: Option<String>,
    #[serde(default)]
    pub pin_order_key: Option<String>,
    #[serde(default)]
    pub inbox_revision: Option<u64>,
}
impl Session {
    /// This thread's id in the sidebar, given the shell's copy of it.
    pub(crate) fn list_id(&self) -> String {
        self.machine
            .as_deref()
            .map_or_else(|| self.id.clone(), |machine| machine_thread_id(machine, &self.id))
    }
    /// Where this thread runs when that isn't this computer.
    pub(crate) fn away(&self) -> Option<&str> {
        self.machine_label
            .as_deref()
            .or((self.runtime == "cloud").then_some("Cloud"))
    }
    pub fn settled(&self) -> bool {
        self.settled_override.as_deref() == Some("settled")
    }
    pub fn key(&self) -> String {
        if self.id.contains(':') {
            self.id.clone()
        } else {
            format!("llm-chat:{}", self.id)
        }
    }
    pub fn decorate(&self, history: &mut History) {
        if let (Some(header), Some(entry)) = (&self.packet_header, history.transcript.first_mut())
            && entry.role == "user"
        {
            entry.extra.insert("packetHeader".into(), header.clone());
        }
    }
}
#[derive(Debug)]
pub struct QueueError {
    pub message: String,
    pub status: Option<u16>,
    pub network_send: Option<Value>,
}

impl Client {
    pub fn sessions(&self) -> Result<Vec<Session>, String> {
        self.sidebar_threads()
    }
    pub fn context(&self, session: &Session) -> Result<Value, String> {
        let record: Value = self.get(
            "/api/v2/chat-history",
            &[("tabId", &session.id), ("limit", "100")],
        )?;
        if record["source"] == "bot-network" {
            if record["repoPath"].as_str() != session.repo_path.as_deref() {
                return Err(
                    "The network conversation repository changed. Refresh before sending.".into(),
                );
            }
            return Ok(json!({"source":"bot-network", "network":record["network"]}));
        }
        if record["repoPath"].as_str() != session.repo_path.as_deref()
            || record["backend"].as_str() != session.backend.as_deref()
        {
            return Err("Session routing changed. Refresh before sending.".into());
        }
        let backend = record["backend"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("This session has no saved runtime")?;
        let model = record["model"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("This session has no saved model")?;
        let receipt = record["messages"]
            .as_array()
            .and_then(|messages| messages.iter().rev().find(|m| m["role"] == "assistant"))
            .map(|m| &m["receipt"]);
        let permission = receipt
            .and_then(|r| r["permissionMode"].as_str())
            .filter(|p| *p != "outside-workspace")
            .unwrap_or("full");
        let defaults: Value = self
            .get("/api/panel/operator-defaults", &[("include", "values")])
            .unwrap_or(Value::Null);
        let mut routing = json!({"backend":backend,"model":model,"effort":"medium","permissionMode":permission,"mode":"fleet","pickedMode":"fast","collide":false});
        if let Some(effort) = receipt
            .and_then(|r| r["effort"].as_str())
            .or(defaults["values"]["thinkingEffort"].as_str())
        {
            routing["effort"] = json!(effort);
        }
        if let Some(project) = record["projectId"].as_str() {
            routing["projectId"] = json!(project);
        }
        Ok(routing)
    }
    pub fn queue(&self, session: &Session) -> Result<Value, String> {
        self.get(
            "/api/orchestrator/composer-queue",
            &[
                (
                    "repoPath",
                    session
                        .repo_path
                        .as_deref()
                        .ok_or("Session has no repository")?,
                ),
                ("threadId", &session.id),
                ("backend", session.backend.as_deref().unwrap_or("")),
            ],
        )
    }
    pub fn mutate_queue(
        &self,
        method: &str,
        body: &Value,
    ) -> Result<Value, crate::client::QueueError> {
        let url = self.url("/api/orchestrator/composer-queue").unwrap();
        let request = self.request(method, &url);
        let response = request.send_json(body.clone()).map_err(|e| match e {
            ureq::Error::Status(code, response) => {
                let record: Value = Self::read(response).unwrap_or(Value::Null);
                let network_send = record.get("networkSend").cloned();
                let message = match network_send.as_ref().and_then(|r| r["status"].as_str()) {
                    Some("accepted") => {
                        "The bus accepted this message. Refresh its transcript; draft retained."
                            .to_owned()
                    }
                    Some("cancelled") => "This send was removed. Draft retained.".to_owned(),
                    Some("rejected") => format!(
                        "{} Draft retained.",
                        record["error"].as_str().unwrap_or("This send was refused.")
                    ),
                    _ => format!("Queue rejected the request (HTTP {code}). Draft retained."),
                };
                QueueError {
                    message,
                    status: Some(code),
                    network_send,
                }
            }
            _ => QueueError {
                message: "Delivery is unconfirmed. Retry checks the same message identity.".into(),
                status: None,
                network_send: None,
            },
        })?;
        Self::read(response).map_err(|message| QueueError {
            message,
            status: None,
            network_send: None,
        })
    }
    pub fn history(&self, id: &str) -> Result<History, String> {
        self.history_page(id, None)
    }
    /// The read behind opening a thread, recorded for Settings › Diagnostics.
    pub fn history_for_switch(&self, id: &str) -> Result<History, String> {
        let started = std::time::Instant::now();
        let (history, bytes) = self.history_counted(id, None)?;
        crate::switch_receipt::record(id, bytes, started.elapsed());
        Ok(history)
    }
    pub fn history_page(&self, id: &str, before: Option<&str>) -> Result<History, String> {
        self.history_counted(id, before).map(|(history, _)| history)
    }
    fn history_counted(&self, id: &str, before: Option<&str>) -> Result<(History, usize), String> {
        let key = if id.contains(':') {
            id.to_owned()
        } else {
            format!("llm-chat:{id}")
        };
        let mut query = vec![
            ("sessionKey", key.as_str()),
            ("limit", "100"),
            ("page", "1"),
        ];
        if let Some(before) = before {
            query.push(("before", before));
        }
        let (history, bytes): (History, usize) = self.get_counted("/api/mobile/history", &query)?;
        if history.session_key != key {
            return Err("Server returned history for a different session".into());
        }
        Ok((history, bytes))
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
