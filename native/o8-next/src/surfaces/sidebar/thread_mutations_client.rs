//! Production rail mutation dispatch, shared with the HTTP contract harness.
use crate::client::Client;
use serde_json::{Value, json};

pub(crate) enum WorkspaceRestoreOutcome {
    Restored,
    Refused(String),
    Unconfirmed(String),
}

impl Client {
    /// Existing workspace control API, with the same identity retained after an uncertain response.
    pub(crate) fn restore_sidebar_workspace(&self, workspace: Option<&str>, packet: &str, mutation: &str) -> WorkspaceRestoreOutcome {
        let Some(workspace) = workspace.filter(|path| std::path::Path::new(path).is_absolute()) else {
            return WorkspaceRestoreOutcome::Refused("Select a workspace before restoring it.".into());
        };
        let client = self.in_workspace(workspace);
        let mut url = client.url("/api/orchestrator/workspace").unwrap();
        url.query_pairs_mut().append_pair("workspace", workspace);
        let sent = client.request("POST", &url).send_json(json!({
            "action": "restore", "packetId": packet, "clientMutationId": mutation,
        }));
        let (status, response) = match sent {
            Ok(response) => (response.status(), response),
            Err(ureq::Error::Status(status, response)) => (status, response),
            Err(_) => return WorkspaceRestoreOutcome::Unconfirmed("Workspace Restore is unconfirmed. Retry keeps the same action identity.".into()),
        };
        let Ok(body) = Self::read::<Value>(response) else {
            return WorkspaceRestoreOutcome::Unconfirmed("Workspace Restore response was unreadable. Retry keeps the same action identity.".into());
        };
        if body["ok"] == true && matches!(body["result"]["status"].as_str(), Some("restored" | "already_materialized")) {
            return WorkspaceRestoreOutcome::Restored;
        }
        let note = body["error"]["message"].as_str().or(body["result"]["note"].as_str())
            .unwrap_or("Workspace Restore was not confirmed.").to_owned();
        if status >= 500 || body["result"]["outcomeUnknown"] == true || body["result"]["inProgress"] == true {
            WorkspaceRestoreOutcome::Unconfirmed(note)
        } else { WorkspaceRestoreOutcome::Refused(note) }
    }

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
        let regenerate = body["regenerateTitle"] == true;
        let request = self.request("PATCH", &url);
        let response = request.send_json(body).map_err(|error| match error {
            ureq::Error::Status(code, _) => update_rejected(regenerate, code),
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
        let extra = order_key.map_or(Value::Null, |key| json!({ "orderKey": key }));
        self.inbox_preference_with(workspace, id, action, extra, revision)
    }
    /// Turns this thread's auto-settle on or off (`auto-settle`, `enabled`).
    pub(crate) fn inbox_auto_settle(
        &self,
        workspace: Option<&str>,
        id: &str,
        enabled: bool,
        revision: u64,
    ) -> Result<Value, String> {
        self.inbox_preference_with(workspace, id, "auto-settle", json!({ "enabled": enabled }), revision)
    }
    fn inbox_preference_with(
        &self,
        workspace: Option<&str>,
        id: &str,
        action: &str,
        extra: Value,
        revision: u64,
    ) -> Result<Value, String> {
        let workspace = workspace
            .filter(|path| std::path::Path::new(path).is_absolute())
            .ok_or("Select a workspace before changing this session.")?;
        let mut url = self.url("/api/v2/chat-history").unwrap();
        url.query_pairs_mut().append_pair("workspace", workspace);
        let key = if id.contains(':') { "sessionKey" } else { "tabId" };
        let mut body = json!({ key: id, "inboxAction": action, "inboxRevision": revision });
        if let Value::Object(extra) = extra {
            for (key, value) in extra {
                body[key] = value;
            }
        }
        let request = self.in_workspace(workspace).request("PATCH", &url);
        let response = request.send_json(body).map_err(|error| match error {
            ureq::Error::Status(409, response) => response
                .into_json::<Value>()
                .ok()
                .and_then(|body| body["error"].as_str().map(str::to_owned))
                .unwrap_or_else(|| "This thread changed. Refresh and try again.".into()),
            ureq::Error::Status(404, _) => "This thread is no longer available.".into(),
            ureq::Error::Status(code, _) => preference_failed(action, Some(code)),
            _ => preference_failed(action, None),
        })?;
        let result: Value = Self::read(response)?;
        if result["ok"] != true {
            return Err(preference_failed(action, None));
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

/// A title regenerate that the server cannot do yet is a normal outcome, not a
/// status code to show.
fn update_rejected(regenerate: bool, code: u16) -> String {
    if regenerate && code == 409 {
        "Can't regenerate the title right now.".into()
    } else {
        format!("Thread update rejected (HTTP {code}).")
    }
}

fn preference_failed(action: &str, code: Option<u16>) -> String {
    match (action, code) {
        ("auto-settle", _) => "Couldn't save auto-settle for this thread.".into(),
        (_, Some(code)) => format!("Pin rejected (HTTP {code})."),
        (_, None) => "Pin is unconfirmed. Refresh before retrying.".into(),
    }
}

#[cfg(test)]
mod copy_tests {
    use super::{preference_failed, update_rejected};

    #[test]
    fn a_title_conflict_reads_as_plain_copy_and_others_keep_their_status() {
        assert_eq!(update_rejected(true, 409), "Can't regenerate the title right now.");
        assert_eq!(update_rejected(true, 500), "Thread update rejected (HTTP 500).");
        assert_eq!(update_rejected(false, 409), "Thread update rejected (HTTP 409).");
    }

    #[test]
    fn auto_settle_failures_do_not_talk_about_pins() {
        let copy = "Couldn't save auto-settle for this thread.";
        assert_eq!(preference_failed("auto-settle", Some(500)), copy);
        assert_eq!(preference_failed("auto-settle", None), copy);
        assert_eq!(preference_failed("pin", Some(500)), "Pin rejected (HTTP 500).");
    }
}
