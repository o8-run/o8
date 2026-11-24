//! Single product owner for the phone's inline diff comments. No row cache.
use super::text::trim;
use super::session_rules::{clipped_text, row_text};
use super::*;
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    params,
    types::{ToSqlOutput, ValueRef},
};
const COLUMNS: &str = "id,session_key,path,line_number,side,text,created_at,resolved_at";
pub(super) fn matches(path: &str, method: &str) -> bool {
    matches!(
        (path, method),
        ("/api/mobile/diff-comment", "POST") | ("/api/mobile/diff-comments", "GET")
    )
}
fn answer(status: StatusCode, body: Value) -> Response {
    let mut response = reply(status, body);
    response.headers_mut().remove("cache-control"); // NextResponse.json has none.
    response
}
fn failed() -> Response {
    answer(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error":"Native route unavailable"}),
    )
}
fn invalid() -> Response {
    answer(
        StatusCode::BAD_REQUEST,
        json!({"error":"sessionKey, path, text, and a valid lineNumber are required"}),
    )
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let line: f64 = r.get(3)?;
    if !line.is_finite() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let line = if line >= i64::MIN as f64 && line < -(i64::MIN as f64) && line.fract() == 0.0 {
        json!(line as i64)
    } else {
        json!(line)
    };
    Ok(
        json!({"id":row_text(r,0)?,"sessionKey":row_text(r,1)?,"path":row_text(r,2)?,"lineNumber":line,
        "side":if r.get::<_,String>(4)?=="old" {"old"} else {"new"},"text":row_text(r,5)?,
        "createdAt":row_text(r,6)?,"resolvedAt":r.get::<_,Option<String>>(7)?}),
    )
}
fn list(store: &ReadContext<'_>, p: &Params) -> Response {
    let key = trim(value(p, "sessionKey"));
    if key.is_empty() {
        return answer(
            StatusCode::BAD_REQUEST,
            json!({"error":"sessionKey required"}),
        );
    }
    let result = (|| -> Result<Value, ()> {
        let db = store.database()?;
        let sql = format!("SELECT {COLUMNS} FROM mobile_diff_comments WHERE session_key=?{} ORDER BY created_at DESC,rowid DESC",if value(p,"openOnly")=="1" {" AND resolved_at IS NULL"} else {""});
        let mut stmt = db.prepare(&sql).map_err(|_| ())?;
        let mut comments = Vec::new();
        let mut size = 32usize;
        for value in stmt.query_map([key], row).map_err(|_| ())? {
            let value = value.map_err(|_| ())?;
            size = size
                .checked_add(serde_json::to_vec(&value).map_err(|_| ())?.len() + 1)
                .ok_or(())?;
            if size > RESPONSE_LIMIT {
                return Err(());
            }
            comments.push(value);
        }
        Ok(json!({"comments":comments}))
    })();
    match result {
        Ok(v) => answer(StatusCode::OK, v),
        Err(()) => unavailable(),
    }
}
fn open(store: &ReadContext<'_>) -> Result<Connection, ()> {
    let marker: Value =
        serde_json::from_slice(&store.file(&store.directory.join(".db-migrated-v53"), 4096)?)
            .map_err(|_| ())?;
    if marker["schemaVersion"] != 53 {
        return Err(());
    }
    let path = store.database.canonicalize().map_err(|_| ())?;
    if !path.starts_with(&store.directory)
        || !path.is_file()
        || std::fs::symlink_metadata(&store.database)
            .map_err(|_| ())?
            .file_type()
            .is_symlink()
    {
        return Err(());
    }
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ())?;
    db.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|_| ())?;
    let mut stmt = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='mobile_diff_comments' AND sql IS NOT NULL").map_err(|_|())?;
    let mut actual = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|_| ())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ())?
        .iter()
        .map(|s| super::text::normalize_sql(s))
        .collect::<Vec<_>>();
    let mut expected = include_str!("mobile_diff_comments.sql")
        .split(';')
        .filter(|s| !s.trim().is_empty())
        .map(super::text::normalize_sql)
        .collect::<Vec<_>>();
    actual.sort();
    expected.sort();
    if actual != expected {
        return Err(());
    }
    drop(stmt);
    Ok(db)
}
fn restricted(db: &mut Connection) -> Result<(), ()> {
    db.authorizer(Some(|ctx: AuthContext<'_>| {
        let allow = ctx.accessor.is_none()
            && match ctx.action {
                AuthAction::Read { table_name, .. } | AuthAction::Insert { table_name } => {
                    ctx.database_name == Some("main") && table_name == "mobile_diff_comments"
                }
                AuthAction::Select | AuthAction::Transaction { .. } => true,
                AuthAction::Function { function_name } => function_name == "datetime",
                _ => false,
            };
        if allow {
            Authorization::Allow
        } else {
            Authorization::Deny
        }
    }))
    .map_err(|_| ())
}
// Number() on the JSON values the route accepts. Object coercion that would
// throw in JS remains a whole-request error, never a partial insert.
fn primitive(value: &Value) -> Result<String, ()> {
    Ok(match value {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => ryu_js::Buffer::new()
            .format(n.as_f64().ok_or(())?)
            .to_owned(),
        Value::String(s) => s.clone(),
        Value::Array(values) => values
            .iter()
            .map(primitive)
            .collect::<Result<Vec<_>, _>>()?
            .join(","),
        Value::Object(values) if values.contains_key("toString") => return Err(()),
        Value::Object(_) => "[object Object]".to_owned(),
    })
}
fn radix_number(digits: &str, base: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let (mut mantissa, mut length, mut guard, mut sticky) = (0u64, 0usize, false, false);
    for ch in digits.chars() {
        let Some(digit) = ch.to_digit(base) else {
            return f64::NAN;
        };
        for shift in (0..base.trailing_zeros()).rev() {
            let bit = (digit >> shift) & 1 != 0;
            if length == 0 && !bit {
                continue;
            }
            if length < 53 {
                mantissa = (mantissa << 1) | u64::from(bit);
            } else if length == 53 {
                guard = bit;
            } else {
                sticky |= bit;
            }
            length += 1;
        }
    }
    if length <= 53 {
        return mantissa as f64;
    }
    if length > 1024 {
        return f64::INFINITY;
    }
    // Round the whole radix integer once, as Number() does, rather than
    // accumulating intermediate floating-point rounding on long strings.
    if guard && (sticky || mantissa & 1 != 0) {
        mantissa += 1;
    }
    mantissa as f64 * 2.0f64.powi((length - 53) as i32)
}
fn number(value: Option<&Value>) -> Result<f64, ()> {
    let Some(value) = value else {
        return Ok(f64::NAN);
    };
    match value {
        Value::Null => Ok(0.0),
        Value::Bool(v) => Ok(if *v { 1.0 } else { 0.0 }),
        Value::Number(v) => v.as_f64().ok_or(()),
        _ => {
            let raw = primitive(value)?;
            let raw = trim(&raw);
            if raw.is_empty() {
                return Ok(0.0);
            }
            for (prefix, base) in [
                ("0x", 16),
                ("0X", 16),
                ("0b", 2),
                ("0B", 2),
                ("0o", 8),
                ("0O", 8),
            ] {
                if let Some(digits) = raw.strip_prefix(prefix) {
                    return Ok(radix_number(digits, base));
                }
            }
            // Rust accepts inf/NaN aliases that JS Number does not.
            if raw
                .bytes()
                .any(|b| b.is_ascii_alphabetic() && !matches!(b, b'e' | b'E'))
            {
                return Ok(f64::NAN);
            }
            Ok(raw.parse::<f64>().unwrap_or(f64::NAN))
        }
    }
}
fn create(store: &ReadContext<'_>, bytes: &[u8]) -> Response {
    let p: Value = match serde_json::from_slice(bytes) {
        Ok(p) => p,
        Err(e) => {
            if ["surrogate", "number out of range", "recursion limit"]
                .iter()
                .any(|s| e.to_string().contains(s))
            {
                return unavailable();
            }
            return answer(StatusCode::BAD_REQUEST, json!({"error":"Invalid JSON"}));
        }
    };
    if p.is_null() {
        return failed();
    } // Property access on null throws in TS.
    let string = |key| trim(p.get(key).and_then(Value::as_str).unwrap_or(""));
    let (session, path, text) = (string("sessionKey"), string("path"), string("text"));
    let line = match number(p.get("lineNumber")) {
        Ok(n) => n,
        Err(()) => return failed(),
    };
    if session.is_empty()
        || path.is_empty()
        || text.is_empty()
        || !line.is_finite()
        || line.fract() != 0.0
        || line < 0.0
    {
        return invalid();
    }
    let side = if p["side"] == "old" { "old" } else { "new" };
    let result = (|| -> Result<Value, ()> {
        let mut db = open(store)?;
        restricted(&mut db)?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| ())?;
        let id = uuid::Uuid::new_v4().to_string();
        let text = clipped_text(text);
        tx.execute("INSERT INTO mobile_diff_comments (id,session_key,path,line_number,side,text) VALUES (?,?,?,?,?,?)",
            params![id,session,path,line,side,ToSqlOutput::Borrowed(ValueRef::Text(&text))]).map_err(|_|())?;
        let comment = tx
            .query_row(
                &format!("SELECT {COLUMNS} FROM mobile_diff_comments WHERE id=?"),
                [&id],
                row,
            )
            .map_err(|_| ())?;
        let body = json!({"comment":comment});
        // A result too large for the transport is refused before COMMIT.
        if serde_json::to_vec(&body).map_err(|_| ())?.len() > RESPONSE_LIMIT {
            return Err(());
        }
        tx.commit().map_err(|_| ())?;
        Ok(body)
    })();
    // No fallback after COMMIT, and Node's product writers are fenced.
    match result {
        Ok(v) => answer(StatusCode::OK, v),
        Err(()) => failed(),
    }
}
pub(super) fn handle(store: &ReadContext<'_>, p: &Params, method: &str, bytes: &[u8]) -> Response {
    if store
        .defaults_context
        .as_ref()
        .is_none_or(|v| v["diffCommentAuthority"] != true)
    {
        return unavailable();
    }
    if method == "GET" {
        list(store, p)
    } else {
        create(store, bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn owned_transaction_persists_phone_shape_and_refuses_schema_or_missing_grant() {
        let root = std::env::temp_dir().join(format!("o8-diff-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join(".db-migrated-v53"), r#"{"schemaVersion":53}"#).unwrap();
        let db = Connection::open(root.join("cortex-ide.db")).unwrap();
        db.execute_batch(include_str!("mobile_diff_comments.sql"))
            .unwrap();
        let mut store = Store {
            directory: root.clone(),
            database: root.join("cortex-ide.db"),
            defaults_context: None,
            redaction: None,
        };
        let body = serde_json::to_vec(&json!({"sessionKey":" fixture-session ","path":" a.ts ","lineNumber":"0x10","side":"old","text":"a".repeat(1999)+"𝒳"})).unwrap();
        assert_eq!(
            handle(&ReadContext::new(&store), &Params::new(), "POST", &body).status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM mobile_diff_comments", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        store.defaults_context = Some(json!({"diffCommentAuthority":true}));
        let response = handle(&ReadContext::new(&store), &Params::new(), "POST", &body);
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), RESPONSE_LIMIT)
                .await
                .unwrap(),
        )
        .unwrap();
        let comment = &value["comment"];
        assert_eq!(comment["lineNumber"], 16);
        assert_eq!(comment["side"], "old");
        assert_eq!(comment["sessionKey"], "fixture-session");
        assert_eq!(comment["path"], "a.ts");
        assert!(comment["id"].is_string() && comment["createdAt"].is_string());
        assert_eq!(comment["text"], "a".repeat(1999) + "���");
        let raw = db
            .query_row("SELECT text FROM mobile_diff_comments", [], |r| {
                Ok(r.get_ref(0)?.as_bytes()?.to_vec())
            })
            .unwrap();
        assert_eq!(&raw[1999..], &[0xed, 0xa0, 0xb5]);
        // Unexpected triggers cannot turn this owner into another table's writer.
        db.execute_batch("CREATE TABLE canary(n); CREATE TRIGGER extra_write AFTER INSERT ON mobile_diff_comments BEGIN INSERT INTO canary VALUES(1); END;").unwrap();
        assert_eq!(
            handle(&ReadContext::new(&store), &Params::new(), "POST", &body).status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM mobile_diff_comments", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM canary", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn number_coercion_and_utf16_clip_match_the_phone_store() {
        for (value, expected) in [
            (json!(null), 0.0),
            (json!(true), 1.0),
            (json!("0x10"), 16.0),
            (json!([]), 0.0),
            (json!(["12"]), 12.0),
            (json!("0x20000000000001"), 9007199254740992.0),
            (json!("0x20000000000003"), 9007199254740996.0),
        ] {
            assert_eq!(number(Some(&value)).unwrap(), expected);
        }
        assert!(number(None).unwrap().is_nan());
        assert!(number(Some(&json!({}))).unwrap().is_nan());
        assert!(number(Some(&json!({"toString":null}))).is_err());
        assert_eq!(clipped_text("  old note  "), b"old note");
        assert_eq!(
            &clipped_text(&("a".repeat(1999) + "𝒳"))[1999..],
            &[0xed, 0xa0, 0xb5]
        );
    }
}
