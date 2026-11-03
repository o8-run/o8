//! Sidebar metadata uses the same saved inbox subject identity as TypeScript.
use super::*;

fn git_context(repo: &str) -> (Value, Value) {
    if repo.is_empty() {
        return (Value::Null, Value::Null);
    }
    let mut directory = PathBuf::from(repo);
    let folder = directory
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| json!(s))
        .unwrap_or(Value::Null);
    loop {
        let dot_git = directory.join(".git");
        let git = if dot_git.is_dir() {
            Some(dot_git)
        } else {
            std::fs::read_to_string(&dot_git).ok().and_then(|s| {
                s.trim()
                    .strip_prefix("gitdir:")
                    .map(|path| directory.join(path.trim()))
            })
        };
        if let Some(git) = git {
            let common = std::fs::read_to_string(git.join("commondir"))
                .map(|s| git.join(s.trim()))
                .unwrap_or_else(|_| git.clone());
            let branch = std::fs::read_to_string(git.join("HEAD"))
                .ok()
                .and_then(|s| {
                    s.trim()
                        .strip_prefix("ref: refs/heads/")
                        .map(|s| json!(s.trim()))
                })
                .unwrap_or(Value::Null);
            let config = std::fs::read_to_string(common.join("config")).unwrap_or_default();
            let mut section = None;
            let mut remotes = Vec::new();
            for line in config.lines().map(str::trim) {
                if line.starts_with('[') {
                    section = line
                        .strip_prefix("[remote \"")
                        .and_then(|s| s.split_once("\"]"))
                        .map(|(name, _)| name);
                } else if let (Some(name), Some((key, url))) = (section, line.split_once('=')) {
                    if key.trim() == "url" {
                        remotes.push((name, url.trim()));
                    }
                }
            }
            let remote = remotes
                .iter()
                .find(|(name, _)| *name == "origin")
                .or(remotes.first());
            let slug = remote
                .and_then(|(_, url)| {
                    let url = url.trim_end_matches('/').trim_end_matches(".git");
                    let path = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
                    let path = path.rsplit_once('@').map(|(_, rest)| rest).unwrap_or(path);
                    let (_, path) = path.split_once([':', '/'])?;
                    let parts: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
                    (parts.len() >= 2).then(|| {
                        json!(format!(
                            "{}/{}",
                            parts[parts.len() - 2],
                            parts[parts.len() - 1]
                        ))
                    })
                })
                .unwrap_or(folder);
            return (slug, branch);
        }
        if !directory.pop() {
            return (folder, Value::Null);
        }
    }
}

pub(super) fn append(store: &Store, thread: &mut Value) -> Result<(), ()> {
    let repo = thread["repoPath"].as_str().unwrap_or("").to_owned();
    let workspace = if repo.is_empty() {
        Value::Null
    } else {
        json!(std::fs::canonicalize(&repo)
            .unwrap_or_else(|_| PathBuf::from(&repo))
            .to_string_lossy())
    };
    let subject = json!({"kind":"conversation","id":thread["id"],"workspace":workspace,"projectId":thread["projectId"]});
    let db = store.database()?;
    // Parked projections require receipt-chain and lane ownership verification.
    // Defer to TS rather than claiming an absent receipt from partial state.
    let parked: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workspace_snapshots WHERE state = 'parked')",
            [],
            |r| r.get(0),
        )
        .map_err(|_| ())?;
    if parked {
        return Err(());
    }
    let key = format!(
        "inbox:subject:{}",
        json!(["conversation", workspace, thread["id"]])
    );
    let state: Value = match db.query_row("SELECT value FROM app_state WHERE key = ?", [key], |r| {
        r.get::<_, String>(0)
    }) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|_| ())?,
        Err(rusqlite::Error::QueryReturnedNoRows) => Value::Null,
        Err(_) => return Err(()),
    };
    thread["inboxSubject"] = subject;
    thread["parentInboxSubject"] = Value::Null;
    for field in [
        "settledOverride",
        "settledAt",
        "unsettledAt",
        "pinOrderKey",
        "activeOrderKey",
        "autoSettleDisabledAt",
    ] {
        thread[field] = state[field].clone();
    }
    thread["pinnedAt"] = state.get("pinnedAt").cloned().unwrap_or_else(|| {
        if thread["pinned"] == true {
            json!("1970-01-01T00:00:00.000Z")
        } else {
            Value::Null
        }
    });
    thread["pinned"] = json!(!thread["pinnedAt"].is_null());
    thread["inboxRevision"] = state.get("inboxRevision").cloned().unwrap_or(json!(0));
    thread["autoSettledReason"] = if state["settledOverride"] == "settled"
        && state["autoSettledAt"].is_string()
        && state["settledAt"] == state["autoSettledAt"]
    {
        state["autoSettledReason"].clone()
    } else {
        Value::Null
    };
    thread["runStartedAt"] = if state["runStatus"] == "running" {
        state
            .get("runStartedAt")
            .or_else(|| state.get("runAt"))
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let (slug, branch) = git_context(&repo);
    thread["branch"] = if branch.is_null() {
        thread["repoBranch"].clone()
    } else {
        branch
    };
    thread["repoSlug"] = match (
        thread["githubOwner"].as_str(),
        thread["githubRepo"].as_str(),
    ) {
        (Some(owner), Some(repo)) => json!(format!("{owner}/{repo}")),
        _ => {
            if slug.is_null() {
                thread["repoName"].clone()
            } else {
                slug
            }
        }
    };
    Ok(())
}
