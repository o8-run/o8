//! Sidebar metadata uses the same saved inbox subject identity as TypeScript.
use super::*;

#[derive(Default)]
struct GitContext {
    slug: Value,
    branch: Value,
    is_worktree: bool,
    worktree_path: Value,
}

// Match path.resolve without requiring the pointed-to file to exist. Linked
// checkout pointers and commondir commonly contain parent-directory segments.
fn resolve(path: &Path) -> PathBuf {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other.as_os_str()),
        }
    }
    resolved
}

fn git_context(repo: &str) -> GitContext {
    if repo.is_empty() {
        return GitContext::default();
    }
    let mut directory = resolve(Path::new(repo));
    let folder = directory
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| json!(s))
        .unwrap_or(Value::Null);
    // A deleted/non-directory cwd cannot inherit the parent checkout identity.
    if !directory.is_dir() {
        return GitContext {
            slug: folder,
            ..GitContext::default()
        };
    }
    loop {
        let dot_git = directory.join(".git");
        let metadata = std::fs::metadata(&dot_git).ok();
        let git = if metadata.as_ref().is_some_and(std::fs::Metadata::is_dir) {
            Some((dot_git, false))
        } else if metadata.as_ref().is_some_and(std::fs::Metadata::is_file) {
            let pointer = std::fs::read_to_string(&dot_git).ok().and_then(|contents| {
                contents.lines().find_map(|line| {
                    line.strip_prefix("gitdir:")
                        .map(str::trim)
                        .filter(|path| !path.is_empty())
                        .map(|path| resolve(&directory.join(path)))
                })
            });
            // An invalid checkout marker ends discovery, just as in the TS
            // reader. It must not inherit a parent checkout's identity.
            if pointer.is_none() {
                return GitContext {
                    slug: folder,
                    ..GitContext::default()
                };
            }
            pointer.map(|git| (git, true))
        } else {
            None
        };
        if let Some((git, pointer)) = git {
            let common = if pointer {
                std::fs::read_to_string(git.join("commondir"))
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| resolve(&git.join(s.trim())))
                    .unwrap_or_else(|| git.clone())
            } else {
                git.clone()
            };
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
            let is_worktree = git != common;
            return GitContext {
                slug,
                branch,
                is_worktree,
                worktree_path: if is_worktree {
                    json!(directory)
                } else {
                    Value::Null
                },
            };
        }
        if !directory.pop() {
            return GitContext {
                slug: folder,
                ..GitContext::default()
            };
        }
    }
}

/// Share one fresh connection and repository projection across the response. Nothing
/// survives the request, so WAL commits, replacements and branch changes stay visible.
pub(super) fn append_all(store: &ReadContext<'_>, threads: &mut [Value]) -> Result<(), ()> {
    if threads.is_empty() {
        return Ok(());
    }
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
    let mut statement = db
        .prepare("SELECT value FROM app_state WHERE key = ?")
        .map_err(|_| ())?;
    let mut repositories = HashMap::new();
    for thread in threads {
        let repo = thread["repoPath"].as_str().unwrap_or("");
        let (workspace, git) = repositories.entry(repo.to_owned()).or_insert_with(|| {
            let workspace = if repo.is_empty() {
                Value::Null
            } else {
                json!(
                    std::fs::canonicalize(repo)
                        .unwrap_or_else(|_| PathBuf::from(repo))
                        .to_string_lossy()
                )
            };
            (workspace, git_context(repo))
        });
        let subject = json!({"kind":"conversation","id":thread["id"],"workspace":workspace,"projectId":thread["projectId"]});
        let key = format!(
            "inbox:subject:{}",
            json!(["conversation", workspace, thread["id"]])
        );
        let state: Value = match statement.query_row([key], |r| r.get::<_, String>(0)) {
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
        thread["isWorktree"] = json!(git.is_worktree);
        thread["worktreePath"] = git.worktree_path.clone();
        thread["branch"] = if git.branch.is_null() {
            thread["repoBranch"].clone()
        } else {
            git.branch.clone()
        };
        thread["repoSlug"] = match (
            thread["githubOwner"].as_str(),
            thread["githubRepo"].as_str(),
        ) {
            (Some(owner), Some(repo)) => json!(format!("{owner}/{repo}")),
            _ => {
                if git.slug.is_null() {
                    thread["repoName"].clone()
                } else {
                    git.slug.clone()
                }
            }
        };
    }
    Ok(())
}
