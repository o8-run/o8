pub use crate::shell::session::{QueueError, Session};
use serde::{Deserialize, de::DeserializeOwned};
use std::net::{IpAddr, SocketAddr};
use std::{io::Read, time::Duration};
use url::{Host, Url};

// Cold route compilation can outlast window creation. Bound the entire GET,
// including its response body, without extending mutation request deadlines.
pub(crate) const LOAD_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);

/// A stopped host blocks every request, and GPUI's test executor runs them one
/// after another, so a test that stops one shortens the budget while it lasts.
#[cfg(test)]
pub(crate) struct ShortLoadTimeout;
#[cfg(test)]
thread_local! {
    static SHORT_LOAD_TIMEOUT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
#[cfg(test)]
impl ShortLoadTimeout {
    pub(crate) fn start() -> Self {
        SHORT_LOAD_TIMEOUT.set(true);
        Self
    }
}
#[cfg(test)]
impl Drop for ShortLoadTimeout {
    fn drop(&mut self) {
        SHORT_LOAD_TIMEOUT.set(false);
    }
}
fn load_timeout() -> Duration {
    #[cfg(test)]
    if SHORT_LOAD_TIMEOUT.get() {
        return Duration::from_secs(2);
    }
    LOAD_REQUEST_TIMEOUT
}

fn timed_out(error: &(dyn std::error::Error + 'static)) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::TimedOut)
        || error.source().is_some_and(timed_out)
}

/// Backoff before the one retry of an idempotent GET.
pub(crate) const GET_RETRY_BACKOFF: Duration = Duration::from_millis(250);

/// Idempotent reads retry once after a refused or reset connection, so a briefly
/// busy server does not surface as an error row. HTTP status answers are final,
/// and a timeout has already spent the whole deadline, so neither is retried.
pub(crate) fn get_with_retry(
    mut call: impl FnMut() -> Result<ureq::Response, ureq::Error>,
) -> Result<ureq::Response, ureq::Error> {
    match call() {
        Err(error @ ureq::Error::Transport(_)) if timed_out(&error) => Err(error),
        Err(ureq::Error::Transport(_)) => {
            std::thread::sleep(GET_RETRY_BACKOFF);
            call()
        }
        other => other,
    }
}

/// A read failed because the server was slow or busy, not because it refused
/// the request or is gone. Surfaces keep their last good data.
pub(crate) fn transient(error: &str) -> bool {
    error.ends_with("Request timed out")
        || ["502", "503", "504"]
            .iter()
            .any(|code| error.ends_with(&format!("Server returned HTTP {code}")))
}

/// The stale line shown over last good data (classic AgentPanel's stale strip).
pub(crate) fn stale_notice(error: &str) -> String {
    let reason = error.rsplit(": ").next().unwrap_or(error);
    format!("Showing last loaded data · stale ({reason})")
}

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
        let response = get_with_retry(|| {
            self.request("GET", &url)
                .timeout(load_timeout())
                .call()
        })
        .map_err(|error| {
            let message = match &error {
                ureq::Error::Status(code, _) => format!("Server returned HTTP {code}"),
                _ if timed_out(&error) => "Request timed out".into(),
                _ => "Could not reach the selected server".into(),
            };
            format!("{}: {message}", url.path())
        })?;
        Self::read(response).map_err(|error| format!("{}: {error}", url.path()))
    }
    pub(crate) fn read<T: DeserializeOwned>(response: ureq::Response) -> Result<T, String> {
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                if timed_out(&error) {
                    "Request timed out"
                } else {
                    "Could not read history"
                }
            })?;
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
    #[test]
    fn transient_errors_are_stale_not_fatal() {
        assert!(super::transient("/api/panel/repos: Request timed out"));
        assert!(super::transient("/api/panel/repos: Server returned HTTP 503"));
        assert!(!super::transient("/api/panel/repos: Server returned HTTP 401"));
        assert_eq!(
            super::stale_notice("/api/panel/repos: Request timed out"),
            "Showing last loaded data · stale (Request timed out)"
        );
    }

    #[test]
    fn get_retries_once_after_a_dropped_connection_and_never_on_status() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            // First connection is dropped unanswered; the second gets JSON,
            // the third a 503 that must not be retried.
            let (first, _) = listener.accept().unwrap();
            drop(first);
            for body in ["HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
                         "HTTP/1.1 503 Busy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                stream.write_all(body.as_bytes()).unwrap();
            }
            listener.set_nonblocking(true).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(600));
            listener.accept().is_err()
        });
        let client = super::Client::new(&format!("http://127.0.0.1:{port}")).unwrap();
        let ok: serde_json::Value = client.get("/api/panel/repos", &[]).unwrap();
        assert_eq!(ok["ok"], true);
        assert!(client.get::<serde_json::Value>("/api/panel/repos", &[]).unwrap_err().contains("HTTP 503"));
        assert!(server.join().unwrap(), "a status answer was retried");
    }

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
