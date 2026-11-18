//! Request-local SQLite and pure sidebar projections. No Node result cache.
use super::*;
use thread_list::{trimmed, truthy};

pub(super) fn rows(db: &Connection, sql: &str, params: &[&str]) -> Result<Vec<Value>, ()> {
    let mut stmt = db.prepare(sql).map_err(|_| ())?;
    let names = stmt
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut cursor = stmt
        .query(rusqlite::params_from_iter(params))
        .map_err(|_| ())?;
    let mut rows = Vec::new();
    let mut bytes = 0usize;
    while let Some(row) = cursor.next().map_err(|_| ())? {
        let mut result = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            use rusqlite::types::ValueRef;
            let value = match row.get_ref(i).map_err(|_| ())? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) if n.unsigned_abs() <= 9_007_199_254_740_991 => json!(n),
                ValueRef::Real(n) if n.is_finite() => json!(n),
                ValueRef::Text(bytes) => json!(std::str::from_utf8(bytes).map_err(|_| ())?),
                _ => return Err(()),
            };
            result.insert(name.clone(), value);
        }
        let value = Value::Object(result);
        bytes = bytes
            .checked_add(serde_json::to_vec(&value).map_err(|_| ())?.len())
            .ok_or(())?;
        if bytes > RECORD_LIMIT as usize || rows.len() >= 100_000 {
            return Err(());
        }
        rows.push(value);
    }
    Ok(rows)
}
pub(super) fn subject(id: &Value, repo: &Value, project: &Value) -> Value {
    let workspace = repo.as_str().filter(|s| !s.is_empty()).map(|repo| {
        std::fs::canonicalize(repo)
            .unwrap_or_else(|_| thread_context::resolve(Path::new(repo)))
            .to_string_lossy()
            .into_owned()
    });
    json!({"kind":"conversation","id":id,"workspace":workspace,"projectId":trimmed(project)})
}
pub(super) fn key(subject: &Value) -> String {
    json!([subject["kind"], subject["workspace"], subject["id"]]).to_string()
}
fn inbox(db: &Connection, subject: &Value, pinned: bool) -> Result<(Value, Value), ()> {
    let key = format!("inbox:subject:{}", key(subject));
    let raw = match db.query_row("SELECT value FROM app_state WHERE key = ?", [key], |r| {
        r.get::<_, String>(0)
    }) {
        Ok(raw) => serde_json::from_str::<Value>(&raw).map_err(|_| ())?,
        Err(rusqlite::Error::QueryReturnedNoRows) => Value::Null,
        _ => return Err(()),
    };
    if !raw.is_null() && !raw.is_object() {
        return Err(());
    }
    let mut projection = json!({"inboxSubject":subject,"parentInboxSubject":null});
    for field in [
        "settledOverride",
        "settledAt",
        "unsettledAt",
        "pinOrderKey",
        "activeOrderKey",
        "autoSettleDisabledAt",
    ] {
        if !raw[field].is_null() && !raw[field].is_string() {
            return Err(());
        }
        projection[field] = raw[field].clone();
    }
    let pinned_at = raw.get("pinnedAt").cloned().unwrap_or(if pinned {
        json!("1970-01-01T00:00:00.000Z")
    } else {
        Value::Null
    });
    if !pinned_at.is_null() && !pinned_at.is_string() {
        return Err(());
    }
    projection["pinnedAt"] = pinned_at;
    let revision = raw
        .get("inboxRevision")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!(0));
    if revision
        .as_i64()
        .filter(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
        .is_none()
    {
        return Err(());
    }
    projection["inboxRevision"] = revision;
    projection["autoSettledReason"] = if raw["settledOverride"] == "settled"
        && truthy(&raw["autoSettledReason"])
        && truthy(&raw["autoSettledAt"])
        && raw["settledAt"] == raw["autoSettledAt"]
    {
        if !raw["autoSettledReason"].is_string() {
            return Err(());
        }
        raw["autoSettledReason"].clone()
    } else {
        Value::Null
    };
    let started = if raw["runStatus"] == "running" {
        raw.get("runStartedAt")
            .filter(|v| !v.is_null())
            .or_else(|| raw.get("runAt").filter(|v| !v.is_null()))
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    if !started.is_null() && !started.is_string() {
        return Err(());
    }
    Ok((projection, started))
}
fn linked(db: &Connection, thread: &Value) -> Result<Value, ()> {
    let id = thread["id"].as_str().ok_or(())?;
    let links = rows(db,"SELECT DISTINCT c.repository_id, c.pull_request_id, p.state, p.merged_at, p.head_ref_name, c.repository_name FROM conversation_pr_context c LEFT JOIN github_pull_requests p ON p.repository_id = c.repository_id AND p.pull_request_id = c.pull_request_id AND p.number = c.number WHERE c.thread_id = ?",&[id])?;
    if links.is_empty() && !truthy(&thread["repoBranch"]) {
        return Ok(Value::Null);
    }
    let mut pulls = HashMap::new();
    let mut branches = std::collections::HashSet::new();
    for link in links {
        let repository = link["repository_id"].as_i64().ok_or(())?;
        let pull = link["pull_request_id"].as_i64().ok_or(())?;
        if truthy(&link["head_ref_name"]) {
            branches.insert(format!(
                "{}:{}",
                link["repository_name"].as_str().ok_or(())?.to_lowercase(),
                link["head_ref_name"].as_str().ok_or(())?
            ));
        }
        pulls.insert((repository, pull), link);
    }
    if truthy(&thread["repoBranch"]) {
        let repository = match (
            thread["githubOwner"].as_str().filter(|s| !s.is_empty()),
            thread["githubRepo"].as_str().filter(|s| !s.is_empty()),
        ) {
            (Some(a), Some(b)) => format!("{a}/{b}").to_lowercase(),
            _ => thread["repoPath"].as_str().unwrap_or("").to_owned(),
        };
        branches.insert(format!(
            "{repository}:{}",
            thread["repoBranch"].as_str().ok_or(())?
        ));
    }
    let mut known = true;
    let (mut open, mut merged, mut closed) = (0, 0, 0);
    for link in pulls.values() {
        let state = link["state"].as_str().unwrap_or("").to_lowercase();
        let is_merged = truthy(&link["merged_at"]) || state == "merged";
        if !truthy(&link["merged_at"]) && !["open", "closed", "merged"].contains(&state.as_str()) {
            known = false;
        }
        if is_merged {
            merged += 1;
        } else if state == "open" {
            open += 1;
        } else if state == "closed" {
            closed += 1;
        }
    }
    let mut counts = json!({"total":pulls.len()});
    if known {
        counts["open"] = json!(open);
        counts["merged"] = json!(merged);
        counts["closed"] = json!(closed);
    }
    Ok(json!({"pullRequests":counts,"branches":branches.len()}))
}
pub(super) fn pieces(store: &ReadContext<'_>, threads: Vec<Value>) -> Result<Vec<Value>, ()> {
    let db = store.database()?;
    // TS constructs parked membership even for an empty selected page.
    let parked = thread_list_parked::context(store, db)?;
    let mut repos = HashMap::new();
    let mut pieces = Vec::new();
    for thread in threads {
        let subject = subject(&thread["id"], &thread["repoPath"], &thread["projectId"]);
        let (projection, started) = inbox(db, &subject, thread["pinned"] == true)?;
        let repo = thread["repoPath"].as_str().unwrap_or("");
        let git = repos
            .entry(repo.to_owned())
            .or_insert_with(|| thread_context::git_piece(repo));
        pieces.push(json!({"linkedWork":linked(db,&thread)?,"parked":parked.get(&key(&subject)).map(|entries|json!({"parkedWorkspaces":entries})).unwrap_or(json!({})),"git":git,"runStartedAt":if thread["status"]=="busy" {started} else {Value::Null},"thread":thread,"projection":projection}));
    }
    Ok(pieces)
}
