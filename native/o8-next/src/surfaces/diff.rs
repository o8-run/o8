use super::*;
use serde_json::Value;

pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((4, || Command::Diff)),
    ..Registration::new("", "Open diff for a packet", |s, _, window, cx| {
        s.notice = "This surface is not available in this build. The terminal and packet diff changes must land before the shell can open them.".into();
        s.palette = false;
        s.restore_focus(window, cx);
        cx.notify();
        None
    })
};

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
