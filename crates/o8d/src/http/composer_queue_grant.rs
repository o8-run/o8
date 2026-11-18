//! Request-scoped authority from authenticated Node admission; no cache or I/O.
use super::*;
pub(super) struct Grant {
    pub repo: String,
    pub thread: String,
    pub request_repo: String,
    pub backend: Option<String>,
    pub capabilities: HashMap<String, bool>,
}
fn text<'a>(value: &'a Value, max: usize) -> Result<&'a str, ()> {
    value.as_str().filter(|s| s.len() <= max).ok_or(())
}
fn keys(value: &Value, expected: &[&str]) -> Result<(), ()> {
    let fields = value.as_object().ok_or(())?;
    if fields.len() != expected.len() || fields.keys().any(|key| !expected.contains(&key.as_str()))
    {
        return Err(());
    }
    Ok(())
}
pub(super) fn parse(value: &Value) -> Result<Grant, ()> {
    keys(value, &["target", "request", "capabilities"])?;
    keys(&value["target"], &["repoPath", "threadId"])?;
    keys(&value["request"], &["repoPath", "threadId", "backend"])?;
    let repo = text(&value["target"]["repoPath"], 16 * 1024)?;
    let thread = text(&value["target"]["threadId"], 256)?;
    if !repo.starts_with('/') || thread.is_empty() || value["request"]["threadId"] != thread {
        return Err(());
    }
    let request_repo = text(&value["request"]["repoPath"], 16 * 1024)?;
    let backend = if value["request"]["backend"].is_null() {
        None
    } else {
        Some(text(&value["request"]["backend"], 64)?.to_owned())
    };
    let rows = value["capabilities"]
        .as_array()
        .filter(|rows| rows.len() <= 32)
        .ok_or(())?;
    let mut capabilities = HashMap::new();
    for row in rows {
        keys(row, &["id", "liveSteer"])?;
        let id = text(&row["id"], 64)?;
        let capable = row["liveSteer"].as_bool().ok_or(())?;
        if capabilities.insert(id.to_owned(), capable).is_some() {
            return Err(());
        }
    }
    if backend
        .as_ref()
        .is_some_and(|id| !capabilities.contains_key(id))
    {
        return Err(());
    }
    Ok(Grant {
        repo: repo.to_owned(),
        thread: thread.to_owned(),
        request_repo: request_repo.to_owned(),
        backend,
        capabilities,
    })
}
pub fn valid(value: &Value) -> bool {
    parse(value).is_ok()
}
