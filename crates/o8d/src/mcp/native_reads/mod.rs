//! Passive readers: no migrations, DDL, token creation, or reconciliation writes.
use axum::http::HeaderMap;
use chrono::{DateTime, SecondsFormat, Utc};
use reqwest::Url;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, sync::Mutex, time::Duration};

mod leases;
mod mission;
mod process_identity;
mod publisher;
use publisher::{Bindings, PendingPublisher};
mod registries;
mod spec;
mod tasks;
type ReadResult<T> = Result<T, ()>;

pub struct NativeReads {
    directory: PathBuf,
    database: PathBuf,
    connection: Mutex<Option<Connection>>,
    file_identity: Mutex<Option<std::fs::Metadata>>,
    publisher: Mutex<Bindings>,
}
impl NativeReads {
    pub fn new(directory: PathBuf, database: Option<PathBuf>) -> Self {
        let database = database.unwrap_or_else(|| directory.join("cortex-ide.db"));
        Self {
            directory,
            database,
            connection: Mutex::new(None),
            file_identity: Mutex::new(None),
            publisher: Mutex::new(Bindings::default()),
        }
    }
    pub fn read(
        &self,
        upstream: &Url,
        headers: &HeaderMap,
        messages: &[Value],
    ) -> Result<Vec<Value>, Option<PendingPublisher>> {
        let mut pending = None;
        self.read_checked(upstream, headers, messages, &mut pending)
            .map_err(|_| pending)
    }
    fn read_checked(
        &self,
        upstream: &Url,
        headers: &HeaderMap,
        messages: &[Value],
        pending: &mut Option<PendingPublisher>,
    ) -> ReadResult<Vec<Value>> {
        let mut guard = self.connection.lock().map_err(|_| ())?;
        let current_metadata = fs::metadata(&self.database).map_err(|_| ())?;
        let mut previous_metadata = self.file_identity.lock().map_err(|_| ())?;
        #[cfg(unix)]
        if previous_metadata.as_ref().is_some_and(|previous| {
            use std::os::unix::fs::MetadataExt;
            previous.dev() != current_metadata.dev() || previous.ino() != current_metadata.ino()
        }) {
            *guard = None;
        }
        *previous_metadata = Some(current_metadata);
        if guard.is_none() {
            // READ_ONLY deliberately excludes CREATE, READ_WRITE and immutable.
            // Normal SQLite WAL locking sees committed app writes on each read.
            let connection = Connection::open_with_flags(
                &self.database,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|_| ())?;
            connection
                .busy_timeout(Duration::from_millis(20))
                .map_err(|_| ())?;
            *guard = Some(connection);
        }
        let connection = guard.as_mut().ok_or(())?;
        let tx = connection.transaction().map_err(|_| ())?;
        let policy = state(&tx, "o8d/mcp/v1/policy")?;
        if policy["schema"] != "o8/mcp/native-policy/v1"
            || policy["enabled"] != true
            || policy["base"]
                .as_str()
                .map(|base| base.trim_end_matches('/'))
                != Some(upstream.as_str().trim_end_matches('/'))
        {
            return Err(());
        }
        let pid = policy["pid"].as_u64().ok_or(())?;
        let identity = process_identity::observe(pid, &policy["identity"])?;
        let bearer = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .ok_or(())?;
        if bearer.starts_with("o8ro_") || bearer.starts_with("o8p_") {
            return Err(());
        }
        let expected = fs::read_to_string(self.directory.join("ws-token")).map_err(|_| ())?;
        // Compare digests in constant time; also bind to the publisher's token.
        let digest = Sha256::digest(bearer.as_bytes());
        let current = Sha256::digest(expected.trim().as_bytes());
        let difference = digest
            .iter()
            .zip(current.iter())
            .fold(0u8, |d, (a, b)| d | (a ^ b));
        if difference != 0 || format!("{digest:x}") != policy["tokenHash"].as_str().ok_or(())? {
            return Err(());
        }
        match fs::read_to_string(self.directory.join("broadcast-spectator-tokens")) {
            Ok(hashes)
                if hashes
                    .lines()
                    .any(|hash| hash.trim() == format!("{digest:x}")) =>
            {
                return Err(())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(()),
        }
        let generation = string(&policy, "generation")?;
        if let Err(witness) = self
            .publisher
            .lock()
            .map_err(|_| ())?
            .check(PendingPublisher {
                generation: generation.to_owned(),
                identity: identity.clone(),
            })
        {
            *pending = witness;
            return Err(());
        }
        let names = policy["names"].as_array().ok_or(())?;
        let requested = match headers.get("x-o8-mcp-profile") {
            Some(value) => value.to_str().map_err(|_| ())?,
            None => "",
        };
        let profile = policy["profile"].as_str().ok_or(())?;
        let mut results = Vec::new();
        for message in messages {
            if message["method"] != "tools/call" {
                return Err(());
            }
            if message["id"].is_null() {
                continue;
            }
            let name = message["params"]["name"].as_str().ok_or(())?;
            let result = if !names.iter().any(|v| v == name) || !matches!(requested, "" | "full") {
                json!({"isError":true,"content":[{"type":"text","text":format!("Tool unavailable in operator MCP profile {profile}: {name}")}]})
            } else {
                let args = message["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or(json!({}));
                if !args.is_object() || args.to_string().contains('~') {
                    return Err(());
                }
                let data = match name {
                    "o8_status" => self.status(&tx, upstream, &policy, &args)?,
                    "o8_list_repos" => registries::repos(self, &tx, &policy)?,
                    "o8_list_projects" => {
                        super::projections::projects(registries::projects(self, &tx)?)
                    }
                    "o8_task_list" => tasks::read(self, &tx, &args)?,
                    "get_mission_status" => mission::read(self, &tx, &args)?,
                    "o8_lease_list" => leases::read(&tx)?,
                    "o8_lease_status" => leases::status(&tx, &args)?,
                    "o8_spec_read" => spec::read(&args)?,
                    _ => return Err(()),
                };
                json!({"isError":data.get("error").is_some(),"content":[{"type":"text","text":data.to_string()}]})
            };
            results.push(json!({"jsonrpc":"2.0","id":message["id"],"result":result}));
        }
        // Dropping a deferred read transaction rolls it back without writing.
        Ok(results)
    }
    pub fn verify_generation(&self, pending: PendingPublisher) -> ReadResult<()> {
        self.publisher.lock().map_err(|_| ())?.verify(pending)
    }
    fn json(&self, filename: &str) -> ReadResult<Value> {
        serde_json::from_slice(&fs::read(self.directory.join(filename)).map_err(|_| ())?)
            .map_err(|_| ())
    }
    fn status(
        &self,
        db: &Connection,
        upstream: &Url,
        policy: &Value,
        args: &Value,
    ) -> ReadResult<Value> {
        if args.get("fresh").is_some_and(|v| v != false) {
            return Err(());
        }
        let session = args
            .get("sessionKey")
            .filter(|v| !v.is_null())
            .map(|v| v.as_str().ok_or(()))
            .transpose()?
            .unwrap_or("");
        let base = upstream.as_str().trim_end_matches('/');
        let source = state(db, &format!("o8d/mcp/v1/status/{}", json!([base, session])))?;
        if source["generation"] != policy["generation"] {
            return Err(());
        }
        let snapshot = &source["snapshot"];
        if !snapshot["data"].is_object()
            || !snapshot["runtimeConnections"].is_object()
            || !snapshot["data"]["agents"].is_array()
            || !snapshot["data"]["recentActivity"].is_array()
            || !snapshot["data"]["approvals"].is_object()
            || !snapshot["data"]["spendCapHits"].is_array()
            || !snapshot["data"]["approvals"]["items"].is_array()
            || snapshot["data"]["approvals"]["count"].as_u64().is_none()
            || !matches!(
                snapshot["runtimeConnections"]["status"].as_str(),
                Some("available" | "unavailable")
            )
            || !snapshot["runtimeConnections"]["runtimes"].is_array()
        {
            return Err(());
        }
        let captured = snapshot["capturedAt"].as_i64().ok_or(())?;
        let age = Utc::now().timestamp_millis() - captured;
        // At five seconds TS must schedule a refresh. Let the original handler
        // own that work; never renew age or serve an unrefreshed stale snapshot.
        if !(0..5_000).contains(&age) {
            return Err(());
        }
        Ok(super::projections::status(
            snapshot["data"].clone(),
            snapshot["runtimeConnections"].clone(),
            json!({"capturedAt":iso(captured)?,"ageMs":age,"refreshAfterMs":5000,"maxAgeMs":15000}),
            args,
        ))
    }
}
fn state(db: &Connection, key: &str) -> ReadResult<Value> {
    let raw: String = db
        .prepare_cached("SELECT value FROM app_state WHERE key = ?")
        .map_err(|_| ())?
        .query_row([key], |row| row.get(0))
        .map_err(|_| ())?;
    serde_json::from_str(&raw).map_err(|_| ())
}
fn rows(db: &Connection, sql: &str) -> ReadResult<Vec<Value>> {
    let mut stmt = db.prepare_cached(sql).map_err(|_| ())?;
    let columns = stmt
        .column_names()
        .iter()
        .map(|name| name.to_string())
        .collect::<Vec<_>>();
    let values = stmt
        .query_map([], |row| {
            let mut out = serde_json::Map::new();
            for (index, name) in columns.iter().enumerate() {
                use rusqlite::types::ValueRef;
                let value = match row.get_ref(index)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(n) => json!(n),
                    ValueRef::Text(s) => {
                        json!(std::str::from_utf8(s).map_err(|_| rusqlite::Error::InvalidQuery)?)
                    }
                    ValueRef::Blob(_) => return Err(rusqlite::Error::InvalidQuery),
                };
                out.insert(name.clone(), value);
            }
            Ok(Value::Object(out))
        })
        .map_err(|_| ())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ())?;
    Ok(values)
}
fn array(value: &Value) -> ReadResult<&Vec<Value>> {
    value.as_array().ok_or(())
}
fn string<'a>(value: &'a Value, key: &str) -> ReadResult<&'a str> {
    value[key].as_str().ok_or(())
}
fn iso(ms: i64) -> ReadResult<String> {
    Ok(DateTime::<Utc>::from_timestamp_millis(ms)
        .ok_or(())?
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}
fn lanes(db: &Connection) -> ReadResult<Vec<Value>> {
    rows(db, "SELECT id, project_id AS projectId, label, repo_path AS repoPath, worktree_path AS worktreePath, branch, base_branch AS baseBranch, runtime, model, session_key AS sessionKey, packet_id AS packetId, status, outcome, last_heartbeat_at AS lastHeartbeatAt, created_at AS createdAt, updated_at AS updatedAt, last_event_at AS lastEventAt, last_event_label AS lastEventLabel FROM lanes ORDER BY created_at ASC")
}
