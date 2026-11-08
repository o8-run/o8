use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Local, SecondsFormat, Utc};
use sha2::{Digest, Sha256};

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
fn remote(repo: &str) -> Option<String> {
    if repo.is_empty() {
        None
    } else {
        std::process::Command::new("git")
            .args(["-C", repo, "remote", "get-url", "origin"])
            .env("GIT_OPTIONAL_LOCKS", "0")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
    }
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
fn clock(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|d| d.with_timezone(&Local).format("%-I:%M %p").to_string())
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
                json!({"threads":[]})
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
                thread: json!({"id":id,"title":title.chars().take(80).collect::<String>(),"lastMessageAt":activity,
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
        threads.push((summary.thread.clone(), summary.remote.clone()));
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
    // Keep each record's saved URL fallback private and never cache across reads.
    let mut remotes = HashMap::new();
    let mut threads: Vec<Value> = threads
        .into_iter()
        .map(|(mut thread, saved_remote)| {
            let repo = text(&thread, "repoPath");
            let remote = remotes
                .entry(repo.to_owned())
                .or_insert_with(|| remote(repo));
            let (owner, repo) = github(remote.as_deref(), &saved_remote);
            thread["githubOwner"] = owner;
            thread["githubRepo"] = repo;
            thread
        })
        .collect();
    thread_context::append_all(store, &mut threads)?;
    Ok(json!({"threads":threads}))
}

pub(super) fn transcript(store: &ReadContext<'_>, params: &Params) -> Response {
    let key = value(params, "sessionKey").trim();
    if key.is_empty() {
        return problem("sessionKey is required");
    }
    let Some(id) = key.strip_prefix("llm-chat:") else {
        return unavailable();
    };
    let record = store.history(id).unwrap_or(Value::Null);
    if record["source"] == "bot-network" {
        return unavailable();
    }
    let Ok(db) = store.database() else {
        return unavailable();
    };
    // Lane overlays include correlated delivery/failed-steer evidence. Fail closed
    // until that projection is ported instead of silently dropping durable messages.
    let bound: Result<bool, _> = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM lanes WHERE session_key = ?)",
        [key],
        |r| r.get(0),
    );
    if bound != Ok(false) {
        return unavailable();
    }
    let mut messages: Vec<Value> = record["messages"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m["isPartial"] != true)
        .collect();
    let count = if value(params, "page") == "1" {
        usize::MAX
    } else {
        limit(params, 6, 100)
    };
    if messages.len() > count {
        messages.drain(..messages.len() - count);
    }
    let mut transcript = Vec::new();
    for message in messages {
        let mut row = json!({"type":message.get("type").cloned().unwrap_or_else(|| json!(if !message["compaction"].is_null() || message["isCompaction"] == true {"compaction"} else {"message"})),
            "timestampLabel":message.get("timestampLabel").cloned().unwrap_or_else(|| json!(message["timestamp"].as_i64().filter(|&t|t!=0).map(clock).unwrap_or_default()))});
        for field in [
            "id",
            "role",
            "author",
            "network",
            "runtime",
            "persistedVersion",
            "steerAnchor",
            "media",
            "timestamp",
            "backend",
            "model",
            "receipt",
            "tokens",
            "costUsd",
            "toolCalls",
            "sources",
            "thinking",
            "thinkingSteps",
            "thinkingDurationMs",
            "recalledFacts",
            "command",
            "handoff",
            "compaction",
        ] {
            if let Some(v) = message.get(field) {
                row[field] = v.clone();
            }
        }
        if let Some(content) = message.get("content") {
            row["text"] = content.clone();
        }
        if let Some(workers) = record["pendingTurnWorkers"]
            .get(text(&message, "id"))
            .and_then(Value::as_array)
            .filter(|v| !v.is_empty())
        {
            if row["receipt"].is_object() {
                let mut merged = row["receipt"]["workers"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                for worker in workers {
                    if let Some(index) = merged
                        .iter()
                        .position(|w| w["packetId"] == worker["packetId"])
                    {
                        merged[index] = worker.clone();
                    } else {
                        merged.push(worker.clone());
                    }
                }
                row["receipt"]["workers"] = json!(merged);
            }
        }
        transcript.push(row);
    }
    let mut payload = json!({"sessionKey":key,"transcript":transcript});
    if value(params, "page") == "1" {
        let revision = hash(&json!({"messages":stable(transcript.clone())}));
        match page(&transcript, params, 100, &revision) {
            Ok((messages, metadata)) => {
                payload["transcript"] = json!(messages);
                payload["page"] = metadata;
            }
            Err(()) => {
                return reply(
                    StatusCode::CONFLICT,
                    json!({"ok":false,"error":"cursor_invalid","currentRevision":revision}),
                );
            }
        }
    }
    reply(StatusCode::OK, payload)
}

fn page(
    messages: &[Value],
    params: &Params,
    default: usize,
    revision: &str,
) -> Result<(Vec<Value>, Value), ()> {
    let messages = stable(messages.to_vec());
    let mut end = messages.len();
    if let Some(cursor) = params.get("before") {
        let decoded = URL_SAFE_NO_PAD
            .decode(cursor)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .ok_or(())?;
        let indexes = messages
            .iter()
            .enumerate()
            .filter(|(_, m)| m["id"] == decoded["anchorId"])
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        if decoded["v"] != 1
            || decoded["revision"] != revision
            || text(&decoded, "anchorId").is_empty()
            || indexes.len() != 1
        {
            return Err(());
        }
        end = indexes[0];
    }
    let count = params
        .get("limit")
        .map(|s| {
            if s.trim().is_empty() {
                1
            } else {
                s.parse::<f64>()
                    .ok()
                    .filter(|n| n.is_finite())
                    .map(|n| (n.trunc() as i64).clamp(1, 200) as usize)
                    .unwrap_or(default)
            }
        })
        .unwrap_or(default);
    let start = end.saturating_sub(count);
    let before = if start > 0 && start < end {
        Some(URL_SAFE_NO_PAD.encode(format!(
            "{{\"v\":1,\"revision\":\"{revision}\",\"anchorId\":{}}}",
            serde_json::to_string(&messages[start]["id"]).unwrap()
        )))
    } else {
        None
    };
    Ok((
        messages[start..end].to_vec(),
        json!({"revision":revision,"total":messages.len(),"hasMore":start>0,"beforeCursor":before}),
    ))
}

fn hash(value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).unwrap_or_default())
    )
}
fn stable(messages: Vec<Value>) -> Vec<Value> {
    let mut reserved: std::collections::HashSet<String> = messages
        .iter()
        .filter_map(|m| {
            m["id"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
        })
        .collect();
    let mut occurrences = HashMap::new();
    messages
        .into_iter()
        .filter(Value::is_object)
        .map(|mut m| {
            if !text(&m, "id").trim().is_empty() {
                return m;
            }
            m.as_object_mut().unwrap().remove("id");
            let fingerprint = hash(&m)[..24].to_owned();
            let count = occurrences.entry(fingerprint.clone()).or_insert(0);
            *count += 1;
            let base = format!(
                "legacy-{fingerprint}{}",
                if *count > 1 {
                    format!("-{count}")
                } else {
                    String::new()
                }
            );
            let mut id = base.clone();
            let mut collision = 1;
            while reserved.contains(&id) {
                id = format!("{base}-{collision}");
                collision += 1;
            }
            reserved.insert(id.clone());
            m["id"] = json!(id);
            m
        })
        .collect()
}
pub(super) fn context(store: &ReadContext<'_>, params: &Params) -> Response {
    let id = value(params, "tabId");
    if id.is_empty() {
        return problem("tabId required");
    }
    let mut record = store.history(id).unwrap_or_else(|_|json!({"messages":[],"model":null,"savedAt":null,"starred":false,"title":null,"planText":null,"repoName":null,"repoPath":null,"repoBranch":null,"projectId":null,"githubOwner":null,"githubRepo":null,"remoteUrl":null,"backend":null,"agent":null,"archivedAt":null,"orchestratorSessionIds":null,"orchestratorSessionUpdatedAt":null,"exists":false}));
    if !record.is_object() || record["source"] == "bot-network" {
        return unavailable();
    }
    let messages = stable(record["messages"].as_array().cloned().unwrap_or_default());
    record["messages"] = json!(messages);
    record["projectId"] = json!(
        record["projectId"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(str::trim)
    );
    if params.contains_key("limit") || params.contains_key("before") {
        let mut semantic = record.clone();
        semantic.as_object_mut().unwrap().remove("savedAt");
        semantic.as_object_mut().unwrap().remove("page");
        let revision = hash(&semantic);
        match page(&messages, params, 50, &revision) {
            Ok((messages, metadata)) => {
                record["messages"] = json!(messages);
                record["page"] = metadata;
            }
            Err(()) => {
                return reply(
                    StatusCode::CONFLICT,
                    json!({"error":"cursor_invalid","currentRevision":revision}),
                );
            }
        }
    }
    let (owner, repo) = github(
        remote(text(&record, "repoPath")).as_deref(),
        text(&record, "remoteUrl"),
    );
    record["githubOwner"] = owner;
    record["githubRepo"] = repo;
    reply(StatusCode::OK, record)
}
