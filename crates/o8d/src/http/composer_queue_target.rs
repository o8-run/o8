//! Fresh target checks; no history, registry or capability cache.
use super::{
    composer_queue_owner::{Owner, QueueError},
    *,
};

pub(super) fn repo_key(repo: &str) -> String {
    std::fs::canonicalize(repo)
        .unwrap_or_else(|_| thread_context::resolve(Path::new(repo)))
        .to_string_lossy()
        .into_owned()
}
pub(super) fn history(owner: &Owner, thread: &str) -> Result<Value, QueueError> {
    let store = Store {
        directory: owner.directory.clone(),
        database: owner.database.clone(),
        defaults_context: None,
        redaction: None,
    };
    let value = chat_context::read(&ReadContext::new(&store), thread)
        .map_err(|_| QueueError::unavailable())?;
    if !value.is_object() || !value["messages"].is_array() {
        return Err(QueueError::unavailable());
    }
    Ok(value)
}
pub(super) fn network(db: &Connection, thread: &str, record: &Value) -> Result<bool, QueueError> {
    // Node creates this schema lazily. An absent table has no network binding;
    // an existing but unreadable/different schema fails closed.
    let exists:bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_network_threads')",[],|r|r.get(0)).map_err(|_|QueueError::unavailable())?;
    let bound = exists
        && db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM bot_network_threads WHERE thread_id=?1)",
                [thread],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|_| QueueError::unavailable())?;
    Ok(bound || record["source"] == "bot-network")
}
pub(super) fn validate(
    owner: &Owner,
    db: &Connection,
    input: &Value,
    saved: bool,
) -> Result<(String, String), QueueError> {
    let invalid = || QueueError::invalid("A valid repository and chat are required.");
    let thread = input["threadId"]
        .as_str()
        .filter(|s| {
            s.strip_prefix("thoughts-").is_some_and(|tail| {
                !tail.is_empty()
                    && tail.len() <= 80
                    && tail
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            })
        })
        .ok_or_else(invalid)?;
    let record = history(owner, thread)?;
    let is_network = network(db, thread, &record)?;
    let scratch = owner.directory.join("thread-scratch").join(thread);
    let scratch_key = repo_key(scratch.to_str().ok_or_else(QueueError::unavailable)?);
    let repo = input.get("repoPath");
    let scratch_input = repo.is_none_or(|v| {
        v.is_null() || v == "" || v.as_str().is_some_and(|s| repo_key(s) == scratch_key)
    });
    let no_repo = record["repoPath"].is_null() || record["repoPath"] == "";
    if !is_network && scratch_input && record["exists"] != false && no_repo {
        if saved {
            std::fs::create_dir_all(&scratch).map_err(|_| QueueError::unavailable())?;
        }
        return Ok((
            repo_key(scratch.to_str().ok_or_else(QueueError::unavailable)?),
            thread.into(),
        ));
    }
    let repo = input["repoPath"]
        .as_str()
        .filter(|s| s.starts_with('/') && s.encode_utf16().count() <= 4096)
        .ok_or_else(invalid)?;
    if is_network {
        return Err(QueueError::invalid(
            "Network threads send through the agent bus, not the orchestrator queue.",
        ));
    }
    let key = repo_key(repo);
    if no_repo && saved
        || !no_repo
            && record["repoPath"]
                .as_str()
                .is_none_or(|r| repo_key(r) != key)
    {
        return Err(QueueError::invalid(
            "The queued message must target its saved chat repository.",
        ));
    }
    if saved && std::fs::canonicalize(repo).is_err() {
        return Err(QueueError::unavailable());
    }
    Ok((key, thread.into()))
}
