use crate::{
    client::Client,
    diff::{self, Document, Response},
};
use serde_json::{Value, json};

impl Client {
    pub(crate) fn viewer_post(&self, path: &str, body: &Value) -> Result<Value, String> {
        let url = self.url(path).map_err(|_| "Invalid action route")?;
        let request = self.request("POST", &url);
        match request.send_json(body.clone()) {
            Ok(response) => {
                let mut data: Value = Self::read(response)?;
                crate::shell::commit::guard::scrub(&mut data);
                Ok(data)
            }
            Err(ureq::Error::Status(status, response)) => {
                let mut data: Value = Self::read(response).unwrap_or_default();
                crate::shell::commit::guard::scrub(&mut data);
                Err(format!(
                    "{} (HTTP {status})",
                    data["error"].as_str().unwrap_or("Action refused")
                ))
            }
            Err(_) => Err("Action unconfirmed. Inspect the workspace before retrying.".into()),
        }
    }
    pub(crate) fn commit_diff(
        &self,
        workspace: &str,
        hash: &str,
    ) -> Result<(Document, Value), String> {
        let data: Value = self.get(
            &format!("/api/panel/commits/{hash}"),
            &[("workspace", workspace)],
        )?;
        if !data["commit"].is_object() {
            return Err("Commit unavailable".into());
        }
        let response: Response = serde_json::from_value(
            json!({"diff":data["commit"]["diff"],"headSha":data["commit"]["hash"]}),
        )
        .map_err(|_| "Invalid commit diff")?;
        if crate::shell::commit::guard::sensitive(&response.diff) {
            return Err("Sensitive patch hidden. Read-only.".into());
        }
        if response.error.is_some() {
            return Err("Diff unavailable. Refresh the selected target.".into());
        }
        if response.head_sha.len() != 40
            || !response.head_sha.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Diff has no verifiable HEAD. Review is disabled.".into());
        }
        // Keep pathological single-line patches off the text shaper. Retain the
        // raw patch for identity, and refuse copy/merge of this bounded preview.
        let long_line = response.diff.lines().any(|line| line.len() > 16384);
        let preview = long_line.then(|| {
            response
                .diff
                .lines()
                .map(|line| {
                    if line.len() > 16384 {
                        line.chars().take(4096).collect::<String>() + " …"
                    } else {
                        line.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        });
        let mut document = diff::parse(preview.as_deref().unwrap_or(&response.diff));
        document.head = response.head_sha;
        document.truncated = response.truncated || long_line;
        document.revision = response.revision;
        document.source = response.diff;
        Ok((document, Value::Null))
    }
}
