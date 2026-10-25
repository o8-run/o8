use crate::client::Client;
use serde_json::Value;

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
