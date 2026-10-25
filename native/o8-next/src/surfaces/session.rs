use super::*;
use crate::{client::same_workspace, model::History};
use serde::Deserialize;
use serde_json::{Value, json};

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

// Request adapters compile with this surface through its existing shell entry.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
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
}
#[derive(Deserialize)]
struct Sessions {
    threads: Vec<Session>,
}
impl Session {
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
}

impl Client {
    pub fn sessions(&self) -> Result<Vec<Session>, String> {
        let mut sessions = self
            .get::<Sessions>("/api/mobile/orchestrator/threads", &[("limit", "500")])?
            .threads;
        let state: Value = self.get("/api/orchestrator/state", &[])?;
        for session in &mut sessions {
            if session.status == "busy" {
                session.status = "running".into();
            }
            let mut candidates = Vec::new();
            if let Some(packets) = state["mission"]["packets"].as_array() {
                for packet in packets.iter().filter(|p| {
                    p["orchestratorThreadId"] == session.id && p["status"] != "archived"
                }) {
                    let mut subject = session.clone();
                    subject.status = packet["status"].as_str().unwrap_or("idle").into();
                    subject.rejected = packet["review"]["approved"] == false;
                    subject.outcome =
                        (packet["releaseState"] == "released").then(|| "merged".into());
                    let timestamp = packet["releaseStatePayload"]["releasedAt"]
                        .as_str()
                        .or(packet["archivedAt"].as_str())
                        .or(packet["lastEventAt"].as_str())
                        .or(packet["lane"]["lastEventAt"].as_str())
                        .unwrap_or("")
                        .to_owned();
                    candidates.push((subject, timestamp));
                }
            }
            candidates.sort_by(|(a, at), (b, bt)| {
                crate::sidebar::rank(b)
                    .cmp(&crate::sidebar::rank(a))
                    .then_with(|| crate::sidebar::working(b).cmp(&crate::sidebar::working(a)))
                    .then_with(|| bt.cmp(at))
            });
            if let Some((subject, _)) = candidates.first() {
                session.status = subject.status.clone();
                session.rejected = subject.rejected;
                session.outcome = subject.outcome.clone();
            }
        }
        let inventory: Value = self.get("/api/runtime/inventory", &[("fresh", "1")])?;
        for agent in inventory["agents"].as_array().into_iter().flatten() {
            let Some(key) = agent["sessionKey"].as_str().filter(|key| key.contains(':')) else {
                continue;
            };
            if sessions.iter().any(|session| session.key() == key) {
                continue;
            }
            let packet_header = state["mission"]["packets"].as_array().and_then(|packets| packets.iter().find(|packet| packet["lane"]["sessionKey"] == key)).map(|packet| json!({
                "enabled":true,"title":packet["title"],"branch":packet["branchTarget"],"runtime":packet["runtime"],"status":packet["status"],"repo":packet["workspaceTargetPath"].as_str().and_then(|path| path.rsplit('/').find(|part| !part.is_empty())),"launchContext":packet["launchContext"]
            }));
            sessions.push(Session {
                tmux_session: agent["tmuxSession"].as_str().map(str::to_owned),
                id: key.into(),
                title: agent["name"].as_str().unwrap_or(key).into(),
                runtime: agent["runtime"].as_str().unwrap_or("").into(),
                status: agent["status"].as_str().unwrap_or("idle").into(),
                message_count: 0,
                last_message_at: agent["lastActivityAt"]
                    .as_i64()
                    .map(|time| format!("{time:020}"))
                    .unwrap_or_default(),
                repo_path: None,
                backend: None,
                outcome: None,
                rejected: false,
                unread: false,
                packet_header,
            });
        }
        if let Some(workspace) = self.workspace() {
            sessions.retain(|session| {
                session
                    .repo_path
                    .as_deref()
                    .is_some_and(|path| same_workspace(path, workspace))
            });
        }
        Ok(sessions)
    }
    pub fn context(&self, session: &Session) -> Result<Value, String> {
        let record: Value = self.get(
            "/api/v2/chat-history",
            &[("tabId", &session.id), ("limit", "100")],
        )?;
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
        let mut routing = json!({"backend":backend,"model":model,"effort":"medium","permissionMode":permission,"mode":"single","pickedMode":"solo","collide":false});
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
            ureq::Error::Status(code, _) => QueueError {
                message: format!("Queue rejected the request (HTTP {code}). Draft retained."),
                status: Some(code),
            },
            _ => QueueError {
                message: "Delivery is unconfirmed. Retry checks the same message identity.".into(),
                status: None,
            },
        })?;
        Self::read(response).map_err(|message| QueueError {
            message,
            status: None,
        })
    }
    pub fn history(&self, id: &str) -> Result<History, String> {
        self.history_page(id, None)
    }
    pub fn history_page(&self, id: &str, before: Option<&str>) -> Result<History, String> {
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
        let history: History = self.get("/api/mobile/history", &query)?;
        if history.session_key != key {
            return Err("Server returned history for a different session".into());
        }
        Ok(history)
    }
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
