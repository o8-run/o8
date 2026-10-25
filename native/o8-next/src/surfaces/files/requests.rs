use crate::client::Client;
use serde_json::Value;

impl Client {
    pub(crate) fn save_file(&self, body: &Value) -> Result<(u16, Value), String> {
        let url = self.url("/api/v2/files").unwrap();
        let request = self.request("POST", &url);
        let response = match request.send_json(body.clone()) {
            Ok(response) | Err(ureq::Error::Status(_, response)) => response,
            Err(_) => return Err("Save unconfirmed".into()),
        };
        let status = response.status();
        Ok((status, Self::read(response)?))
    }
}
