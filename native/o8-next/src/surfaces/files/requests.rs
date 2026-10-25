//! Bounded file receipts; conflict bodies and oldContent may be arbitrarily large.
use crate::client::Client;
use serde_json::{Value, json};
use std::io::Read;

fn revision(value: &Value) -> bool {
    value.is_null()
        || value.as_str().is_some_and(|hash| {
            hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}
impl Client {
    fn file_snapshot(&self, body: &Value) -> Result<Value, String> {
        let path = body["path"].as_str().ok_or("Invalid file path")?;
        let workspace = body["workspace"].as_str().ok_or("Invalid workspace")?;
        self.get(
            "/api/panel/file-content",
            &[("path", path), ("workspace", workspace)],
        )
    }
    pub(crate) fn save_file(&self, body: &Value) -> Result<(u16, Value), String> {
        let url = self.url("/api/v2/files").unwrap();
        let request = self.request("POST", &url);
        let response = match request.send_json(body.clone()) {
            Ok(response) | Err(ureq::Error::Status(_, response)) => response,
            Err(_) => return Err("Save unconfirmed".into()),
        };
        let status = response.status();
        if status == 409 {
            // JSON object order is not a protocol guarantee. Read only a small
            // conflict response, then use the existing bounded read endpoint if
            // content precedes metadata or the response exceeds this budget.
            let small: Option<Value> =
                serde_json::from_reader(response.into_reader().take(16 * 1024)).ok();
            let hash = if let Some(data) = small.filter(|data| {
                data["error"] == "changed-on-disk" && data.get("contentHash").is_some_and(revision)
            }) {
                data["contentHash"].clone()
            } else {
                let current = self.file_snapshot(body)?;
                if !current["contentHash"].is_string() || !revision(&current["contentHash"]) {
                    return Err("Conflict revision unavailable. Draft retained.".into());
                }
                current["contentHash"].clone()
            };
            return Ok((
                status,
                json!({"error":"changed-on-disk","contentHash":hash}),
            ));
        }
        if (200..300).contains(&status) {
            // Success includes oldContent. Confirm the saved bounded bytes and
            // their revision instead of decoding the replaced file.
            drop(response);
            let current = self.file_snapshot(body)?;
            if current["content"] != body["content"]
                || current["truncated"] == true
                || current["binary"] == true
                || !current["contentHash"].is_string()
                || !revision(&current["contentHash"])
            {
                return Err("Saved bytes changed before confirmation. Draft retained.".into());
            }
            return Ok((
                status,
                json!({"success":true,"contentHash":current["contentHash"]}),
            ));
        }
        Ok((status, Self::read(response)?))
    }
}
