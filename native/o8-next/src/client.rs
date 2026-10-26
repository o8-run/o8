pub use crate::shell::session::{QueueError, Session};
use serde::{Deserialize, de::DeserializeOwned};
use std::net::{IpAddr, SocketAddr};
use std::{io::Read, time::Duration};
use url::{Host, Url};

pub(crate) fn same_workspace(a: &str, b: &str) -> bool {
    a == b
        || matches!((std::fs::canonicalize(a), std::fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsInfo {
    ws_port: u16,
    ws_token: String,
}
#[derive(Clone)]
pub struct Client {
    origin: Url,
    agent: ureq::Agent,
    token: Option<String>,
    desktop_session: Option<String>,
    workspace: Option<String>,
    wake: Option<async_channel::Sender<()>>,
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
            wake: None,
            token: token.filter(|s| !s.trim().is_empty()),
            desktop_session: None,
            agent: ureq::AgentBuilder::new()
                .redirects(0)
                .try_proxy_from_env(false)
                .timeout(Duration::from_secs(5))
                .build(),
        })
    }
    pub(crate) fn with_wakeup(mut self, wake: async_channel::Sender<()>) -> Self {
        self.wake = Some(wake);
        self
    }

    pub(crate) fn wake(&self) {
        if let Some(sender) = &self.wake {
            let _ = sender.try_send(());
        }
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
    /// Build a route URL without deciding a surface's query or error policy.
    pub(crate) fn url(&self, path: &str) -> Result<Url, url::ParseError> {
        self.origin.join(path)
    }
    /// Shared operator bearer, agent timeout and redirect policy for surface adapters.
    pub(crate) fn request(&self, method: &str, url: &Url) -> ureq::Request {
        let request = self.agent.request(method, url.as_str());
        if let Some(token) = &self.token {
            request.set("Authorization", &format!("Bearer {token}"))
        } else {
            request
        }
    }
    /// Desktop account identity is opt-in for the endpoints that already require it.
    pub(crate) fn with_desktop_identity(&self, request: ureq::Request) -> ureq::Request {
        if let Some(session) = &self.desktop_session {
            request.set("x-clerk-session-token", session)
        } else {
            request
        }
    }
    pub(crate) fn workspace(&self) -> Option<&str> {
        self.workspace.as_deref()
    }
    pub(crate) fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T, String> {
        let mut url = self.url(path).map_err(|_| "Invalid route")?;
        url.query_pairs_mut().extend_pairs(query.iter().copied());
        let request = self.request("GET", &url);
        let response = request.call().map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("Server returned HTTP {code}"),
            _ => "Could not reach the selected server".into(),
        })?;
        Self::read(response)
    }
    pub(crate) fn read<T: DeserializeOwned>(response: ureq::Response) -> Result<T, String> {
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
