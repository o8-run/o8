//! Sole product writer for prompt_library. Node remains the schema/migration owner.
use super::prompt_library::{entry, trim, whitespace};
use super::*;
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    params,
};
use sha2::{Digest, Sha256};
const SCHEMA: &str = include_str!("prompt_library_v53.sql");
const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
type MutationResult<T> = Result<T, Failure>;
enum Failure {
    Refuse,
    Reply(StatusCode, Value),
}
impl From<rusqlite::Error> for Failure {
    fn from(_: rusqlite::Error) -> Self {
        Self::Refuse
    }
}
fn error(status: StatusCode, code: &str, message: &str) -> Failure {
    Failure::Reply(
        status,
        json!({"schema":"o8/prompt-library.error/v1","ok":false,"error":{"code":code,"message":message}}),
    )
}
fn invalid(code: &str, message: &str) -> Failure {
    error(StatusCode::BAD_REQUEST, code, message)
}
fn missing() -> Failure {
    error(
        StatusCode::NOT_FOUND,
        "prompt_not_found",
        "Saved prompt not found.",
    )
}
fn stale() -> Failure {
    error(
        StatusCode::CONFLICT,
        "stale_revision",
        "This saved prompt changed. Reload it before saving or deleting.",
    )
}
fn id(path: &str) -> Option<&str> {
    let id = path
        .strip_prefix("/api/prompt-library/")?
        .strip_suffix("/use")
        .unwrap_or(path.strip_prefix("/api/prompt-library/")?);
    (!id.is_empty()
        && id != "import"
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)))
    .then_some(id)
}
pub(super) fn matches(path: &str, method: &str) -> bool {
    if path == "/api/prompt-library" {
        return method == "POST";
    }
    id(path).is_some()
        && if path.ends_with("/use") {
            method == "POST"
        } else {
            matches!(method, "PATCH" | "DELETE")
        }
}
fn normalize_sql(sql: &str) -> String {
    let mut result = String::new();
    let mut quoted = false;
    for c in sql.chars() {
        if c == '\'' {
            quoted = !quoted;
        }
        if quoted || c == '\'' {
            result.push(c);
        } else if !c.is_ascii_whitespace() && c != ';' {
            result.push(c.to_ascii_lowercase());
        }
    }
    // SQLite omits IF NOT EXISTS in sqlite_master. Keep literal strings exact.
    for prefix in ["createtable", "createuniqueindex", "createindex"] {
        if let Some(rest) = result.strip_prefix(&format!("{prefix}ifnotexists")) {
            return format!("{prefix}{rest}");
        }
    }
    result
}
fn schema(db: &Connection) -> MutationResult<()> {
    let columns = db.prepare("SELECT * FROM prompt_library LIMIT 0")?;
    if columns.column_names().collect::<Vec<_>>()
        != super::prompt_library::COLUMNS
            .split(',')
            .collect::<Vec<_>>()
    {
        return Err(Failure::Refuse);
    }
    // Compare the exact v53 schema, not merely column names: constraints and
    // unique/partial indexes are part of the write contract. No migrations here.
    let mut statement = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='prompt_library' AND sql IS NOT NULL ORDER BY type,name")?;
    let mut actual = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    actual = actual.iter().map(|s| normalize_sql(s)).collect();
    actual.sort();
    let mut expected: Vec<_> = SCHEMA
        .split(';')
        .filter(|s| !s.trim().is_empty())
        .map(normalize_sql)
        .collect();
    expected.sort();
    if actual != expected {
        return Err(Failure::Refuse);
    }
    Ok(())
}
fn open(store: &ReadContext<'_>) -> MutationResult<Connection> {
    let marker = store
        .file(&store.directory.join(".db-migrated-v53"), 4096)
        .map_err(|_| Failure::Refuse)?;
    let marker: Value = serde_json::from_slice(&marker).map_err(|_| Failure::Refuse)?;
    if marker["schemaVersion"] != 53 {
        return Err(Failure::Refuse);
    }
    let path = store.database.canonicalize().map_err(|_| Failure::Refuse)?;
    if !path.starts_with(&store.directory)
        || !path.is_file()
        || std::fs::symlink_metadata(&store.database)
            .map_err(|_| Failure::Refuse)?
            .file_type()
            .is_symlink()
    {
        return Err(Failure::Refuse);
    }
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(std::time::Duration::from_millis(500))?;
    Ok(db)
}
fn restrict(db: &mut Connection) -> MutationResult<()> {
    db.authorizer(Some(|ctx: AuthContext<'_>| {
        let allowed = ctx.accessor.is_none()
            && match ctx.action {
                AuthAction::Read {
                    table_name: "prompt_library",
                    ..
                }
                | AuthAction::Insert {
                    table_name: "prompt_library",
                }
                | AuthAction::Update {
                    table_name: "prompt_library",
                    ..
                }
                | AuthAction::Delete {
                    table_name: "prompt_library",
                } => ctx.database_name == Some("main"),
                AuthAction::Select | AuthAction::Transaction { .. } => true,
                _ => false,
            };
        if allowed {
            Authorization::Allow
        } else {
            Authorization::Deny
        }
    }))?;
    Ok(())
}
fn get(db: &Connection, id: &str) -> MutationResult<Option<Value>> {
    let mut stmt = db.prepare("SELECT * FROM prompt_library WHERE id=?")?;
    let mut rows = stmt.query([id])?;
    rows.next()?
        .map(|row| entry(row).map_err(|_| Failure::Refuse))
        .transpose()
}
fn duplicate(
    db: &Connection,
    scope: &str,
    repo: Option<&str>,
    fingerprint: &str,
    exclude: Option<&str>,
) -> MutationResult<Option<Value>> {
    let mut stmt=db.prepare("SELECT * FROM prompt_library WHERE scope=? AND (scope='global' OR repo_path=?) AND body_fingerprint=? AND (? IS NULL OR id!=?) LIMIT 1")?;
    let mut rows = stmt.query(params![scope, repo, fingerprint, exclude, exclude])?;
    rows.next()?
        .map(|row| entry(row).map_err(|_| Failure::Refuse))
        .transpose()
}
fn positive(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n > 0.0 && n <= SAFE_INTEGER && n.fract() == 0.0)
}
fn payload(body: &[u8], create: bool) -> MutationResult<Value> {
    if std::str::from_utf8(body).is_err() {
        return Err(Failure::Refuse);
    }
    let body = body.strip_prefix(b"\xef\xbb\xbf").unwrap_or(body);
    let p: Value = serde_json::from_slice(body).map_err(|err| {
        let message = err.to_string();
        // JSON.parse permits lone surrogates, out-of-range numbers and deeper
        // nesting. Rust cannot safely map them; refuse before any commit.
        if ["surrogate", "number out of range", "recursion limit"]
            .iter()
            .any(|s| message.contains(s))
        {
            Failure::Refuse
        } else {
            invalid("invalid_request", "Request body must be a JSON object.")
        }
    })?;
    if !p.is_object() {
        return Err(invalid(
            "invalid_request",
            "Request body must be a JSON object.",
        ));
    }
    if (create || p.get("title").is_some()) && !p["title"].is_string() {
        return Err(invalid("invalid_title", "title must be a string."));
    }
    if !create && p.get("expectedUpdatedAt").is_some_and(|n| !positive(n)) {
        return Err(invalid(
            "invalid_revision",
            "expectedUpdatedAt must be a positive integer.",
        ));
    }
    if (create || p.get("body").is_some()) && !p["body"].is_string() {
        return Err(invalid("invalid_body", "body must be a string."));
    }
    if p.get("tags").is_some_and(|tags| {
        !tags
            .as_array()
            .is_some_and(|tags| tags.iter().all(Value::is_string))
    }) {
        return Err(invalid("invalid_tags", "tags must be an array of strings."));
    }
    if p.get("scope").is_some_and(|v| v != "global" && v != "repo") {
        return Err(invalid("invalid_scope", "scope must be global or repo."));
    }
    if p.get("repoPath")
        .is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return Err(invalid(
            "invalid_repo_path",
            "repoPath must be a string or null.",
        ));
    }
    Ok(p)
}
fn bounded(
    value: &str,
    max: usize,
    empty_code: &str,
    empty_message: &str,
    long_code: &str,
    long_message: &str,
) -> MutationResult<String> {
    let value = trim(value);
    if value.is_empty() {
        return Err(invalid(empty_code, empty_message));
    }
    if value.encode_utf16().count() > max {
        return Err(invalid(long_code, long_message));
    }
    Ok(value.to_owned())
}
struct Fields {
    title: String,
    body: String,
    tags: Value,
    scope: String,
    repo: Option<String>,
    fingerprint: String,
}
fn fields(p: &Value, existing: Option<&Value>) -> MutationResult<Fields> {
    let choose = |key| p.get(key).or_else(|| existing.and_then(|e| e.get(key)));
    // TS only normalizes supplied update fields; existing values are retained.
    let title = if let Some(v) = p.get("title") {
        bounded(
            v.as_str().ok_or(Failure::Refuse)?,
            120,
            "title_required",
            "A prompt title is required.",
            "title_too_long",
            "Prompt titles must be 120 characters or fewer.",
        )?
    } else {
        existing
            .and_then(|e| e["title"].as_str())
            .ok_or(Failure::Refuse)?
            .to_owned()
    };
    let body = if let Some(v) = p.get("body") {
        bounded(
            &v.as_str()
                .ok_or(Failure::Refuse)?
                .replace("\r\n", "\n")
                .replace('\r', "\n"),
            100000,
            "body_required",
            "Prompt text is required.",
            "body_too_long",
            "Prompt text must be 100000 characters or fewer.",
        )?
    } else {
        existing
            .and_then(|e| e["body"].as_str())
            .ok_or(Failure::Refuse)?
            .to_owned()
    };
    let tags = if let Some(v) = p.get("tags") {
        let input = v.as_array().ok_or(Failure::Refuse)?;
        if input.len() > 12 {
            return Err(invalid(
                "too_many_tags",
                "A prompt can have at most 12 tags.",
            ));
        }
        let mut result = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for tag in input {
            let tag = tag
                .as_str()
                .ok_or(Failure::Refuse)?
                .split(whitespace)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if tag.is_empty() {
                continue;
            }
            if tag.encode_utf16().count() > 32 {
                return Err(invalid(
                    "tag_too_long",
                    "Prompt tags must be 32 characters or fewer.",
                ));
            }
            if seen.insert(tag.to_lowercase()) {
                result.push(tag);
            }
        }
        json!(result)
    } else {
        existing.map(|e| e["tags"].clone()).unwrap_or(json!([]))
    };
    let scope = choose("scope")
        .and_then(Value::as_str)
        .unwrap_or("global")
        .to_owned();
    if !matches!(scope.as_str(), "global" | "repo") {
        return Err(invalid(
            "invalid_scope",
            "Prompt scope must be global or repo.",
        ));
    }
    let repo = if scope == "global" {
        None
    } else {
        Some(bounded(
            choose("repoPath").and_then(Value::as_str).unwrap_or(""),
            4096,
            "repo_path_required",
            "A repo-scoped prompt requires repoPath.",
            "repo_path_too_long",
            "repoPath must be 4096 characters or fewer.",
        )?)
    };
    let stable = body
        .split('\n')
        .map(|line| line.trim_end_matches([' ', '\t']))
        .collect::<Vec<_>>()
        .join("\n");
    let fingerprint = format!("{:x}", Sha256::digest(trim(&stable).as_bytes()));
    Ok(Fields {
        title,
        body,
        tags,
        scope,
        repo,
        fingerprint,
    })
}
fn now() -> MutationResult<i64> {
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| Failure::Refuse)?
        .as_millis();
    i64::try_from(time).map_err(|_| Failure::Refuse)
}
fn delete_revision(params: &Params) -> MutationResult<Option<i64>> {
    let Some(raw) = params.get("expectedUpdatedAt") else {
        return Ok(None);
    };
    let raw = trim(raw);
    // Number(), unlike parseInt, accepts complete hexadecimal/binary/octal input.
    let value = if let Some(raw) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
        u64::from_str_radix(raw, 16).ok().map(|v| v as f64)
    } else if let Some(raw) = raw.strip_prefix("0b").or_else(|| raw.strip_prefix("0B")) {
        u64::from_str_radix(raw, 2).ok().map(|v| v as f64)
    } else if let Some(raw) = raw.strip_prefix("0o").or_else(|| raw.strip_prefix("0O")) {
        u64::from_str_radix(raw, 8).ok().map(|v| v as f64)
    } else {
        raw.parse::<f64>().ok()
    };
    match value {
        Some(n) if n > 0.0 && n <= SAFE_INTEGER && n.fract() == 0.0 => Ok(Some(n as i64)),
        _ => Err(invalid(
            "invalid_revision",
            "expectedUpdatedAt must be a positive integer.",
        )),
    }
}
fn mutate(
    db: &Connection,
    path: &str,
    method: &str,
    payload: Option<&Value>,
    create_fields: Option<Fields>,
    revision: Option<i64>,
) -> MutationResult<(StatusCode, Value)> {
    let success = |prompt| {
        (
            StatusCode::OK,
            json!({"schema":"o8/prompt-library.entry/v1","ok":true,"prompt":prompt}),
        )
    };
    if path == "/api/prompt-library" {
        let f = create_fields.ok_or(Failure::Refuse)?;
        if let Some(prompt) = duplicate(db, &f.scope, f.repo.as_deref(), &f.fingerprint, None)? {
            return Ok((
                StatusCode::OK,
                json!({"schema":"o8/prompt-library.entry/v1","ok":true,"created":false,"prompt":prompt}),
            ));
        }
        let id = format!("prompt-{}", uuid::Uuid::new_v4());
        let now = now()?;
        let changed=db.execute("INSERT OR IGNORE INTO prompt_library (id,title,body,body_fingerprint,tags_json,scope,repo_path,source_kind,source_id,created_at,updated_at,last_used_at,use_count) VALUES (?,?,?,?,?,?,?,'manual',NULL,?,?,NULL,0)", params![id,f.title,f.body,f.fingerprint,f.tags.to_string(),f.scope,f.repo,now,now])?;
        if changed != 1 {
            return Err(Failure::Refuse);
        }
        let prompt = get(db, &id)?.ok_or(Failure::Refuse)?;
        return Ok((
            StatusCode::CREATED,
            json!({"schema":"o8/prompt-library.entry/v1","ok":true,"created":true,"prompt":prompt}),
        ));
    }
    let id = id(path).ok_or(Failure::Refuse)?;
    if path.ends_with("/use") {
        db.execute(
            "UPDATE prompt_library SET last_used_at=?,use_count=use_count+1 WHERE id=?",
            params![now()?, id],
        )?;
        return Ok(success(get(db, id)?.ok_or_else(missing)?));
    }
    if method == "DELETE" {
        let changed = if let Some(rev) = revision {
            db.execute(
                "DELETE FROM prompt_library WHERE id=? AND updated_at=?",
                params![id, rev],
            )?
        } else {
            db.execute("DELETE FROM prompt_library WHERE id=?", [id])?
        };
        if changed == 0 {
            return Err(if revision.is_some() && get(db, id)?.is_some() {
                stale()
            } else {
                missing()
            });
        }
        return Ok((
            StatusCode::OK,
            json!({"schema":"o8/prompt-library.delete/v1","ok":true,"deletedId":id}),
        ));
    }
    let p = payload.ok_or(Failure::Refuse)?;
    let existing = get(db, id)?.ok_or_else(missing)?;
    if p.get("expectedUpdatedAt")
        .is_some_and(|v| v.as_f64() != existing["updatedAt"].as_f64())
    {
        return Err(stale());
    }
    let f = fields(p, Some(&existing))?;
    if let Some(prompt) = duplicate(db, &f.scope, f.repo.as_deref(), &f.fingerprint, Some(id))? {
        let mut failure = error(
            StatusCode::CONFLICT,
            "duplicate_prompt",
            "A prompt with this body already exists in the selected scope.",
        );
        if let Failure::Reply(_, ref mut body) = failure {
            body["error"]["existing"] = prompt;
        }
        return Err(failure);
    }
    let old = existing["updatedAt"].as_i64().ok_or(Failure::Refuse)?;
    let updated = now()?.max(old.checked_add(1).ok_or(Failure::Refuse)?);
    if updated as f64 > SAFE_INTEGER {
        return Err(Failure::Refuse);
    }
    let changed=db.execute("UPDATE prompt_library SET title=?,body=?,body_fingerprint=?,tags_json=?,scope=?,repo_path=?,updated_at=? WHERE id=? AND updated_at=?",params![f.title,f.body,f.fingerprint,f.tags.to_string(),f.scope,f.repo,updated,id,old])?;
    if changed != 1 {
        return Err(stale());
    }
    Ok(success(get(db, id)?.ok_or(Failure::Refuse)?))
}
pub(super) fn write(
    store: &ReadContext<'_>,
    path: &str,
    params: &Params,
    method: &str,
    body: &[u8],
) -> Response {
    if store
        .defaults_context
        .as_ref()
        .is_none_or(|v| v["promptWriteAuthority"] != true)
    {
        return unavailable();
    }
    let result = (|| -> MutationResult<Response> {
        // Preserve the route/store validation order even if SQLite is unavailable.
        let create = path == "/api/prompt-library";
        let payload = if create || method == "PATCH" {
            Some(payload(body, create)?)
        } else {
            None
        };
        let create_fields = if create {
            Some(fields(payload.as_ref().ok_or(Failure::Refuse)?, None)?)
        } else {
            None
        };
        let revision = if method == "DELETE" {
            delete_revision(params)?
        } else {
            None
        };
        let mut db = open(store)?;
        db.execute_batch("BEGIN IMMEDIATE")?;
        schema(&db)?;
        restrict(&mut db)?;
        let (status, body) = mutate(&db, path, method, payload.as_ref(), create_fields, revision)?;
        // Construct and bound the entire answer BEFORE commit. Once committed,
        // return this answer, never unavailable()/a replay through Node.
        let bytes = serde_json::to_vec(&body).map_err(|_| Failure::Refuse)?;
        if bytes.len() > RESPONSE_LIMIT {
            return Err(Failure::Refuse);
        }
        let changed = !create || body["created"] == true;
        let surface = body["prompt"]["id"]
            .as_str()
            .or_else(|| body["deletedId"].as_str())
            .unwrap_or("")
            .to_owned();
        let mut response = reply(status, body);
        if db.execute_batch("COMMIT").is_err() {
            // A commit attempt is a terminal write outcome: never replay it.
            return Ok(reply(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"schema":"o8/prompt-library.error/v1","ok":false,"error":{"code":"prompt_library_failed","message":"The prompt library request could not be completed."}}),
            ));
        }
        let action = if create {
            "prompt-library.create"
        } else if method == "PATCH" {
            "prompt-library.edit"
        } else if method == "DELETE" {
            "prompt-library.delete"
        } else {
            "prompt-library.use"
        };
        if changed {
            super::commit_notice::committed(&mut response, action, &surface);
        }
        Ok(response)
    })();
    match result {
        Ok(response) => response,
        Err(Failure::Reply(status, body)) => reply(status, body),
        Err(Failure::Refuse) => unavailable(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connection_authorizer_only_allows_prompt_dml() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(SCHEMA).unwrap();
        db.execute_batch("CREATE TABLE unrelated (id TEXT)")
            .unwrap();
        restrict(&mut db).unwrap_or_else(|_| panic!("authorizer unavailable"));
        assert!(db.execute("DELETE FROM prompt_library", []).is_ok());
        assert!(db
            .execute("INSERT INTO unrelated VALUES ('no')", [])
            .is_err());
        assert!(db.execute_batch("DROP TABLE prompt_library").is_err());
        assert!(db
            .execute_batch("ATTACH DATABASE ':memory:' AS other")
            .is_err());
    }
}
