use crate::model::History;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::net::{IpAddr, SocketAddr};
use std::{io::Read, time::Duration};
use url::{Host, Url};

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
        if let (Some(header), Some(entry)) = (&self.packet_header, history.transcript.first_mut()) {
            if entry.role == "user" {
                entry.extra.insert("packetHeader".into(), header.clone());
            }
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsInfo {
    ws_port: u16,
    ws_token: String,
}
#[derive(Debug)]
pub struct QueueError {
    pub message: String,
    pub status: Option<u16>,
}

#[derive(Clone)]
pub struct Client {
    origin: Url,
    agent: ureq::Agent,
    token: Option<String>,
    desktop_session: Option<String>,
    workspace: Option<String>,
}
impl Client {
    pub fn new(origin: &str) -> Result<Self, String> {
        Self::authenticated(origin, std::env::var("O8_NEXT_API_TOKEN").ok())?
            .with_desktop_session(std::env::var("O8_NEXT_CLERK_SESSION_TOKEN").ok())
    }
    pub fn authenticated(origin: &str, token: Option<String>) -> Result<Self, String> {
        if token
            .as_ref()
            .is_some_and(|s| s.chars().any(char::is_control))
        {
            return Err("Invalid API credential format".into());
        }
        let origin = Url::parse(origin).map_err(|_| "Invalid server URL")?;
        let loopback = match origin.host() {
            Some(Host::Ipv4(ip)) => ip.is_loopback(),
            Some(Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
        if origin.scheme() != "http"
            || !loopback
            || origin.port().is_none()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
            || !origin.username().is_empty()
            || origin.password().is_some()
        {
            return Err("Use an explicit http://127.0.0.1:PORT or http://[::1]:PORT origin".into());
        }
        Ok(Self {
            origin,
            workspace: None,
            token: token.filter(|s| !s.trim().is_empty()),
            desktop_session: None,
            agent: ureq::AgentBuilder::new()
                .redirects(0)
                .try_proxy_from_env(false)
                .timeout(Duration::from_secs(5))
                .build(),
        })
    }
    /// Explicit short-lived desktop identity for the selected server; never discovered or persisted.
    pub fn with_desktop_session(mut self, session: Option<String>) -> Result<Self, String> {
        if session.as_ref().is_some_and(|s| {
            s.len() > 16 * 1024 || !s.is_ascii() || s.chars().any(char::is_control)
        }) {
            return Err("Invalid desktop session credential format".into());
        }
        self.desktop_session = session.filter(|s| !s.trim().is_empty());
        Ok(self)
    }
    pub(crate) fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T, String> {
        let mut url = self.origin.join(path).map_err(|_| "Invalid route")?;
        url.query_pairs_mut().extend_pairs(query.iter().copied());
        let mut request = self.agent.get(url.as_str());
        if let Some(token) = &self.token {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        let response = request.call().map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("Server returned HTTP {code}"),
            _ => "Could not reach the selected server".into(),
        })?;
        Self::read(response)
    }
    fn read<T: DeserializeOwned>(response: ureq::Response) -> Result<T, String> {
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read history")?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("History response exceeds 16 MiB".into());
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| "Server returned an invalid transcript response".into())
    }
    pub fn in_workspace(&self, workspace: &str) -> Self {
        let mut client = self.clone();
        client.workspace = Some(workspace.into());
        client
    }
    /// Settings shares the existing operator bearer, loopback policy, redirect
    /// refusal, timeout and response bound. No credential response is retained.
    pub(crate) fn settings_request<T: DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: Value,
    ) -> Result<T, crate::settings::RequestError> {
        use crate::settings::RequestError;
        let url = self.origin.join(path).map_err(|_| RequestError {
            status: None,
            message: "Invalid settings route".into(),
        })?;
        let mut request = self.agent.request(method, url.as_str());
        if let Some(token) = &self.token {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        let response = if method == "GET" {
            request.call()
        } else {
            request.send_json(body)
        };
        match response {
            Ok(response) => Self::read(response).map_err(|_| RequestError {
                status: None,
                message: "Invalid settings response. Refresh before trying again.".into(),
            }),
            Err(ureq::Error::Status(status, response)) => {
                #[derive(Deserialize)]
                struct ErrorBody {
                    error: String,
                }
                let detail = Self::read::<ErrorBody>(response).ok().map(|v| v.error);
                let message = if path.starts_with("/api/v2/keys") {
                    // Credential endpoints may include provider text. Only fixed
                    // route refusals may reach UI; never echo supplied key data.
                    match detail.as_deref() {
                        Some(
                            "Invalid API key"
                            | "Key cannot be empty"
                            | "No OpenRouter key is connected"
                            | "Turn the OpenRouter connection on before checking it",
                        ) => detail.unwrap(),
                        _ => format!(
                            "Key action refused (HTTP {status}). Previous keys were preserved."
                        ),
                    }
                } else {
                    detail.unwrap_or_else(|| format!("Settings request refused (HTTP {status})."))
                };
                Err(RequestError {
                    status: Some(status),
                    message,
                })
            }
            Err(_) => Err(RequestError {
                status: None,
                message: "The result is unconfirmed. Refresh settings before trying again.".into(),
            }),
        }
    }
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
        if let Some(workspace) = &self.workspace {
            sessions.retain(|session| session.repo_path.as_ref() == Some(workspace));
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
    pub fn mutate_queue(&self, method: &str, body: &Value) -> Result<Value, QueueError> {
        let url = self
            .origin
            .join("/api/orchestrator/composer-queue")
            .unwrap();
        let mut request = self.agent.request(method, url.as_str());
        if let Some(token) = &self.token {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
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
    pub fn review_state(&self, packet: &str) -> Result<Value, String> {
        self.get("/api/orchestrator/review-state", &[("packetId", packet)])
    }
    /// The desktop Inbox's decision endpoint owns principal checks and durable resolution.
    pub fn inbox_decision(&self, id: &str, approve: bool) -> Result<Value, String> {
        let url = self.origin.join("/api/panel/approvals").unwrap();
        let mut request = self.agent.post(url.as_str());
        if let Some(token) = &self.token {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        if let Some(session) = &self.desktop_session {
            request = request.set("x-clerk-session-token", session);
        }
        match request.send_json(json!({"id":id,"action":if approve {"approve"} else {"reject"}})) {
            Ok(response) => {
                let body: Value = Self::read(response)?;
                if body["ok"] == false {
                    return Err(body["error"].as_str().or(body["note"].as_str()).unwrap_or("Approval could not be resolved").into());
                }
                Ok(body)
            }
            Err(ureq::Error::Status(status, response)) => {
                let body = Self::read::<Value>(response).unwrap_or_default();
                Err(body["error"].as_str().or(body["note"].as_str())
                    .map(|message| format!("{message} (HTTP {status})")).unwrap_or_else(|| format!("Approval refused (HTTP {status})")))
            }
            Err(_) => Err("Decision unconfirmed. Refresh to inspect the recorded approval before another action.".into()),
        }
    }
    pub fn review(&self, body: &Value) -> Result<Value, String> {
        let url = self.origin.join("/api/orchestrator/review").unwrap();
        let mut request = self.agent.post(url.as_str());
        if let Some(token) = &self.token {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
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
    /// Same credential/port response used by web reconnect recovery. The native
    /// process never reads a token file or resolves installed-app configuration.
    pub fn websocket(&self) -> Result<(Url, SocketAddr), String> {
        let info: WsInfo = self.get("/api/panel/ws-info", &[])?;
        if info.ws_port == 0 || info.ws_token.is_empty() || info.ws_token.len() > 4096 {
            return Err("Invalid WebSocket information".into());
        }
        let ip = match self.origin.host().unwrap() {
            Host::Ipv4(ip) => IpAddr::V4(ip),
            Host::Ipv6(ip) => IpAddr::V6(ip),
            _ => unreachable!(),
        };
        let mut url = self.origin.join("/ws").unwrap();
        url.set_scheme("ws").unwrap();
        url.set_port(Some(info.ws_port)).unwrap();
        url.query_pairs_mut().append_pair("token", &info.ws_token);
        Ok((url, SocketAddr::new(ip, info.ws_port)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_loopback_only() {
        for s in [
            "http://example.com:3000",
            "http://localhost:3000",
            "http://127.0.0.1",
            "http://127.0.0.1:3000/other",
            "http://x@127.0.0.1:3000",
            "http://127.0.0.1:3000?token=secret",
            "https://127.0.0.1:3000",
        ] {
            assert!(Client::new(s).is_err(), "{s}");
        }
        assert!(Client::new("http://127.0.0.1:32000").is_ok());
        assert!(Client::new("http://[::1]:32000").is_ok());
    }
}

#[path = "brain_transport.rs"]
mod brain_transport;
