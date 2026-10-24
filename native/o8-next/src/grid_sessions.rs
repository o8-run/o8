//! Grid discovery keeps original stream keys, including runtime workers, and
//! scopes both inventories to the explicitly selected workspace.
use crate::{
    client::{Client, Session},
    model::History,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

// Inventory presents paths with a shortened leading component. Expand only
// that documented spelling for comparison; never discover configuration files.
fn workspace_matches(cwd: &str, workspace: &str, base: Option<&Path>) -> bool {
    let path = match cwd.strip_prefix("~/") {
        Some(tail) => match base {
            Some(base) => base.join(tail),
            None => return false,
        },
        None => PathBuf::from(cwd),
    };
    path == Path::new(workspace)
}

pub fn key(session: &Session) -> String {
    if session.id.contains(':') {
        session.id.clone()
    } else {
        format!("llm-chat:{}", session.id)
    }
}
pub fn load(client: &Client, workspace: &str) -> Result<Vec<Session>, String> {
    let mut sessions = client.sessions()?;
    let inventory: Value = client.get("/api/runtime/inventory", &[("fresh", "1")])?;
    let base = std::env::var_os("HOME").map(PathBuf::from);
    for agent in inventory["agents"].as_array().into_iter().flatten() {
        let Some(session_key) = agent["sessionKey"].as_str().filter(|s| s.contains(':')) else {
            continue;
        };
        let cwd = agent["runtimeSurface"]["cwd"]
            .as_str()
            .or(agent["workspace"].as_str());
        if !cwd.is_some_and(|cwd| workspace_matches(cwd, workspace, base.as_deref())) {
            continue;
        }
        if let Some(existing) = sessions.iter_mut().find(|s| key(s) == session_key) {
            existing.repo_path = Some(workspace.into());
            existing.tmux_session = agent["tmuxSession"].as_str().map(str::to_owned);
            continue;
        }
        let session: Session = serde_json::from_value(json!({
            "id":session_key,"title":agent["name"].as_str().unwrap_or("Worker"),
            "status":agent["status"].as_str().unwrap_or("idle"),"runtime":agent["runtime"],"repoPath":workspace,
            "tmuxSession":agent["tmuxSession"]
        })).map_err(|_| "Invalid worker inventory")?;
        sessions.push(session);
    }
    Ok(sessions
        .into_iter()
        .filter(|s| s.repo_path.as_deref() == Some(workspace))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inventory_display_paths_keep_workspace_identity() {
        assert!(workspace_matches(
            "~/repo",
            "/fixture/repo",
            Some(Path::new("/fixture"))
        ));
        assert!(workspace_matches("/fixture/repo", "/fixture/repo", None));
        assert!(!workspace_matches(
            "~/repo",
            "/another/repo",
            Some(Path::new("/fixture"))
        ));
        assert!(!workspace_matches("~/repo", "/fixture/repo", None));
    }
}
pub fn history(client: &Client, session_key: &str) -> Result<History, String> {
    let history: History = client.get(
        "/api/mobile/history",
        &[("sessionKey", session_key), ("limit", "100")],
    )?;
    if history.session_key != session_key {
        return Err("Server returned history for a different pane".into());
    }
    Ok(history)
}
