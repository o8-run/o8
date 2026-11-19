//! Operator session-rule writes and the complete correction-hold commit.
use super::prompt_library::trim;
use super::session_rule_lease::{open, Lease};
use super::*;
use rusqlite::{params, OptionalExtension};
pub(super) fn restrict(db: &mut Connection, lease: bool) -> Result<(), ()> {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    db.authorizer(Some(move |ctx: AuthContext<'_>| {
        let table = |name: &str| {
            if lease {
                name == "workspace_lifecycle_leases"
            } else {
                matches!(
                    name,
                    "session_rules" | "worker_corrections" | "worker_correction_deliveries"
                )
            }
        };
        let allow = ctx.accessor.is_none()
            && match ctx.action {
                AuthAction::Read { table_name, .. } => {
                    ctx.database_name == Some("main")
                        && (table(table_name) || !lease && table_name == "worker_correction_fences")
                }
                AuthAction::Insert { table_name }
                | AuthAction::Delete { table_name }
                | AuthAction::Update { table_name, .. } => {
                    ctx.database_name == Some("main") && table(table_name)
                }
                AuthAction::Select | AuthAction::Transaction { .. } => true,
                AuthAction::Function { function_name } => !lease && function_name == "datetime",
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
fn failure(code: &str, status: StatusCode) -> Response {
    reply(
        status,
        json!({"ok":false,"error":{"code":code,"message":if status.is_server_error(){format!("o8 API error ({})",status.as_u16())}else{code.to_owned()}}}),
    )
}
fn hold_failure(status: StatusCode, message: &str) -> Response {
    reply(
        status,
        json!({"ok":false,"error":{"code":"session_rule_correction_failed","message":message}}),
    )
}
fn invalid(message: &str) -> Response {
    reply(
        StatusCode::BAD_REQUEST,
        json!({"ok":false,"error":{"code":"invalid_request","message":message}}),
    )
}
fn rule_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"threadId":r.get::<_,String>(1)?,"text":row_text(r,2)?,"active":r.get::<_,i64>(3)?==1,"createdAt":r.get::<_,String>(4)?,"constraint":r.get::<_,Option<String>>(5)?}),
    )
}
fn rule(db: &Connection, id: &str) -> Result<Value, ()> {
    db.query_row(
        "SELECT id,thread_id,text,active,created_at,constraint_kind FROM session_rules WHERE id=?",
        [id],
        rule_row,
    )
    .map_err(|_| ())
}
/// Only the app's native operator gate can set this private request context.
/// A Node-admitted worker must use the original thread-scoped handler.
pub(super) fn read(store: &ReadContext<'_>, params: &Params) -> Response {
    if store
        .defaults_context
        .as_ref()
        .is_none_or(|v| v["sessionRuleReadAuthority"] != true)
    {
        return unavailable();
    }
    let thread = trim(value(params, "threadId"));
    if thread.is_empty() {
        return invalid("threadId query param is required.");
    }
    let result = (|| -> Result<Value, ()> {
        let db = store.database()?;
        let mut stmt = db.prepare("SELECT id,thread_id,text,active,created_at,constraint_kind FROM session_rules WHERE thread_id=? AND active=1 ORDER BY created_at ASC,rowid ASC").map_err(|_|())?;
        let mut rules = Vec::new();
        let mut bytes = 0usize;
        for row in stmt.query_map([thread], rule_row).map_err(|_| ())? {
            let row = row.map_err(|_| ())?;
            bytes = bytes
                .checked_add(serde_json::to_vec(&row).map_err(|_| ())?.len() + 1)
                .ok_or(())?;
            if bytes > RESPONSE_LIMIT {
                return Err(());
            }
            rules.push(row);
        }
        let body = json!({"ok":true,"result":{"rules":rules}});
        if serde_json::to_vec(&body).map_err(|_| ())?.len() > RESPONSE_LIMIT {
            return Err(());
        }
        Ok(body)
    })();
    match result {
        Ok(body) => reply(StatusCode::OK, body),
        Err(()) => unavailable(),
    }
}
// Node binds a sliced lone surrogate as WTF-8; its SQLite reader decodes
// each invalid UTF-8 byte to U+FFFD. Keep both the persisted bytes and response.
pub(super) fn row_text(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<String> {
    match row.get_ref(index)? {
        rusqlite::types::ValueRef::Text(bytes) => Ok(String::from_utf8_lossy(bytes).into_owned()),
        _ => row.get(index),
    }
}
pub(super) fn clipped_text(text: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut units = 0;
    for ch in trim(text).chars() {
        if units == 2000 {
            break;
        }
        if units + ch.len_utf16() > 2000 {
            let high = 0xd800 + ((ch as u32 - 0x10000) >> 10);
            bytes.extend([
                0xe0 | (high >> 12) as u8,
                0x80 | ((high >> 6) & 63) as u8,
                0x80 | (high & 63) as u8,
            ]);
            break;
        }
        let mut encoded = [0; 4];
        bytes.extend_from_slice(ch.encode_utf8(&mut encoded).as_bytes());
        units += ch.len_utf16();
    }
    bytes
}
fn insert_rule(
    db: &Connection,
    thread: &str,
    text: &str,
    constraint: Option<&str>,
) -> Result<Value, ()> {
    let text = clipped_text(text);
    let id = uuid::Uuid::new_v4().to_string();
    db.execute("INSERT INTO session_rules (id,thread_id,text,active,created_at,constraint_kind) VALUES (?,?,?,1,datetime('now'),?)",params![id,thread,rusqlite::types::ToSqlOutput::Borrowed(rusqlite::types::ValueRef::Text(&text)),constraint]).map_err(|_|())?;
    rule(db, &id)
}
fn receipt(db: &Connection, id: &str) -> Result<Option<Value>, ()> {
    let row=db.query_row("SELECT repo_path,thread_id,payload_json,rule_id,created_at FROM worker_corrections WHERE id=?",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,i64>(4)?))).optional().map_err(|_|())?;
    let Some((repo, thread, payload, rule, created)) = row else {
        return Ok(None);
    };
    let payload: Value = serde_json::from_str(&payload).map_err(|_| ())?;
    let mut stmt=db.prepare("SELECT surface_id,run_id,status,note FROM worker_correction_deliveries WHERE correction_id=? ORDER BY surface_id").map_err(|_|())?;
    let deliveries=stmt.query_map([id],|r|Ok(json!({"surfaceId":r.get::<_,String>(0)?,"runId":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"note":r.get::<_,String>(3)?}))).map_err(|_|())?.collect::<Result<Vec<_>,_>>().map_err(|_|())?;
    Ok(Some(
        json!({"id":id,"repoPath":repo,"threadId":thread,"payload":payload,"ruleId":rule,"createdAt":created,"deliveries":deliveries}),
    ))
}
fn text<'a>(p: &'a Value, key: &str, max: usize) -> Result<&'a str, ()> {
    let s = p[key].as_str().ok_or(())?;
    if s.is_empty() || s.encode_utf16().count() > max {
        return Err(());
    }
    Ok(s)
}
fn payload_shape(p: &Value) -> bool {
    p.as_object().is_some_and(|o| {
        o.len() == 4
            && ["message", "mode", "holdMerges", "targets"]
                .iter()
                .all(|key| o.contains_key(*key))
    })
}
fn correction(db: &Connection, p: &Value) -> Result<(Value, bool), (StatusCode, &'static str)> {
    let bad = (StatusCode::BAD_REQUEST, "Invalid correction-hold data.");
    let err = (
        StatusCode::INTERNAL_SERVER_ERROR,
        "Native correction hold transaction failed. No delivery was attempted.",
    );
    let id = text(p, "id", 120).map_err(|_| bad)?;
    if id.len() < 8
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(bad);
    }
    let repo = text(p, "repoPath", 4096).map_err(|_| bad)?;
    let thread = text(p, "threadId", 4096).map_err(|_| bad)?;
    if trim(thread) != thread || !payload_shape(&p["payload"]) {
        return Err(bad);
    }
    let payload = &p["payload"];
    let message = text(payload, "message", 2000).map_err(|_| bad)?;
    if trim(message) != message
        || payload["holdMerges"] != true
        || !matches!(
            payload["mode"].as_str(),
            Some("send" | "pause-and-send" | "stop")
        )
    {
        return Err(bad);
    }
    let targets = payload["targets"].as_array().ok_or(bad)?;
    if targets.len() > 8 {
        return Err(bad);
    }
    let mut seen = std::collections::HashSet::new();
    let mut scopes = vec![format!("parent:{repo}\n{thread}")];
    for target in targets {
        let surface = text(target, "surfaceId", 240).map_err(|_| bad)?;
        text(target, "runId", 160).map_err(|_| bad)?;
        if !seen.insert(surface) {
            return Err(bad);
        }
        scopes.push(format!("worker:{surface}"));
    }
    if let Some(prior) = receipt(db, id).map_err(|_| err)? {
        if prior["repoPath"] != repo || prior["threadId"] != thread || prior["payload"] != *payload
        {
            return Err((
                StatusCode::CONFLICT,
                "This correction identity belongs to another request.",
            ));
        }
        return Ok((prior, false));
    }
    let fences = p["fences"].as_array().ok_or(bad)?;
    if fences.len() != scopes.len() {
        return Err(bad);
    }
    for (fence, scope) in fences.iter().zip(scopes) {
        if fence["scope"] != scope {
            return Err(bad);
        }
        let version = fence["version"].as_i64().filter(|v| *v >= 0).ok_or(bad)?;
        let current = db
            .query_row(
                "SELECT generation FROM worker_correction_fences WHERE scope=?",
                [scope],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(|_| err)?
            .unwrap_or(0);
        if version != current {
            return Err((
                StatusCode::CONFLICT,
                "Parent or worker stopped during correction preparation. Nothing was admitted.",
            ));
        }
    }
    let rule = insert_rule(db, thread, message, Some("no_merge")).map_err(|_| err)?;
    // Preserve JSON.stringify's canonical property order for Node's existing
    // same-id replay check; do not serialize a sorted serde_json object here.
    let targets_json = targets
        .iter()
        .map(|t| {
            format!(
                "{{\"surfaceId\":{},\"runId\":{}}}",
                t["surfaceId"], t["runId"]
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let serialized = format!(
        "{{\"message\":{},\"mode\":{},\"holdMerges\":true,\"targets\":[{}]}}",
        payload["message"], payload["mode"], targets_json
    );
    let now = chrono::Utc::now().timestamp_millis();
    db.execute("INSERT INTO worker_corrections (id,repo_path,thread_id,payload_json,rule_id,created_at) VALUES (?,?,?,?,?,?)",params![id,repo,thread,serialized,rule["id"].as_str(),now]).map_err(|_|err)?;
    for target in targets {
        db.execute("INSERT INTO worker_correction_deliveries (correction_id,surface_id,run_id,status,note,updated_at) VALUES (?,?,?,'pending','Awaiting delivery.',?)",params![id,target["surfaceId"].as_str(),target["runId"].as_str(),now]).map_err(|_|err)?;
    }
    receipt(db, id)
        .map_err(|_| err)?
        .ok_or(err)
        .map(|r| (r, true))
}
pub(super) fn write(
    store: &ReadContext<'_>,
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
    let hold = value(params, "operation") == "correction-hold";
    let code = if hold {
        "session_rule_correction_failed"
    } else if method == "DELETE" {
        "session_rules_remove_failed"
    } else {
        "session_rules_add_failed"
    };
    let p: Value = if method == "POST" {
        let body = body.strip_prefix(b"\xef\xbb\xbf").unwrap_or(body);
        match serde_json::from_slice(body) {
            Ok(v) => v,
            Err(error) => {
                // Same safe subset as prompt mutations: valid JS-only JSON
                // representations refuse before commit; Node's writer is fenced.
                if ["surrogate", "number out of range", "recursion limit"]
                    .iter()
                    .any(|s| error.to_string().contains(s))
                {
                    return unavailable();
                }
                return invalid("Invalid JSON body.");
            }
        }
    } else {
        Value::Null
    };
    if method == "POST" && !p.is_object() {
        return invalid("Invalid JSON body.");
    }
    let mut db = match open(&store.directory, &store.database) {
        Ok(v) => v,
        Err(_) => return failure(code, StatusCode::INTERNAL_SERVER_ERROR),
    };
    let id = trim(value(params, "id"));
    let thread = if method == "DELETE" {
        if id.is_empty() {
            return invalid("id query param is required.");
        }
        match db
            .query_row(
                "SELECT thread_id FROM session_rules WHERE id=?",
                [id],
                |r| r.get::<_, String>(0),
            )
            .optional()
        {
            Ok(Some(v)) => v,
            Ok(None) => {
                return reply(
                    StatusCode::OK,
                    json!({"ok":true,"result":{"removed":false}}),
                )
            }
            Err(_) => return failure(code, StatusCode::INTERNAL_SERVER_ERROR),
        }
    } else {
        let thread = p["threadId"].as_str().map(trim).unwrap_or("");
        if thread.is_empty() {
            return invalid("threadId is required.");
        }
        if !hold {
            if p["text"].as_str().is_none_or(|s| trim(s).is_empty()) {
                return invalid("text is required.");
            }
            if p.get("constraint")
                .is_some_and(|v| !v.is_null() && v != "no_merge")
            {
                return invalid("Unknown session-rule constraint.");
            }
        }
        thread.to_owned()
    };
    let lease = match Lease::acquire(&store.directory, &store.database, &thread) {
        Ok(v) => v,
        Err(reason) => {
            return if hold {
                hold_failure(StatusCode::CONFLICT, reason)
            } else {
                failure(code, StatusCode::INTERNAL_SERVER_ERROR)
            }
        }
    };
    let mut reason = None;
    let mut notice = None;
    let result = (|| -> Result<Response, StatusCode> {
        db.execute_batch("BEGIN IMMEDIATE")
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        restrict(&mut db, false).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let mut fresh_hold = false;
        let result = if hold {
            let (receipt, fresh) = correction(&db, &p).map_err(|(status, message)| {
                reason = Some(message);
                status
            })?;
            fresh_hold = fresh;
            receipt
        } else if method == "DELETE" {
            let removed = db
                .execute("DELETE FROM session_rules WHERE id=?", [id])
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                > 0;
            json!({"removed":removed})
        } else {
            json!({"rule":insert_rule(&db,&thread,p["text"].as_str().unwrap(),p["constraint"].as_str()).map_err(|_|StatusCode::INTERNAL_SERVER_ERROR)?})
        };
        let changed = if hold {
            fresh_hold
        } else if method == "DELETE" {
            result["removed"] == true
        } else {
            true
        };
        let value = json!({"ok":true,"result":result});
        if serde_json::to_vec(&value)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .len()
            > RESPONSE_LIMIT
        {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        let answer = reply(StatusCode::OK, value);
        db.execute_batch("COMMIT")
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if changed {
            notice = super::commit_notice::CommitNotice::new(
                if method == "DELETE" {
                    "session-rule.remove"
                } else {
                    "session-rule.add"
                },
                &thread,
            );
        }
        Ok(answer)
    })();
    // End a failed transaction BEFORE releasing the separately owned lease.
    if db.is_autocommit() == false {
        let _ = db.execute_batch("ROLLBACK");
    }
    drop(db);
    let release_failed = lease.release().is_err();
    if release_failed && !hold && result.is_ok() {
        // COMMIT is confirmed. Keep the plain receipt and its commit notice;
        // release diagnostics must not turn durable success into an error.
        eprintln!("o8d: session-rule lease release failed after committed mutation");
    }
    let mut answer = if release_failed && (hold || result.is_err()) {
        failure(code, StatusCode::INTERNAL_SERVER_ERROR)
    } else {
        result.unwrap_or_else(|status| if hold {hold_failure(status,reason.unwrap_or("Native correction hold outcome could not be confirmed. No delivery was attempted."))}else{failure(code, status)})
    };
    if let Some(notice) = notice {
        answer.extensions_mut().insert(notice);
    }
    answer
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn read_requires_native_operator_context_before_validation_or_database_access() {
        let mut store = Store {
            directory: PathBuf::from("/nonexistent/session-rule-fixture"),
            database: PathBuf::from("/nonexistent/session-rule-fixture/missing.db"),
            defaults_context: None,
            redaction: None,
        };
        let params = Params::new();
        assert_eq!(
            read(&ReadContext::new(&store), &params).status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        store.defaults_context = Some(json!({"promptWriteAuthority":true}));
        assert_eq!(
            read(&ReadContext::new(&store), &params).status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        store.defaults_context = Some(json!({"sessionRuleReadAuthority":true}));
        assert_eq!(
            read(&ReadContext::new(&store), &params).status(),
            StatusCode::BAD_REQUEST
        );
    }
    #[test]
    fn clipped_astral_matches_node_sqlite_wtf8_bytes() {
        let prefix = "a".repeat(1999);
        let bytes = clipped_text(&(prefix.clone() + "𝒳"));
        assert_eq!(&bytes[1999..], &[0xed, 0xa0, 0xb5]);
        assert_eq!(String::from_utf8_lossy(&bytes), prefix + "���");
        assert_eq!(clipped_text("  雪𝒳  "), "雪𝒳".as_bytes());
    }
}
