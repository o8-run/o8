//! Existing desktop metadata mutations and archive listing, using the same
//! explicit loopback authority and bounded HTTP reader as the session client.
use crate::client::{Client, Session, same_workspace};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

#[derive(Deserialize)]
struct Sessions {
    threads: Vec<Session>,
}
impl Client {
    pub(crate) fn sidebar_threads(&self) -> Result<Vec<Session>, String> {
        self.sidebar_threads_with_state()
            .map(|(sessions, _)| sessions)
    }
    fn sidebar_threads_with_state(&self) -> Result<(Vec<Session>, Value), String> {
        let mut sessions = Vec::new();
        let mut seen = HashSet::new();
        let mut offset = 0;
        let mut overlap = false;
        loop {
            let query_offset = offset.to_string();
            let page = self
                .get::<Sessions>(
                    "/api/mobile/orchestrator/threads",
                    &[("limit", "500"), ("offset", &query_offset)],
                )?
                .threads;
            let done = page.len() < 500;
            // Recency updates can move the boundary between requests. Consume
            // the raw page size, rather than the number of unique rows kept.
            offset += page.len();
            let before = sessions.len();
            for row in page {
                if seen.insert(row.id.clone()) {
                    sessions.push(row);
                } else {
                    overlap = true;
                }
            }
            // Keep available rows if an older host repeats a complete page.
            if done || sessions.len() == before {
                break;
            }
        }
        if overlap {
            // A not-yet-read chat may have jumped ahead of the first page.
            // One bounded head refresh recovers it and its latest summary.
            for row in self
                .get::<Sessions>(
                    "/api/mobile/orchestrator/threads",
                    &[("limit", "500"), ("offset", "0")],
                )?
                .threads
            {
                if let Some(old) = sessions.iter_mut().find(|old| old.id == row.id) {
                    *old = row;
                } else {
                    sessions.push(row);
                }
            }
            sessions.sort_by(|a, b| b.last_message_at.cmp(&a.last_message_at));
        }
        let state: Value = self.get("/api/orchestrator/state", &[])?;
        for session in &mut sessions {
            session.title = crate::text::sanitize(&session.title);
            if session.status == "busy" {
                session.status = "running".into();
            }
            let mut candidates = Vec::new();
            if let Some(packets) = state["mission"]["packets"].as_array() {
                for packet in packets.iter().filter(|p| {
                    p["orchestratorThreadId"] == session.id && p["status"] != "archived"
                }) {
                    let mut subject = session.clone();
                    subject.status = packet["status"].as_str().unwrap_or("idle").into();
                    subject.rejected = packet["review"]["approved"] == false;
                    subject.outcome =
                        (packet["releaseState"] == "released").then(|| "merged".into());
                    let timestamp = packet["releaseStatePayload"]["releasedAt"]
                        .as_str()
                        .or(packet["archivedAt"].as_str())
                        .or(packet["lastEventAt"].as_str())
                        .or(packet["lane"]["lastEventAt"].as_str())
                        .unwrap_or("")
                        .to_owned();
                    candidates.push((subject, timestamp));
                }
            }
            candidates.sort_by(|(a, at), (b, bt)| {
                crate::sidebar::rank(b)
                    .cmp(&crate::sidebar::rank(a))
                    .then_with(|| crate::sidebar::working(b).cmp(&crate::sidebar::working(a)))
                    .then_with(|| bt.cmp(at))
            });
            if let Some((subject, _)) = candidates.first() {
                session.packet_state = true;
                session.status = subject.status.clone();
                session.rejected = subject.rejected;
                session.outcome = subject.outcome.clone();
            }
        }
        let inventory: Value = self.get("/api/runtime/inventory", &[("fresh", "1")])?;
        for agent in inventory["agents"].as_array().into_iter().flatten() {
            let Some(key) = agent["sessionKey"].as_str().filter(|key| key.contains(':')) else {
                continue;
            };
            if sessions.iter().any(|session| session.key() == key) {
                continue;
            }
            let packet_header = state["mission"]["packets"].as_array().and_then(|packets| packets.iter().find(|packet| packet["lane"]["sessionKey"] == key)).map(|packet| json!({
                "enabled":true,"title":packet["title"],"branch":packet["branchTarget"],"runtime":packet["runtime"],"status":packet["status"],"repo":packet["workspaceTargetPath"].as_str().and_then(|path| path.rsplit('/').find(|part| !part.is_empty())),"launchContext":packet["launchContext"]
            }));
            sessions.push(Session {
                repo_slug: None,
                branch: ["branch", "gitBranch"]
                    .iter()
                    .find_map(|k| agent[*k].as_str().filter(|b| !b.is_empty()))
                    .map(str::to_owned),
                tmux_session: agent["tmuxSession"].as_str().map(str::to_owned),
                id: key.into(),
                title: crate::text::sanitize(agent["name"].as_str().unwrap_or(key)),
                runtime: agent["runtime"].as_str().unwrap_or("").into(),
                status: agent["status"].as_str().unwrap_or("idle").into(),
                message_count: 0,
                last_message_at: agent["lastActivityAt"]
                    .as_i64()
                    .map(|time| format!("{time:020}"))
                    .unwrap_or_default(),
                repo_path: agent["workspace"].as_str().map(str::to_owned),
                backend: None,
                outcome: None,
                rejected: false,
                unread: false,
                packet_header,
                packet_state: false,
                inbox_subject: Some(&agent["inboxSubject"])
                    .filter(|v| v.is_object())
                    .cloned(),
                parent_inbox_subject: Some(&agent["parentInboxSubject"])
                    .filter(|v| v.is_object())
                    .cloned(),
                settled_override: agent["settledOverride"].as_str().map(str::to_owned),
                settled_at: agent["settledAt"].as_str().map(str::to_owned),
            });
        }
        if let Some(workspace) = self.workspace() {
            sessions.retain(|session| {
                session
                    .repo_path
                    .as_deref()
                    .is_some_and(|path| same_workspace(path, workspace))
            });
        }
        Ok((sessions, state))
    }

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
            Some(serde_json::from_value(json!({"id":key,"title":crate::text::sanitize(agent["name"].as_str().unwrap_or("Worker")),
                "status":agent["status"].as_str().unwrap_or("idle"),"runtime":agent["runtime"],
                "repoPath":agent["workspace"],"lastMessageAt":agent["lastActivityAt"].as_i64().map(|t| format!("{t:020}")).unwrap_or_default()
            })).map_err(|_| "Invalid worker inventory".to_string()))
        }).collect()
    }
    #[cfg(test)]
    pub(crate) fn sidebar_sessions(&self) -> Result<Vec<Session>, String> {
        self.sidebar_sessions_with_branches()
            .map(|(sessions, _)| sessions)
    }
    pub(crate) fn sidebar_sessions_with_branches(
        &self,
    ) -> Result<(Vec<Session>, HashMap<String, String>), String> {
        let (mut sessions, state) = self.sidebar_threads_with_state()?;
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
            let mut session: Session = serde_json::from_value(json!({
                "id": id, "title": record["title"], "status": "archived",
                "runtime": record["backend"].as_str().unwrap_or(""),
                "repoPath": record["repoPath"], "backend": record["backend"],
                "lastMessageAt": record["modifiedAt"], "messageCount": record["messageCount"]
            }))
            .map_err(|_| "Invalid archived thread")?;
            session.title = crate::text::sanitize(&session.title);
            sessions.push(session);
        }
        let branches = state["mission"]["packets"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| {
                p["status"] != "archived"
                    && p["branchTarget"].as_str().is_some_and(|b| !b.is_empty())
            })
            .flat_map(|p| {
                let branch = p["branchTarget"].as_str().unwrap_or_default();
                [
                    p["orchestratorThreadId"].as_str(),
                    p["lane"]["sessionKey"].as_str(),
                ]
                .into_iter()
                .flatten()
                .map(move |id| (id.strip_prefix("llm-chat:").unwrap_or(id).to_owned(), branch.to_owned()))
            })
            .collect();
        Ok((sessions, branches))
    }
}
