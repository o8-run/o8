//! One reconnect authority for retained views; route policy stays in each surface.
#[path = "../../client.rs"]
mod transport;
use serde::de::DeserializeOwned;
use std::{
    net::SocketAddr,
    sync::{Arc, RwLock},
};
pub(crate) use transport::same_workspace;
pub use transport::{QueueError, Session};
use url::Url;

#[derive(Clone)]
pub struct Client {
    transport: Arc<RwLock<transport::Client>>,
    workspace: Option<String>,
    desktop_session: Option<String>,
    wake: Option<async_channel::Sender<()>>,
}
impl Client {
    pub fn new(origin: &str) -> Result<Self, String> {
        Self::authenticated(origin, std::env::var("O8_NEXT_API_TOKEN").ok())?
            .with_desktop_session(std::env::var("O8_NEXT_CLERK_SESSION_TOKEN").ok())
    }
    pub fn authenticated(origin: &str, token: Option<String>) -> Result<Self, String> {
        Ok(Self {
            transport: Arc::new(RwLock::new(transport::Client::authenticated(
                origin, token,
            )?)),
            workspace: None,
            desktop_session: None,
            wake: None,
        })
    }
    fn snapshot(&self) -> transport::Client {
        let client = self
            .transport
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        match &self.wake {
            Some(wake) => client.with_wakeup(wake.clone()),
            None => client,
        }
    }
    pub(crate) fn with_wakeup(mut self, wake: async_channel::Sender<()>) -> Self {
        self.wake = Some(wake);
        self
    }
    pub(crate) fn wake(&self) {
        self.snapshot().wake();
    }
    pub(crate) fn refresh_bearer(&self, token: Option<String>) -> Result<(), String> {
        let origin = self.url("/").map_err(|_| "Invalid server URL")?;
        let replacement = transport::Client::authenticated(origin.as_str(), token);
        let (replacement, result) = match replacement {
            Ok(client) => (client, Ok(())),
            Err(error) => (
                transport::Client::authenticated(origin.as_str(), None)?,
                Err(error),
            ),
        };
        *self
            .transport
            .write()
            .unwrap_or_else(|error| error.into_inner()) = replacement;
        result
    }
    pub fn with_desktop_session(mut self, session: Option<String>) -> Result<Self, String> {
        self.snapshot().with_desktop_session(session.clone())?;
        self.desktop_session = session.filter(|value| !value.trim().is_empty());
        Ok(self)
    }
    pub(crate) fn url(&self, path: &str) -> Result<Url, url::ParseError> {
        self.transport
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .url(path)
    }
    pub(crate) fn request(&self, method: &str, url: &Url) -> ureq::Request {
        self.transport
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .request(method, url)
    }
    pub(crate) fn with_desktop_identity(&self, request: ureq::Request) -> ureq::Request {
        self.snapshot()
            .with_desktop_session(self.desktop_session.clone())
            .expect("desktop session was validated before retention")
            .with_desktop_identity(request)
    }
    pub(crate) fn workspace(&self) -> Option<&str> {
        self.workspace.as_deref()
    }
    pub(crate) fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T, String> {
        // Do not hold a refresh lock across network I/O.
        self.snapshot().get(path, query)
    }
    pub(crate) fn read<T: DeserializeOwned>(response: ureq::Response) -> Result<T, String> {
        transport::Client::read(response)
    }
    pub fn in_workspace(&self, workspace: &str) -> Self {
        let mut client = self.clone();
        client.workspace = Some(workspace.into());
        client
    }
    pub fn websocket(&self) -> Result<(Url, SocketAddr), String> {
        self.snapshot().websocket()
    }
}
