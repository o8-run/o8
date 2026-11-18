//! Fresh prompt reads; Node retains schema, mutations and other-principal admission.
use super::*;
use rusqlite::{params_from_iter, types::Value as SqlValue};
const QUERY_MAX: usize = 200;
const LIMIT_MAX: i64 = 100;
const COLUMNS: &str = "id,title,body,body_fingerprint,tags_json,scope,repo_path,source_kind,source_id,created_at,updated_at,last_used_at,use_count";
fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn trim(value: &str) -> &str {
    value.trim_matches(whitespace)
}
fn limit(raw: Option<&String>) -> Option<i64> {
    let Some(raw) = raw else {
        return Some(50);
    };
    // Number.parseInt(value, 10) consumes a signed decimal prefix, including
    // fractional/suffixed inputs. Preserve that existing route behavior.
    let raw = raw.trim_start_matches(whitespace);
    let start = usize::from(raw.starts_with(['+', '-']));
    let digits = raw
        .get(start..)?
        .bytes()
        .take_while(u8::is_ascii_digit)
        .count();
    if digits == 0 {
        return None;
    }
    let parsed = raw[..start + digits].parse::<f64>().ok()?;
    if !parsed.is_finite() || parsed < 1.0 {
        return None;
    }
    Some(parsed.min(LIMIT_MAX as f64) as i64)
}
fn error(code: &str, message: &str) -> Response {
    reply(
        StatusCode::BAD_REQUEST,
        json!({"schema":"o8/prompt-library.error/v1","ok":false,"error":{"code":code,"message":message}}),
    )
}
fn number(row: &rusqlite::Row<'_>, key: &str) -> Result<i64, ()> {
    let value: i64 = row.get(key).map_err(|_| ())?;
    // Retain TS's JS-number semantics by deferring unsupported numeric storage.
    if value.unsigned_abs() > 9_007_199_254_740_991 {
        return Err(());
    }
    Ok(value)
}
fn entry(row: &rusqlite::Row<'_>) -> ReadResult {
    let text = |key| row.get::<_, String>(key).map_err(|_| ());
    let nullable = |key| row.get::<_, Option<String>>(key).map_err(|_| ());
    // TS catches malformed tags and emits []; native must instead defer the
    // entire list to that canonical behavior, never return a partial native list.
    let parsed: Value = serde_json::from_str(&text("tags_json")?).map_err(|_| ())?;
    let tags: Vec<_> = parsed
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let used: Option<i64> = row.get("last_used_at").map_err(|_| ())?;
    if used.is_some_and(|v| v.unsigned_abs() > 9_007_199_254_740_991) {
        return Err(());
    }
    Ok(
        json!({"id":text("id")?,"title":text("title")?,"body":text("body")?,"tags":tags,"scope":text("scope")?,"repoPath":nullable("repo_path")?,"sourceKind":text("source_kind")?,"sourceId":nullable("source_id")?,"createdAt":number(row,"created_at")?,"updatedAt":number(row,"updated_at")?,"lastUsedAt":used,"useCount":number(row,"use_count")?}),
    )
}
pub(super) fn read(store: &ReadContext<'_>, params: &Params) -> Response {
    let result = (|| -> Result<Response, ()> {
        let db = store.database()?;
        // SELECT * below intentionally matches Node. Probe all schema columns,
        // including the unused fingerprint, before accepting a native result.
        let schema = db
            .prepare("SELECT * FROM prompt_library LIMIT 0")
            .map_err(|_| ())?;
        let columns: Vec<_> = schema.column_names().collect();
        if COLUMNS.split(',').any(|name| !columns.contains(&name)) {
            return Err(());
        }
        let scope = params
            .get("scope")
            .map(String::as_str)
            .unwrap_or("available");
        if !matches!(scope, "available" | "global" | "repo" | "all") {
            return Ok(error(
                "invalid_scope_filter",
                "scope must be available, global, repo, or all.",
            ));
        }
        let Some(limit) = limit(params.get("limit")) else {
            return Ok(error("invalid_limit", "limit must be a positive integer."));
        };
        let query = trim(value(params, "query"));
        let repo = trim(value(params, "repoPath"));
        if query.encode_utf16().count() > QUERY_MAX {
            return Ok(error(
                "query_too_long",
                "Prompt search must be 200 characters or fewer.",
            ));
        }
        let mut clauses = Vec::<&str>::new();
        let mut values = Vec::<SqlValue>::new();
        match scope {
            "available" if !repo.is_empty() => {
                clauses.push("(scope = 'global' OR (scope = 'repo' AND repo_path = ?))");
                values.push(repo.to_owned().into());
            }
            "available" | "global" => clauses.push("scope = 'global'"),
            "repo" => {
                if repo.is_empty() {
                    return Ok(error(
                        "repo_path_required",
                        "Repo search requires repoPath.",
                    ));
                }
                clauses.push("scope = 'repo' AND repo_path = ?");
                values.push(repo.to_owned().into());
            }
            _ => (),
        }
        let lower = query.to_lowercase();
        for term in lower.split(whitespace).filter(|s| !s.is_empty()).take(8) {
            clauses.push(r#"(lower(title) LIKE ? ESCAPE '\' OR lower(body) LIKE ? ESCAPE '\' OR lower(tags_json) LIKE ? ESCAPE '\')"#);
            let mut pattern = String::from("%");
            for character in term.chars() {
                if matches!(character, '\\' | '%' | '_') {
                    pattern.push('\\');
                }
                pattern.push(character);
            }
            pattern.push('%');
            values.extend([
                pattern.clone().into(),
                pattern.clone().into(),
                pattern.into(),
            ]);
        }
        values.push(limit.into());
        let predicate = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let sql = format!("SELECT * FROM prompt_library {predicate} ORDER BY COALESCE(last_used_at, updated_at) DESC, updated_at DESC, created_at DESC, rowid DESC LIMIT ?");
        let mut statement = db.prepare(&sql).map_err(|_| ())?;
        let mut rows = statement.query(params_from_iter(values)).map_err(|_| ())?;
        let mut prompts = Vec::new();
        while let Some(row) = rows.next().map_err(|_| ())? {
            prompts.push(entry(row)?);
        }
        let body = json!({"schema":"o8/prompt-library.list/v1","ok":true,"prompts":prompts});
        if serde_json::to_vec(&body).map_err(|_| ())?.len() > RESPONSE_LIMIT {
            return Err(());
        }
        Ok(reply(StatusCode::OK, body))
    })();
    result.unwrap_or_else(|_| unavailable())
}

pub(super) fn single(store: &ReadContext<'_>, path: &str) -> Response {
    let result = (|| -> Result<Response, ()> {
        let id = path.strip_prefix("/api/prompt-library/").ok_or(())?;
        if id.is_empty()
            || id == "import"
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err(());
        }
        let db = store.database()?;
        let mut statement = db
            .prepare("SELECT * FROM prompt_library WHERE id = ?")
            .map_err(|_| ())?;
        if COLUMNS
            .split(',')
            .any(|name| !statement.column_names().any(|column| column == name))
        {
            return Err(());
        }
        let mut rows = statement.query([id]).map_err(|_| ())?;
        let body = if let Some(row) = rows.next().map_err(|_| ())? {
            json!({"schema":"o8/prompt-library.entry/v1","ok":true,"prompt":entry(row)?})
        } else {
            return Ok(reply(
                StatusCode::NOT_FOUND,
                json!({"schema":"o8/prompt-library.error/v1","ok":false,"error":{"code":"prompt_not_found","message":"Saved prompt not found."}}),
            ));
        };
        if serde_json::to_vec(&body).map_err(|_| ())?.len() > RESPONSE_LIMIT {
            return Err(());
        }
        Ok(reply(StatusCode::OK, body))
    })();
    result.unwrap_or_else(|_| unavailable())
}
