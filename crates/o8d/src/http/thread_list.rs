//! Fresh local stage only. Node prepares canonical history, then enriches and
//! composes these bounded pieces over the authenticated private backhaul.
use super::*;
use chat_context_json::trim;
use chrono::{DateTime, SecondsFormat, Utc};
pub(super) const COMPOSE_LIMIT: usize = 8 * 1024 * 1024;
pub(super) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|v| v != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
pub(super) fn nullable(v: &Value) -> Value {
    if v.is_string() {
        v.clone()
    } else {
        Value::Null
    }
}
fn clipped(s: &str, n: usize) -> Result<String, ()> {
    String::from_utf16(&s.encode_utf16().take(n).collect::<Vec<_>>()).map_err(|_| ())
}
pub(super) fn trimmed(v: &Value) -> Value {
    v.as_str()
        .map(trim)
        .filter(|s| !s.is_empty())
        .map(|s| json!(s))
        .unwrap_or(Value::Null)
}

/// No symlink, partial file or changed descriptor may supply a local piece.
#[cfg(unix)]
pub(super) fn file(store: &ReadContext<'_>, path: &Path) -> Result<Option<Value>, ()> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let before = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        _ => return Err(()),
    };
    if !before.is_file() || before.file_type().is_symlink() || before.len() > RECORD_LIMIT {
        return Err(());
    }
    let canonical = path.canonicalize().map_err(|_| ())?;
    if !canonical.starts_with(&store.directory) {
        return Err(());
    }
    let opened = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| ())?;
    let stamp = |m: &std::fs::Metadata| {
        (
            m.dev(),
            m.ino(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        )
    };
    let inside = opened.metadata().map_err(|_| ())?;
    if stamp(&before) != stamp(&inside) {
        return Err(());
    }
    let mut bytes = Vec::new();
    (&opened)
        .take(RECORD_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > RECORD_LIMIT
        || stamp(&before) != stamp(&opened.metadata().map_err(|_| ())?)
        || stamp(&before) != stamp(&std::fs::symlink_metadata(path).map_err(|_| ())?)
    {
        return Err(());
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| ())
}
#[cfg(not(unix))]
pub(super) fn file(_: &ReadContext<'_>, _: &Path) -> Result<Option<Value>, ()> {
    Err(())
}
fn ids() -> Result<Vec<String>, ()> {
    serde_json::from_str(include_str!("../../orchestrator-backend-ids.json")).map_err(|_| ())
}
fn backend(record: &Value, ids: &[String]) -> Value {
    if record["backend"]
        .as_str()
        .is_some_and(|s| ids.iter().any(|id| id == s))
    {
        return record["backend"].clone();
    }
    for id in ["claude", "codex"] {
        if !trimmed(&record["orchestratorSessionIds"][id]).is_null() {
            return json!(id);
        }
    }
    Value::Null
}
fn runtime(record: &Value, backend: &Value) -> String {
    let model = trimmed(&record["model"]);
    let model = model
        .as_str()
        .unwrap_or(match backend.as_str() {
            Some("codex") => "codex",
            Some("claude") => "claude-code",
            Some("openclaw") => "openclaw",
            Some("hermes") => "hermes",
            _ => "claude-code",
        })
        .to_lowercase();
    // Object.keys(ORCHESTRATOR_RUNTIMES) order matters for substring matching.
    let runtimes = [
        "codex",
        "cloud",
        "claude-code",
        "gemini",
        "antigravity",
        "magnitude",
        "opencode",
        "copilot-cli",
        "crush",
        "openhands",
        "goose",
        "qwen",
        "qoder",
        "kimi",
        "aider",
        "3code",
        "pi",
        "pi-builtin",
        "cursor",
        "grok",
        "prime-agent",
        "muse",
        "hermes",
        "deepseek-harness",
        "ui-edit-low-latency",
    ];
    if runtimes.contains(&model.as_str()) {
        return model;
    }
    for (needle, result) in [
        ("claude", "claude-code"),
        ("gemini", "gemini"),
        ("opencode", "opencode"),
        ("codex", "codex"),
    ] {
        if model.contains(needle) {
            return result.to_owned();
        }
    }
    if model.starts_with("gpt") {
        return "codex".to_owned();
    }
    runtimes
        .into_iter()
        .find(|id| model.contains(id))
        .unwrap_or("unknown")
        .to_owned()
}
fn diagnostic(record: &Value, messages: &[Value]) -> bool {
    fn probe(v: &Value) -> bool {
        v.as_str().is_some_and(|s| {
            let s = trim(s)
                .split(chat_context_json::whitespace)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            s.strip_suffix(['.', '!']).unwrap_or(&s).to_lowercase()
                == "reply with exactly: terminal chat is connected"
        })
    }
    if truthy(&record["title"]) && !probe(&record["title"]) {
        return false;
    }
    let users = messages
        .iter()
        .filter(|m| m["role"] == "user")
        .collect::<Vec<_>>();
    users.len() == 1 && probe(&users[0]["content"])
}
fn summary(
    id: &str,
    record: &Value,
    modified: String,
    ids: &[String],
) -> Result<Option<Value>, ()> {
    if !record.is_object() || (!record["title"].is_null() && !record["title"].is_string()) {
        return Err(());
    }
    let messages = record
        .get("messages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if messages.iter().any(|m| !m.is_object()) {
        return Err(());
    }
    if diagnostic(record, messages) {
        return Ok(None);
    }
    let network = record["source"] == "bot-network";
    if !record["network"]["question"].is_null() && !record["network"]["question"].is_object() {
        return Err(());
    }
    let backend = if network {
        Value::Null
    } else {
        backend(record, ids)
    };
    let last = messages.last().unwrap_or(&Value::Null);
    let mut max = 0.0_f64;
    for m in messages {
        if let Some(n) = m["timestamp"].as_f64().filter(|n| n.is_finite()) {
            max = max.max(n);
        }
    }
    let activity = if max > 0.0 {
        if max > 253_402_300_799_999.0 {
            return Err(());
        }
        DateTime::<Utc>::from_timestamp_millis(max.trunc() as i64)
            .ok_or(())?
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    } else if truthy(&record["savedAt"]) {
        record["savedAt"].as_str().ok_or(())?.to_owned()
    } else {
        modified
    };
    let title = trim(record["title"].as_str().unwrap_or(""));
    let legacy = title
        .strip_prefix("Orchestrator session · ")
        .is_some_and(|s| {
            s.len() == 16
                && s.bytes().enumerate().all(|(i, b)| match i {
                    4 | 7 => b == b'-',
                    10 => b == b' ',
                    13 => b == b':',
                    _ => b.is_ascii_digit(),
                })
        });
    let title = clipped(
        if title.is_empty() || legacy {
            "Untitled conversation"
        } else {
            title
        },
        80,
    )?;
    let status = if network {
        if messages.is_empty() {
            "idle"
        } else {
            "ready"
        }
    } else if record["orchestratorTerminalStatus"] == "failed" {
        "failed"
    } else if messages.is_empty() {
        "idle"
    } else if last["role"] == "user"
        || (last["role"] == "assistant"
            && trim(
                last.get("content")
                    .filter(|v| !v.is_null())
                    .map(|v| v.as_str().ok_or(()))
                    .transpose()?
                    .unwrap_or(""),
            )
            .is_empty())
    {
        "busy"
    } else {
        "ready"
    };
    let repo = nullable(&record["repoPath"]);
    let repo_name = if !trimmed(&record["repoName"]).is_null() {
        record["repoName"].clone()
    } else {
        repo.as_str()
            .filter(|s| !s.is_empty())
            .and_then(|s| Path::new(s.trim_end_matches(['/', '\\'])).file_name())
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .map(|s| json!(s))
            .unwrap_or(Value::Null)
    };
    let mut thread = json!({"id":id,"title":title,"lastMessageAt":activity,"runtime":if network {"unknown".to_owned()} else {runtime(record,&backend)},"status":status,"messageCount":messages.len(),"projectId":trimmed(&record["projectId"]),"repoPath":repo,"repoName":repo_name,"repoBranch":nullable(&record["repoBranch"]),"githubOwner":null,"githubRepo":null,"backend":backend,"agent":record["agent"].as_str().filter(|s|!trim(s).is_empty()).map(|s|clipped(trim(s),128)).transpose()?,"pinned":record["pinned"] == true});
    if network {
        thread["source"] = json!("bot-network");
        if truthy(&record["network"]["question"]) {
            thread["networkQuestion"] = record["network"]["question"].clone();
        }
    }
    Ok(Some(thread))
}
fn github(url: &str) -> Option<(String, String)> {
    let url = trim(url);
    let lower = url.to_ascii_lowercase();
    let index = lower.find("github.com")?;
    let rest = &url[index + 10..];
    if !rest.starts_with(['/', ':']) {
        return None;
    }
    let path = rest[1..].split(['?', '#']).next()?;
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.len() != 2
        || parts
            .iter()
            .any(|s| s.is_empty() || s.chars().any(chat_context_json::whitespace))
    {
        return None;
    }
    let repo = parts[1];
    let repo = if repo.len() > 4 && repo.to_ascii_lowercase().ends_with(".git") {
        &repo[..repo.len() - 4]
    } else {
        repo
    };
    Some((parts[0].to_owned(), repo.to_owned()))
}
fn identity(repo: &str, fallback: &str) -> (Value, Value) {
    let git = |args: &[&str]| {
        repository::git(trim(repo), args, 3000, 1024 * 1024)
            .ok()
            .map(|s| trim(&s).to_owned())
            .filter(|s| !s.is_empty())
    };
    let remote = if trim(repo).is_empty() {
        None
    } else {
        git(&["remote", "get-url", "origin"]).or_else(|| {
            let upstream = git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?;
            git(&["remote", "get-url", upstream.split('/').next()?])
        })
    };
    remote
        .as_deref()
        .and_then(github)
        .or_else(|| github(fallback))
        .map(|(a, b)| (json!(a), json!(b)))
        .unwrap_or((Value::Null, Value::Null))
}
fn turns(store: &ReadContext<'_>) -> Result<HashMap<String, Vec<Value>>, ()> {
    let mut result: HashMap<String, Vec<Value>> = HashMap::new();
    let directory = store.directory.join("orchestrator-turns");
    let entries = match std::fs::read_dir(directory) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        _ => return Err(()),
    };
    for entry in entries {
        let path = entry.map_err(|_| ())?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let record = file(store, &path)?.ok_or(())?;
        if !truthy(&record["id"]) || !truthy(&record["stdoutPath"]) {
            continue;
        }
        if let Some(id) = record["threadId"].as_str().filter(|s| !s.is_empty()) {
            result.entry(id.to_owned()).or_default().push(record);
        }
    }
    for rows in result.values_mut() {
        for row in rows.iter() {
            if row["startedAt"]
                .as_f64()
                .filter(|n| n.is_finite())
                .is_none()
            {
                return Err(());
            }
        }
        rows.sort_by(|a, b| {
            b["startedAt"]
                .as_f64()
                .unwrap()
                .total_cmp(&a["startedAt"].as_f64().unwrap())
        });
    }
    Ok(result)
}
fn turn_status(thread: &mut Value, turns: &[Value]) -> Result<(), ()> {
    if turns.is_empty() || thread["source"] == "bot-network" {
        return Ok(());
    }
    let now = Utc::now().timestamp_millis() as f64;
    let mut running = false;
    for row in turns {
        if !truthy(&row["settledAt"]) && now - row["startedAt"].as_f64().ok_or(())? < 14_400_000.0 {
            if let Some(pid) = row["pid"]
                .as_i64()
                .filter(|pid| *pid > 0 && *pid <= i32::MAX as i64)
            {
                #[cfg(unix)]
                {
                    running |= unsafe { libc::kill(pid as i32, 0) } == 0
                        || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
                }
                #[cfg(not(unix))]
                {
                    return Err(());
                }
            }
        }
    }
    thread["status"] = json!(if running {
        "busy"
    } else if turns[0]["outcome"] == "failed" {
        "failed"
    } else {
        "ready"
    });
    Ok(())
}
fn integer(raw: &str, default: usize, max: usize, min: usize) -> usize {
    let raw = trim(raw);
    let (negative, rest) = if let Some(rest) = raw.strip_prefix('-') {
        (true, rest)
    } else {
        (false, raw.strip_prefix('+').unwrap_or(raw))
    };
    let digits = rest
        .bytes()
        .take_while(u8::is_ascii_digit)
        .collect::<Vec<_>>();
    if digits.is_empty() {
        return default;
    }
    let parsed = std::str::from_utf8(&digits)
        .ok()
        .and_then(|s| s.parse::<f64>().ok());
    if !parsed.is_some_and(|n| n.is_finite()) {
        return default;
    }
    let n = digits.into_iter().fold(0usize, |n, c| {
        n.saturating_mul(10).saturating_add((c - b'0') as usize)
    });
    if negative {
        min
    } else {
        n.clamp(min, max)
    }
}
pub(super) fn read(store: &ReadContext<'_>, params: &Params) -> Response {
    match local(store, params) {
        Ok(body) => {
            if serde_json::to_vec(&body).map_or(true, |bytes| bytes.len() > COMPOSE_LIMIT) {
                return unavailable();
            }
            let mut response = reply(StatusCode::OK, body);
            if value(params, "archived") != "1"
                && (trim(value(params, "backend")).is_empty()
                    || ids()
                        .unwrap_or_default()
                        .iter()
                        .any(|id| id == trim(value(params, "backend"))))
            {
                response
                    .headers_mut()
                    .insert("x-o8d-thread-pieces", "1".parse().unwrap());
            }
            response
        }
        Err(()) => unavailable(),
    }
}
fn local(store: &ReadContext<'_>, params: &Params) -> ReadResult {
    let context = store
        .defaults_context
        .as_ref()
        .and_then(|v| v["threadList"].as_object())
        .filter(|v| v.len() == 1)
        .ok_or(())?;
    let machine = context
        .get("machineDisplayName")
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 16 * 1024)
        .ok_or(())?;
    let ids = ids()?;
    let filter = trim(value(params, "backend"));
    let archived = value(params, "archived") == "1";
    if !archived && !filter.is_empty() && !ids.iter().any(|id| id == filter) {
        return Ok(json!({"threads":[]}));
    }
    let turns = if archived {
        HashMap::new()
    } else {
        turns(store)?
    };
    let root = store.directory.join("chat-history");
    let mut paths = match std::fs::read_dir(&root) {
        Ok(entries) => entries
            .map(|e| e.map(|e| e.path()).map_err(|_| ()))
            .collect::<Result<Vec<_>, _>>()?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        _ => return Err(()),
    };
    if archived {
        paths.sort();
    } else {
        paths.sort_by(|a, b| {
            a.to_str()
                .unwrap_or("")
                .encode_utf16()
                .cmp(b.to_str().unwrap_or("").encode_utf16())
        });
    }
    let mut saved = Vec::new();
    let mut archived_ids = Vec::new();
    for path in paths {
        let Some(id) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| s.starts_with("thoughts-"))
        else {
            continue;
        };
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let record = file(store, &path)?.ok_or(())?;
        if truthy(&record["archivedAt"]) {
            if archived {
                archived_ids.push(json!(id));
            }
            continue;
        }
        if archived || (record["source"] == "bot-network" && !filter.is_empty()) {
            continue;
        }
        if let Some(mut thread) = summary(
            id,
            &record,
            std::fs::metadata(&path)
                .map_err(|_| ())?
                .modified()
                .map(DateTime::<Utc>::from)
                .map_err(|_| ())?
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            &ids,
        )? {
            turn_status(
                &mut thread,
                turns.get(id).map(Vec::as_slice).unwrap_or_default(),
            )?;
            if if filter.is_empty() {
                thread["backend"] != "openclaw"
            } else {
                thread["backend"] == filter
            } {
                let timestamp =
                    DateTime::parse_from_rfc3339(thread["lastMessageAt"].as_str().ok_or(())?)
                        .map_err(|_| ())?
                        .timestamp_millis();
                saved.push((
                    timestamp,
                    thread,
                    record["remoteUrl"].as_str().unwrap_or("").to_owned(),
                ));
            }
        }
    }
    if archived {
        return Ok(json!({"archivedIds":archived_ids}));
    }
    saved.sort_by(|a, b| b.0.cmp(&a.0));
    let offset = integer(value(params, "offset"), 0, saved.len(), 0);
    let count = integer(value(params, "limit"), 20, 500, 1);
    let mut identity_by_repo = HashMap::new();
    let mut threads = Vec::new();
    for (_, mut thread, fallback) in saved.into_iter().skip(offset).take(count) {
        let repo = thread["repoPath"].as_str().unwrap_or("");
        let key = (repo.to_owned(), fallback.clone());
        let (owner, repo) = identity_by_repo
            .entry(key)
            .or_insert_with(|| identity(repo, &fallback));
        thread["githubOwner"] = owner.clone();
        thread["githubRepo"] = repo.clone();
        threads.push(thread);
    }
    let pieces = thread_list_projection::pieces(store, threads)?;
    let body = json!({"version":1,"pieces":pieces,"machineDisplayName":machine});
    if serde_json::to_vec(&body).map_err(|_| ())?.len() > COMPOSE_LIMIT {
        return Err(());
    }
    Ok(body)
}
