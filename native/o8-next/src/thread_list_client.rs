//! Existing desktop metadata mutations and archive listing, using the same
//! explicit loopback authority and bounded HTTP reader as the session client.
use crate::client::{Client, Session};
use serde_json::{Value, json};
use std::collections::HashSet;

impl Client {
    pub(crate) fn search_thread_ids(&self, query: &str) -> Result<HashSet<String>, String> {
        let response: Value = self.get(
            "/api/v2/chat-history/list",
            &[
                ("include", "orchestrator"),
                ("archived", "include"),
                ("q", query),
            ],
        )?;
        let records = response["conversations"]
            .as_array()
            .ok_or("Invalid message search response")?;
        Ok(records
            .iter()
            .filter_map(|record| record["tabId"].as_str().map(str::to_owned))
            .collect())
    }
    pub(crate) fn sidebar_workers(&self) -> Result<Vec<Session>, String> {
        let inventory: Value = self.get("/api/runtime/inventory", &[("fresh", "1")])?;
        inventory["agents"].as_array().into_iter().flatten().filter_map(|agent| {
            let key = agent["sessionKey"].as_str().filter(|key| key.contains(':'))?;
            Some(serde_json::from_value(json!({"id":key,"title":agent["name"].as_str().unwrap_or("Worker"),
                "status":agent["status"].as_str().unwrap_or("idle"),"runtime":agent["runtime"],
                "repoPath":agent["workspace"],"lastMessageAt":agent["lastActivityAt"].as_i64().map(|t| format!("{t:020}")).unwrap_or_default()
            })).map_err(|_| "Invalid worker inventory".to_string()))
        }).collect()
    }
    pub(crate) fn sidebar_sessions(&self) -> Result<Vec<Session>, String> {
        let mut sessions = self.sessions()?;
        let archived: Value = self.get(
            "/api/v2/chat-history/list",
            &[("include", "orchestrator"), ("archived", "only")],
        )?;
        for record in archived["conversations"].as_array().into_iter().flatten() {
            let Some(id) = record["tabId"].as_str() else {
                continue;
            };
            if sessions.iter().any(|s| s.id == id) {
                continue;
            }
            sessions.push(
                serde_json::from_value(json!({
                    "id": id, "title": record["title"], "status": "archived",
                    "runtime": record["backend"].as_str().unwrap_or(""),
                    "repoPath": record["repoPath"], "backend": record["backend"],
                    "lastMessageAt": record["modifiedAt"], "messageCount": record["messageCount"]
                }))
                .map_err(|_| "Invalid archived thread")?,
            );
        }
        Ok(sessions)
    }
    pub(crate) fn patch_thread(&self, id: &str, patch: Value) -> Result<(), String> {
        let mut body = patch;
        body["tabId"] = json!(id);
        self.patch_metadata(body)
    }
}
