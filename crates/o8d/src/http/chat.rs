use super::*;
use chrono::{DateTime, SecondsFormat, Utc};

const BACKENDS: &[&str] = &[
    "codex", "claude", "openclaw", "hermes", "acp", "collide", "fable", "o8", "opencode", "pi",
    "muse",
];
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn backend(record: &Value) -> Value {
    if BACKENDS.contains(&text(record, "backend")) {
        return record["backend"].clone();
    }
    for name in ["claude", "codex"] {
        if record["orchestratorSessionIds"][name]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
        {
            return json!(name);
        }
    }
    Value::Null
}
fn github(remote: Option<&str>, saved_remote: &str) -> (Value, Value) {
    for url in [remote.unwrap_or(""), saved_remote] {
        let lower = url.to_lowercase();
        if let Some(index) = lower
            .find("github.com")
            .filter(|&i| matches!(lower.as_bytes().get(i + 10), Some(b'/') | Some(b':')))
        {
            let path = url[index + 11..]
                .trim()
                .split(['?', '#'])
                .next()
                .unwrap_or("");
            let parts: Vec<_> = path.split('/').collect();
            if parts.len() == 2
                && !parts[0].is_empty()
                && !parts[1].is_empty()
                && !path.chars().any(char::is_whitespace)
            {
                return (
                    json!(parts[0]),
                    json!(parts[1].strip_suffix(".git").unwrap_or(parts[1])),
                );
            }
        }
    }
    (Value::Null, Value::Null)
}
fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}
pub(super) fn threads(store: &ReadContext<'_>, params: &Params) -> ReadResult {
    let filter = value(params, "backend").trim();
    let archived = value(params, "archived") == "1";
    if !archived && !filter.is_empty() && !BACKENDS.contains(&filter) {
        return Ok(json!({"threads":[]}));
    }
    let mut files = match std::fs::read_dir(store.directory.join("chat-history")) {
        Ok(files) => files
            .filter_map(Result::ok)
            .map(|f| f.path())
            .collect::<Vec<_>>(),
        Err(_) => {
            return Ok(if archived {
                json!({"archivedIds":[]})
            } else {
                json!({"threads":[],"updatedAt":null})
            });
        }
    };
    files.sort();
    let mut threads = Vec::new();
    let mut ids = Vec::new();
    let epoch = thread_summary::epoch();
    for path in files {
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
        // The profile boundary Store::file applies, checked before the cache.
        let Some(path) = path
            .canonicalize()
            .ok()
            .filter(|path| path.starts_with(&store.directory))
        else {
            continue;
        };
        let Some(summary) = thread_summary::read(&path, epoch, || {
            let record = store.json(&path).ok()?;
            let archived = record["archivedAt"].as_str().is_some_and(|s| !s.is_empty());
            let bot_network = record["source"] == "bot-network";
            let backend = backend(&record);
            if archived || bot_network {
                return Some(thread_summary::Summary {
                    archived,
                    bot_network,
                    backend,
                    thread: Value::Null,
                    remote: String::new(),
                });
            }
            let messages = record["messages"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default();
            let last = messages.last().unwrap_or(&Value::Null);
            let timestamp = messages
                .iter()
                .filter_map(|m| m["timestamp"].as_i64())
                .max()
                .unwrap_or(0);
            let activity = if timestamp > 0 {
                iso(timestamp)
            } else if text(&record, "savedAt").is_empty() {
                std::fs::metadata(&path)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(DateTime::<Utc>::from)
                    .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
                    .unwrap_or_default()
            } else {
                text(&record, "savedAt").to_owned()
            };
            let title = text(&record, "title").trim();
            let title = if title.is_empty() || title.starts_with("Orchestrator session · ") {
                "Untitled conversation"
            } else {
                title
            };
            let model = text(&record, "model").trim().to_lowercase();
            let inferred = if model.is_empty() {
                match backend.as_str() {
                    Some("codex") => "codex",
                    Some("openclaw") => "openclaw",
                    Some("hermes") => "hermes",
                    _ => "claude-code",
                }
            } else {
                &model
            };
            let runtime = if inferred.contains("claude") {
                "claude-code"
            } else if inferred.contains("gemini") {
                "gemini"
            } else if inferred.contains("opencode") {
                "opencode"
            } else if inferred.contains("codex") || inferred.starts_with("gpt") {
                "codex"
            } else if ["hermes", "pi", "muse", "openclaw"].contains(&inferred) {
                inferred
            } else {
                "unknown"
            };
            let status = if record["orchestratorTerminalStatus"] == "failed" {
                "failed"
            } else if messages.is_empty() {
                "idle"
            } else if last["role"] == "user"
                || (last["role"] == "assistant" && text(&last, "content").trim().is_empty())
            {
                "busy"
            } else {
                "ready"
            };
            let repo_name = if text(&record, "repoName").trim().is_empty() {
                record["repoPath"]
                    .as_str()
                    .and_then(|s| Path::new(s.trim_end_matches(['/', '\\'])).file_name())
                    .and_then(|s| s.to_str())
                    .map(|s| json!(s))
                    .unwrap_or(Value::Null)
            } else {
                record["repoName"].clone()
            };
            Some(thread_summary::Summary {
                archived,
                bot_network,
                thread: json!({"title":title.chars().take(80).collect::<String>(),"lastMessageAt":activity,
            "runtime":runtime,"status":status,"messageCount":messages.len(),"projectId":record["projectId"].as_str().filter(|s|!s.trim().is_empty()).map(str::trim),
            "repoPath":record["repoPath"],"repoName":repo_name,"repoBranch":record["repoBranch"],
            "backend":backend.clone(),"agent":record["agent"].as_str().filter(|s|!s.trim().is_empty()).map(|s|s.trim().chars().take(128).collect::<String>()),"pinned":record["pinned"]==true}),
                backend,
                remote: text(&record, "remoteUrl").to_owned(),
            })
        }) else {
            continue;
        };
        if archived {
            if summary.archived {
                ids.push(json!(id));
            }
            continue;
        }
        if summary.archived {
            continue;
        }
        if summary.bot_network {
            return Err(());
        }
        if if filter.is_empty() {
            summary.backend == "openclaw"
        } else {
            summary.backend != filter
        } {
            continue;
        }
        // The id is the requested file's name: an alias of a cached file is
        // its own conversation, so the id stays out of the cached summary.
        let mut thread = summary.thread.clone();
        thread["id"] = json!(id);
        threads.push((thread, summary.remote.clone()));
    }
    if archived {
        return Ok(json!({"archivedIds":ids}));
    }
    threads.sort_by(|(a, _), (b, _)| text(b, "lastMessageAt").cmp(text(a, "lastMessageAt")));
    let offset = value(params, "offset")
        .parse::<usize>()
        .unwrap_or(0)
        .min(threads.len());
    threads.drain(..offset);
    threads.truncate(limit(params, 20, 500));
    // Resolve only the returned page, and once per repository in this request.
    // Keep each record's saved URL fallback private: only the repository's own
    // origin URL is reused across reads, while its config is unchanged.
    let mut remotes = HashMap::new();
    let mut threads: Vec<Value> = threads
        .into_iter()
        .map(|(mut thread, saved_remote)| {
            let repo = text(&thread, "repoPath");
            let remote = remotes
                .entry(repo.to_owned())
                .or_insert_with(|| git_remote::origin(repo));
            let (owner, repo) = github(remote.as_deref(), &saved_remote);
            thread["githubOwner"] = owner;
            thread["githubRepo"] = repo;
            thread
        })
        .collect();
    thread_context::append_all(store, &mut threads)?;
    // Durable PR links defer in thread_metadata, so the newest returned
    // thread timestamp is the same watermark used by the TS handler here.
    let updated_at = threads.iter().filter_map(|thread| thread["lastMessageAt"].as_str()).max();
    Ok(json!({"threads":threads,"updatedAt":updated_at}))
}
