use crate::client::Client;
use serde_json::Value;

impl Client {
    /// Branch-drift refusals use HTTP 409 and carry the actual gate card.
    pub fn pr_preview(&self, packet: &str) -> Result<Value, String> {
        let mut url = self.url("/api/orchestrator/merge-preview").unwrap();
        url.query_pairs_mut().append_pair("packetId", packet);
        let request = self.request("GET", &url);
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
        let url = self.url(path).map_err(|_| "Invalid PR route")?;
        let request = self.request("POST", &url);
        if request.header("Authorization").is_none() {
            return Err("An operator credential is required".into());
        }
        let response = request.send_json(body.clone());
        match response {
            Ok(response) => Self::read(response),
            Err(ureq::Error::Status(_, response)) => Self::read(response),
            Err(_) => Err("Delivery could not be confirmed".into()),
        }
    }
}
