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
    /// Settle or un-settle through the inbox contract: a chat by `tabId`, a
    /// worker by `sessionKey`, and no other fields. Returns the new state.
    pub(crate) fn inbox_action(
        &self,
        workspace: Option<&str>,
        id: &str,
        action: &str,
    ) -> Result<Value, String> {
        let workspace = workspace
            .filter(|path| std::path::Path::new(path).is_absolute())
            .ok_or("Select a workspace before changing this session.")?;
        let mut url = self.url("/api/v2/chat-history").unwrap();
        url.query_pairs_mut().append_pair("workspace", workspace);
        let mut body = json!({"inboxAction": action});
        let key = if id.contains(':') {
            "sessionKey"
        } else {
            "tabId"
        };
        body[key] = json!(id);
        let request = self.in_workspace(workspace).request("PATCH", &url);
        let response = request.send_json(body).map_err(|error| match error {
            // The server names what holds the thread open: a run, a
            // queued message or a child worker.
            ureq::Error::Status(409, response) => response
                .into_json::<Value>()
                .ok()
                .and_then(|body| body["error"].as_str().map(str::to_owned))
                .unwrap_or_else(|| "This thread is still working.".into()),
            ureq::Error::Status(404, _) => "This thread is no longer available.".into(),
            ureq::Error::Status(code, _) => format!("Settle rejected (HTTP {code})."),
            _ => "Settle is unconfirmed. Refresh before retrying.".into(),
        })?;
        let result: Value = Self::read(response)?;
        if result["ok"] != true {
            return Err("Settle was not confirmed.".into());
        }
        Ok(result)
    }
    /// Pin or unpin through the inbox preference contract (#5141), quoting
    /// the revision the row was drawn from so a stale pin is refused.
    pub(crate) fn inbox_pin(
        &self,
        workspace: Option<&str>,
        id: &str,
        pin: bool,
        revision: u64,
    ) -> Result<Value, String> {
        self.inbox_preference(workspace, id, if pin { "pin" } else { "unpin" }, None, revision)
    }
    /// Writes one inbox preference action (`pin`, `unpin`, `pin-reorder`),
    /// with an order key where the action takes one.
    pub(crate) fn inbox_preference(
        &self,
        workspace: Option<&str>,
        id: &str,
        action: &str,
        order_key: Option<&str>,
        revision: u64,
    ) -> Result<Value, String> {
        let workspace = workspace
            .filter(|path| std::path::Path::new(path).is_absolute())
            .ok_or("Select a workspace before changing this session.")?;
        let mut url = self.url("/api/v2/chat-history").unwrap();
        url.query_pairs_mut().append_pair("workspace", workspace);
        let key = if id.contains(':') { "sessionKey" } else { "tabId" };
        let mut body = json!({ key: id, "inboxAction": action, "inboxRevision": revision });
        if let Some(order_key) = order_key {
            body["orderKey"] = json!(order_key);
        }
        let request = self.in_workspace(workspace).request("PATCH", &url);
        let response = request.send_json(body).map_err(|error| match error {
            ureq::Error::Status(409, response) => response
                .into_json::<Value>()
                .ok()
                .and_then(|body| body["error"].as_str().map(str::to_owned))
                .unwrap_or_else(|| "This thread changed. Refresh and try again.".into()),
            ureq::Error::Status(404, _) => "This thread is no longer available.".into(),
            ureq::Error::Status(code, _) => format!("Pin rejected (HTTP {code})."),
            _ => "Pin is unconfirmed. Refresh before retrying.".into(),
        })?;
        let result: Value = Self::read(response)?;
        if result["ok"] != true {
            return Err("Pin was not confirmed.".into());
        }
        Ok(result)
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
