//! Production rail mutation dispatch, shared with the HTTP contract harness.
use crate::client::Client;
use serde_json::{Value, json};

impl Client {
    pub(crate) fn mutate_sidebar(
        &self,
        workspace: Option<&str>,
        id: &str,
        patch: Value,
    ) -> Result<(), String> {
        let workspace = workspace
            .filter(|path| std::path::Path::new(path).is_absolute())
            .ok_or("Select a workspace before changing this session.")?;
        let client = self.in_workspace(workspace);
        if id.contains(':') {
            client.archive_worker(
                id,
                patch["clientMutationId"]
                    .as_str()
                    .ok_or("Archive identity is required.")?,
            )
        } else {
            client.patch_thread(id, patch)
        }
    }
    pub(crate) fn patch_thread(&self, id: &str, patch: Value) -> Result<(), String> {
        let mut body = patch;
        body["tabId"] = json!(id);
        self.patch_metadata(body)
    }
    pub(crate) fn patch_metadata(&self, body: Value) -> Result<(), String> {
        let mut url = self.url("/api/v2/chat-history").unwrap();
        if let Some(workspace) = self.workspace() {
            url.query_pairs_mut().append_pair("workspace", workspace);
        }
        let request = self.request("PATCH", &url);
        let response = request.send_json(body).map_err(|error| match error {
            ureq::Error::Status(code, _) => format!("Thread update rejected (HTTP {code})."),
            _ => "Thread update is unconfirmed. Refresh before retrying.".into(),
        })?;
        let result: Value = Self::read(response)?;
        if result["ok"] != true {
            return Err("Thread update was not confirmed.".into());
        }
        Ok(())
    }
    pub(crate) fn archive_worker(&self, id: &str, mutation: &str) -> Result<(), String> {
        let mut url = self.url("/api/runtime/archive").unwrap();
        let workspace = self
            .workspace()
            .filter(|path| std::path::Path::new(path).is_absolute())
            .ok_or("Select a workspace before archiving this session.")?;
        url.query_pairs_mut().append_pair("workspace", workspace);
        let request = self.request("POST", &url);
        let response = request
            .send_json(json!({"sessionKey":id,"clientMutationId":mutation}))
            .map_err(|error| match error {
                ureq::Error::Status(code, _) => format!("Worker archive rejected (HTTP {code})."),
                _ => {
                    "Worker archive is unconfirmed. Retry retains the same action identity.".into()
                }
            })?;
        let result: Value = Self::read(response)?;
        if result["ok"] != true || result["archived"] != true {
            return Err(
                "Worker archive is not confirmed. Retry retains the same action identity.".into(),
            );
        }
        Ok(())
    }
}
