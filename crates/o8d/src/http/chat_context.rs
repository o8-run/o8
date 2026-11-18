//! Window history reads. Node admits only non-network tabs, owns every write
//! and projection, and supplies no cached record. Uncertain reads defer to TS.
use super::chat_context_json::{canonical, hash, trim, whitespace};
use super::*;
use base64::{
    alphabet,
    engine::{
        general_purpose::{GeneralPurpose, GeneralPurposeConfig},
        DecodePaddingMode,
    },
    Engine,
};
use std::{collections::HashSet, fs, time::Instant};

fn empty() -> Value {
    json!({"messages":[],"model":null,"savedAt":null,"starred":false,"title":null,"planText":null,"repoName":null,"repoPath":null,"repoBranch":null,"projectId":null,"githubOwner":null,"githubRepo":null,"remoteUrl":null,"backend":null,"agent":null,"archivedAt":null,"orchestratorSessionIds":null,"orchestratorSessionUpdatedAt":null,"exists":false})
}
#[cfg(unix)]
fn read(store: &ReadContext<'_>, id: &str) -> ReadResult {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    // The canonical Node filename replacement works on UTF-16 code units.
    let safe: String = id
        .encode_utf16()
        .map(|c| {
            if c < 128 && ((c as u8).is_ascii_alphanumeric() || c == 45 || c == 95) {
                c as u8 as char
            } else {
                '_'
            }
        })
        .collect();
    let history = store.directory.join("chat-history");
    let metadata = match fs::symlink_metadata(&history) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty()),
        _ => return Err(()),
    };
    let root = history.canonicalize().map_err(|_| ())?;
    if !root.starts_with(&store.directory) {
        return Err(());
    }
    let path = root.join(format!("{safe}.json"));
    let before = match fs::symlink_metadata(&path) {
        Ok(m) if m.is_file() && !m.file_type().is_symlink() && m.len() <= RESPONSE_LIMIT as u64 => {
            m
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty()),
        _ => return Err(()),
    };
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
        .map_err(|_| ())?;
    // Check the opened descriptor and both lexical entries; atomic replacements
    // or a partial in-place rewrite must fall back rather than invent an empty tab.
    let same = |a: &fs::Metadata, b: &fs::Metadata| {
        a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.len() == b.len()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
    };
    if !same(&before, &file.metadata().map_err(|_| ())?) {
        return Err(());
    }
    // Keep the descriptor alive through the post-read identity checks.
    let mut reader = &file;
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(RESPONSE_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() != before.len() as usize
        || !same(&before, &file.metadata().map_err(|_| ())?)
        || !same(&before, &fs::symlink_metadata(&path).map_err(|_| ())?)
    {
        return Err(());
    }
    let after = fs::symlink_metadata(&history).map_err(|_| ())?;
    if after.file_type().is_symlink()
        || after.dev() != metadata.dev()
        || after.ino() != metadata.ino()
    {
        return Err(());
    }
    serde_json::from_slice(&bytes).map_err(|_| ())
}
#[cfg(not(unix))]
fn read(_store: &ReadContext<'_>, _id: &str) -> ReadResult {
    Err(())
}

fn stable(messages: &mut [Value]) -> Result<(), ()> {
    let has_id = |m: &Value| {
        m.get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !trim(id).is_empty())
    };
    // Unsupported shapes are handled by TS, never silently dropped natively.
    if messages.iter().any(|m| !m.is_object()) {
        return Err(());
    }
    let mut reserved: HashSet<String> = messages
        .iter()
        .filter(|m| has_id(m))
        .map(|m| m["id"].as_str().unwrap().to_owned())
        .collect();
    let mut occurrences = HashMap::new();
    for message in messages {
        // Validate even messages with ids: their fields contribute to revisions.
        canonical(message)?;
        if has_id(message) {
            continue;
        }
        message.as_object_mut().ok_or(())?.remove("id");
        let fingerprint = hash(message)?[..24].to_owned();
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
        message["id"] = json!(id);
    }
    Ok(())
}
fn page_limit(params: &Params) -> usize {
    let Some(raw) = params.get("limit") else {
        return 50;
    };
    let raw = trim(raw);
    let number = if raw.is_empty() {
        0.0
    } else if let Some((radix, digits)) =
        [("0x", 16), ("0b", 2), ("0o", 8)]
            .into_iter()
            .find_map(|(prefix, radix)| {
                raw.get(..2)
                    .filter(|p| p.eq_ignore_ascii_case(prefix))
                    .map(|_| (radix, &raw[2..]))
            })
    {
        if digits.is_empty() {
            f64::NAN
        } else {
            digits
                .chars()
                .try_fold(0.0, |n, c| {
                    c.to_digit(radix).map(|d| n * radix as f64 + d as f64)
                })
                .unwrap_or(f64::NAN)
        }
    } else {
        raw.parse::<f64>().unwrap_or(f64::NAN)
    };
    if number.is_finite() {
        number.trunc().clamp(1.0, 200.0) as usize
    } else {
        50
    }
}
fn decode(raw: &str) -> ReadResult {
    // Buffer.from(...,'base64url') accepts either alphabet, whitespace/junk,
    // padding and non-zero tail bits. JSON/shape validation remains strict.
    let mut clean: String = raw
        .chars()
        .take_while(|c| *c != '=')
        .filter_map(|c| match c {
            '-' => Some('+'),
            '_' => Some('/'),
            c if c.is_ascii_alphanumeric() || c == '+' || c == '/' => Some(c),
            _ => None,
        })
        .collect();
    if clean.len() % 4 == 1 {
        clean.pop();
    }
    let engine = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let bytes = engine.decode(clean).map_err(|_| ())?;
    let value: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).map_err(|_| ())?;
    if value["v"].as_f64() != Some(1.0)
        || value["revision"].as_str().is_none_or(str::is_empty)
        || value["anchorId"].as_str().is_none_or(str::is_empty)
    {
        return Err(());
    }
    Ok(value)
}
fn page(record: &mut Value, params: &Params) -> Result<(), Response> {
    if !params.contains_key("limit") && !params.contains_key("before") {
        return Ok(());
    }
    if params.get("before").is_some_and(|s| !s.is_ascii()) {
        // Node's base64 decoder truncates UTF-16 units to bytes. Keep exotic
        // cursor spellings on TS rather than treating them as invalid anchors.
        return Err(unavailable());
    }
    if params.get("limit").is_some_and(|s| {
        let s = trim(s);
        s.len() > 66
            && s.get(..2).is_some_and(|p| {
                ["0x", "0b", "0o"]
                    .iter()
                    .any(|prefix| p.eq_ignore_ascii_case(prefix))
            })
    }) {
        return Err(unavailable());
    }
    let mut semantic = record.clone();
    semantic.as_object_mut().unwrap().remove("savedAt");
    semantic.as_object_mut().unwrap().remove("page");
    let revision = hash(&semantic).map_err(|_| unavailable())?;
    let messages = record["messages"].as_array().unwrap();
    let total = messages.len();
    let mut end = total;
    let invalid = || {
        respond(
            StatusCode::CONFLICT,
            json!({"error":"cursor_invalid","currentRevision":revision}),
        )
    };
    if let Some(raw) = params.get("before") {
        let cursor = decode(raw).map_err(|_| invalid())?;
        if cursor["revision"] != revision {
            return Err(invalid());
        }
        let anchors: Vec<_> = messages
            .iter()
            .enumerate()
            .filter(|(_, m)| m["id"] == cursor["anchorId"])
            .map(|(i, _)| i)
            .collect();
        if anchors.len() != 1 {
            return Err(invalid());
        }
        end = anchors[0];
    }
    let start = end.saturating_sub(page_limit(params));
    let selected = messages[start..end].to_vec();
    let before = if start > 0 && !selected.is_empty() {
        // Cursor property insertion order is part of its opaque bytes.
        let text = format!(
            "{{\"v\":1,\"revision\":{},\"anchorId\":{}}}",
            serde_json::to_string(&revision).unwrap(),
            serde_json::to_string(&selected[0]["id"]).unwrap()
        );
        Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text))
    } else {
        None
    };
    record["messages"] = json!(selected);
    record["page"] =
        json!({"revision":revision,"total":total,"hasMore":start>0,"beforeCursor":before});
    Ok(())
}
fn parse_remote(remote: &str) -> Option<(String, String)> {
    let remote = trim(remote);
    let lower = remote.to_ascii_lowercase();
    for (offset, _) in lower.match_indices("github.com") {
        let rest = remote.get(offset + 10..)?;
        if !rest.starts_with(['/', ':']) {
            continue;
        }
        let rest = &rest[1..];
        let Some((owner, tail)) = rest.split_once('/') else {
            continue;
        };
        if owner.is_empty() || owner.chars().any(whitespace) || tail.is_empty() {
            continue;
        }
        let cut = tail
            .char_indices()
            .skip(1)
            .find(|(_, c)| *c == '#' || *c == '?')
            .map_or(tail.len(), |(i, _)| i);
        let repo = &tail[..cut];
        let suffix = &tail[cut..];
        if repo.contains('/')
            || repo.chars().any(whitespace)
            || suffix.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
        {
            continue;
        }
        // The TS regexp is case insensitive, including the optional .git suffix.
        let repo = if repo.len() > 4
            && repo
                .get(repo.len() - 4..)
                .is_some_and(|s| s.eq_ignore_ascii_case(".git"))
        {
            &repo[..repo.len() - 4]
        } else {
            repo
        };
        return Some((owner.to_owned(), repo.to_owned()));
    }
    None
}
fn identity(record: &Value) -> (Value, Value) {
    let field = |key| record[key].as_str().map(trim).unwrap_or("");
    let root = field("repoPath");
    let git = |args: &[&str]| {
        repository::git(root, args, 3000, 1024 * 1024)
            .ok()
            .map(|s| trim(&s).to_owned())
            .filter(|s| !s.is_empty())
    };
    let remote = if root.is_empty() {
        None
    } else {
        git(&["remote", "get-url", "origin"]).or_else(|| {
            let upstream = git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?;
            let name = trim(upstream.split('/').next()?);
            if name.is_empty() {
                None
            } else {
                git(&["remote", "get-url", name])
            }
        })
    };
    remote
        .as_deref()
        .and_then(parse_remote)
        .or_else(|| parse_remote(field("remoteUrl")))
        .map(|(owner, repo)| (json!(owner), json!(repo)))
        .unwrap_or((Value::Null, Value::Null))
}
fn respond(status: StatusCode, body: Value) -> Response {
    let Ok(bytes) = canonical(&body) else {
        return unavailable();
    };
    if bytes.len() > RESPONSE_LIMIT {
        return unavailable();
    }
    (status, [("content-type", "application/json")], bytes).into_response()
}
pub(super) fn context(store: &ReadContext<'_>, params: &Params) -> Response {
    let started = Instant::now();
    let mut response = run(store, params);
    if response.status() != StatusCode::SERVICE_UNAVAILABLE {
        if let Ok(value) =
            format!("total;dur={:.1}", started.elapsed().as_secs_f64() * 1000.0).parse()
        {
            response.headers_mut().insert("server-timing", value);
        }
    }
    response
}
fn run(store: &ReadContext<'_>, params: &Params) -> Response {
    let id = value(params, "tabId");
    if id.is_empty() {
        return respond(StatusCode::BAD_REQUEST, json!({"error":"tabId required"}));
    }
    let Ok(mut record) = read(store, id) else {
        return unavailable();
    };
    if !record.is_object() || record["source"] == "bot-network" {
        return unavailable();
    }
    let Some(messages) = record.get_mut("messages").and_then(Value::as_array_mut) else {
        return unavailable();
    };
    if stable(messages).is_err() {
        return unavailable();
    }
    record["projectId"] = record["projectId"]
        .as_str()
        .map(trim)
        .filter(|s| !s.is_empty())
        .map_or(Value::Null, |s| json!(s));
    if let Err(response) = page(&mut record, params) {
        return response;
    }
    let (owner, repo) = identity(&record);
    record["githubOwner"] = owner;
    record["githubRepo"] = repo;
    respond(StatusCode::OK, record)
}
