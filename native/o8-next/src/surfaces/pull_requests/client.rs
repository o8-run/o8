use super::*;
use serde_json::Value;

impl Client {
    /// Branch-drift refusals use HTTP 409 and carry the actual gate card.
    pub fn pr_preview(&self, packet: &str) -> Result<Value, String> {
        let url = self.origin.join("/api/orchestrator/merge-preview").unwrap();
        let mut request = self.agent.get(url.as_str()).query("packetId", packet);
        if let Some(token) = &self.token {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        let (value, refused): (Value, bool) = match request.call() {
            Ok(response) => (Self::read(response)?, false),
            Err(ureq::Error::Status(409, response)) => (Self::read(response)?, true),
            Err(ureq::Error::Status(code, _)) => {
                return Err(format!("Merge preview returned HTTP {code}"));
            }
            Err(_) => return Err("Could not read merge preview".into()),
        };
        if value["packetId"] != packet
            || !value["wouldMerge"].is_boolean()
            || !value["checks"].is_array()
            || !value["blockers"].is_array()
            || (refused && value["wouldMerge"] != false)
        {
            return Err("Merge preview did not confirm the selected packet".into());
        }
        Ok(value)
    }
    /// PR writes have no automatic retry: even an HTTP error may follow a side effect.
    pub fn pr_post(&self, path: &str, body: &Value) -> Result<Value, String> {
        let url = self.origin.join(path).map_err(|_| "Invalid PR route")?;
        let token = self
            .token
            .as_ref()
            .ok_or("An operator credential is required")?;
        let response = self
            .agent
            .post(url.as_str())
            .set("Authorization", &format!("Bearer {token}"))
            .send_json(body.clone());
        match response {
            Ok(response) => Self::read(response),
            Err(ureq::Error::Status(_, response)) => Self::read(response),
            Err(_) => Err("Delivery could not be confirmed".into()),
        }
    }
}
