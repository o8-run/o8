//! Opt-in persisted reads for the native client. No upstream, migration or writer.
mod file_content;
mod directives;
mod repo_spec;
mod git_refs;
mod prompt_library;
mod prompt_writes;
mod diff_comments;
pub(crate) mod commit_notice;
mod session_rules;
mod session_rule_lease;
mod file_assets;
mod file_asset_viewer;
mod file_tree;
mod git_diff;
mod lane_diff;
mod git_diff_redaction;
pub use git_diff_redaction::ViewerRedaction;
mod chat;
mod thread_list;
mod thread_list_projection;
mod thread_list_parked;
mod chat_context;
mod mobile_history;
mod mobile_lane_events;
mod mobile_lane_overlays;
mod chat_context_json;
mod chat_list;
mod mobile_inbox;
mod review_workspace;
mod git_remote;
mod projects;
mod queue;
mod composer_queue_grant;
pub use composer_queue_grant::valid as composer_queue_grant_valid;
mod read_context;
mod repository;
mod settings_defaults;
mod settings_presentation;
mod settings_native;
mod settings_roster;
mod settings_providers;
mod settings;

mod thread_context;
mod thread_metadata;
mod thread_summary;

use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use read_context::ReadContext;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;

const RESPONSE_LIMIT: usize = 16 * 1024 * 1024; // native Client::read
const RECORD_LIMIT: u64 = 64 * 1024 * 1024;
type Params = HashMap<String, String>;
type ReadResult = Result<Value, ()>;

pub struct Store {
    directory: PathBuf,
    database: PathBuf,
    defaults_context: Option<Value>,
    redaction: Option<ViewerRedaction>,
}
impl Store {
    fn file(&self, path: &Path, limit: u64) -> Result<Vec<u8>, ()> {
        // A profile is a filesystem boundary, including symlinked history files.
        let path = path.canonicalize().map_err(|_| ())?;
        if !path.starts_with(&self.directory) {
            return Err(());
        }
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|_| ())?
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() as u64 > limit {
            return Err(());
        }
        Ok(bytes)
    }
    fn json(&self, path: &Path) -> ReadResult {
        serde_json::from_slice(&self.file(path, RECORD_LIMIT)?).map_err(|_| ())
    }
    fn token(&self) -> Result<String, ()> {
        let bytes = self.file(&self.directory.join("ws-token"), 4096)?;
        let token = String::from_utf8(bytes).map_err(|_| ())?.trim().to_owned();
        if token.is_empty() {
            return Err(());
        }
        Ok(token)
    }
    fn database(&self) -> Result<Connection, ()> {
        // Reopen per request: committed WAL changes and atomic replacements stay visible.
        // Never use immutable=1: it misses live WAL commits.
        let path = self.database.canonicalize().map_err(|_| ())?;
        if !path.starts_with(&self.directory) || !path.is_file() {
            return Err(());
        }
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| ())?;
        connection
            .busy_timeout(std::time::Duration::from_millis(500))
            .map_err(|_| ())?;
        Ok(connection)
    }
    fn history(&self, id: &str) -> ReadResult {
        let safe: String = id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.json(
            &self
                .directory
                .join("chat-history")
                .join(format!("{safe}.json")),
        )
    }
}

fn reply(status: StatusCode, body: Value) -> Response {
    let bytes = serde_json::to_vec(&body).unwrap_or_default();
    if bytes.len() > RESPONSE_LIMIT {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({"error":"History response exceeds 16 MiB"})),
        )
            .into_response();
    }
    (
        status,
        [
            ("content-type", "application/json"),
            ("cache-control", "no-store, max-age=0"),
        ],
        bytes,
    )
        .into_response()
}
fn unavailable() -> Response {
    reply(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({"error":"o8d persisted read unavailable; use the TypeScript server"}),
    )
}

/// Standalone HTTP has no Node resolver snapshot or admission backhaul.
fn standalone_ws_info(store: &ReadContext<'_>) -> Response {
    let port = store
        .file(&store.directory.join("ws-port"), 32)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|s| s.trim().parse::<u16>().ok());
    match (port, store.token()) {
        (Some(port), Ok(token)) if port > 0 => {
            reply(StatusCode::OK, json!({"wsPort":port,"wsToken":token}))
        }
        _ => unavailable(),
    }
}

fn value<'a>(params: &'a Params, key: &str) -> &'a str {
    params.get(key).map(String::as_str).unwrap_or("")
}

fn limit(params: &Params, default: usize, max: usize) -> usize {
    let raw = value(params, "limit").trim();
    // Match parseInt(..., 10), including its accepted numeric prefix.
    let sign = if raw.starts_with('-') { -1 } else { 1 };
    let digits: String = raw
        .trim_start_matches(['-', '+'])
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits
        .parse::<i64>()
        .ok()
        .map(|n| (n.saturating_mul(sign)).clamp(1, max as i64) as usize)
        .unwrap_or(default)
}

async fn handle(State(store): State<Arc<Store>>, request: Request<Body>) -> Response {
    let bearer = request
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("")
        .trim();
    if bearer.starts_with("o8ro_") {
        return reply(
            StatusCode::FORBIDDEN,
            json!({"error":"Read-only worker has no API capability."}),
        );
    }
    let Ok(token) = store.token() else {
        return unavailable();
    };
    if bearer.is_empty() || !bool::from(bearer.as_bytes().ct_eq(token.as_bytes())) {
        return reply(
            StatusCode::UNAUTHORIZED,
            json!({"error":"Unauthorized", "detail":"This endpoint is restricted to local o8 clients. Requests from other origins must present a valid bearer token."}),
        );
    }
    if request.method() != "GET" {
        return reply(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({"error":"Read-only endpoint"}),
        );
    }
    let path = request.uri().path().to_owned();
    let mut params = Params::new();
    for (key, value) in
        form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes()).into_owned()
    {
        // URLSearchParams.get uses the first occurrence, including for session keys.
        params.entry(key).or_insert(value);
    }
    let work = store.clone();
    match tokio::task::spawn_blocking(move || {
        let read = ReadContext::new(&work);
        // This listener is --experimental-http: it authenticates directly and
        // has no admission backhaul. The app/native dispatch always uses true.
        if path == "/api/orchestrator/composer-queue" { queue::read(&read, &params, false) }
        else if path == "/api/panel/ws-info" { standalone_ws_info(&read) }
        else if path == "/api/mobile/orchestrator/threads" { match chat::threads(&read,&params) { Ok(v)=>reply(StatusCode::OK,v), Err(())=>unavailable() } }
        else { dispatch(&read, &path, &params, "GET", &[]) }
    })
        .await
    {
        Ok(response) => response,
        Err(_) => unavailable(),
    }
}
fn dispatch(store: &ReadContext<'_>, path: &str, params: &Params, method: &str, body: &[u8]) -> Response {
    if diff_comments::matches(path, method) { return diff_comments::handle(store, params, method, body); }
    if path == "/api/orchestrator/session-rules" {
        if method == "GET" { return session_rules::read(store, params); }
        if matches!(method, "POST" | "DELETE") { return session_rules::write(store, params, method, body); }
    }
    if method != "GET" && prompt_writes::matches(path, method) {
        return prompt_writes::write(store, path, params, method, body);
    }
    if method != "GET" { return unavailable() }
    if projects::matches(path) {
        return projects::read(store, path, params);
    }
    match path {
        "/api/panel/file-content" | "/api/v2/files" => file_content::read(store, path, params),
        "/api/panel/files" => file_tree::read(store, params),
        "/api/repo-spec" => repo_spec::read(store, params),
        "/api/prompt-library" => prompt_library::read(store, params),
        "/api/cortex/directives" => directives::read(store, params),
        path if path.starts_with("/api/prompt-library/") => prompt_library::single(store, path),
        "/api/panel/file-io" | "/api/panel/file-asset" | "/api/panel/serve-image" | "/api/mobile/media" => file_assets::read(store, path, params),
        "/api/worktrees/diff" | "/api/worktrees/diff-summary" | "/api/panel/file-diff" => git_diff::read(store, path, params),
        "/api/panel/branches"
            if std::env::var("O8D_NATIVE_REPOSITORY_READS").as_deref() == Ok("1") || std::env::var("O8D_NATIVE_OWNED").as_deref() == Ok("1") =>
        {
            repository::read(path, params)
        }
        path if lane_diff::matches(path) => lane_diff::read(store, path, params),
        path if git_refs::is_commit(path) => git_refs::commit(store, path),
        "/api/runtime/inventory" => unavailable(),
        "/api/mobile/orchestrator/threads" => thread_list::read(store, params),
        "/api/mobile/history" => mobile_history::transcript(store, params),
        "/api/v2/chat-history" => chat_context::context(store, params),
        "/api/v2/chat-history/list" => chat_list::read(store, params),
        "/api/orchestrator/composer-queue" => queue::read(store, params, true),
        "/api/orchestrator/state" => {
            // Reconciliation and live runtime evidence still belong to TypeScript.
            // Never invent an empty fleet when persisted lanes require that authority.
            let result = (|| {
                let db = store.database()?;
                let lanes: i64 = db
                    .query_row("SELECT COUNT(*) FROM lanes", [], |r| r.get(0))
                    .map_err(|_| ())?;
                let mission = store.json(&store.directory.join("orchestrator-state.json"))?
                    ["mission"]
                    .clone();
                if lanes != 0 || !mission["packets"].as_array().is_some_and(Vec::is_empty) {
                    return Err(());
                }
                Ok(
                    json!({"mission":mission,"dag":{"currentWave":0,"totalWaves":0,"waves":[]},"agents":[]}),
                )
            })();
            match result {
                Ok(v) => reply(StatusCode::OK, v),
                Err(()) => unavailable(),
            }
        }
        "/api/panel/ws-info" => settings::ws_info(store),
        "/api/panel/operator-defaults" | "/api/runtime/provider-instances" | "/api/setup/config"
        | "/api/v2/keys" | "/api/runtime/capabilities" | "/api/runtime/service-tiers"
            => settings_defaults::read(store, path, params),
        "/api/setup/identity" => settings::identity(store),

        _ => reply(StatusCode::NOT_FOUND, json!({"error":"Not found"})),
    }
}

/// Shared inventory for native admission, embedded once from the route table.
pub fn native_route(path: &str, method: &str) -> Option<&'static Value> {
    static ROUTES: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
    ROUTES
        .get_or_init(|| {
            serde_json::from_str(include_str!("../../native-routes.json"))
                .expect("valid native route table")
        })
        .iter()
        .find(|route| {
            route["path"].as_str().is_some_and(|pattern| {
                let expected = pattern.split('/').collect::<Vec<_>>();
                let actual = path.split('/').collect::<Vec<_>>();
                expected.len() == actual.len()
                    && expected.iter().zip(actual).all(|(e, a)| {
                        if e.starts_with('[') && e.ends_with(']') {
                            !a.is_empty()
                        } else {
                            *e == a
                        }
                    })
            }) && route["methods"]
                .as_array()
                .is_some_and(|methods| methods.iter().any(|entry| entry == method))
        })
}

/// Compatibility wrapper for saved-session dispatch.
pub fn is_session_read(path: &str) -> bool {
    native_route(path, "GET").is_some()
}

/// Called only after the app transport's per-request TypeScript auth admission.
pub fn session_read(directory: PathBuf, database: PathBuf, path: &str, query: &str, defaults_context: Option<Value>) -> Response {
    native_request(directory, database, path, query, "GET", &[], defaults_context)
}

pub fn native_body_too_large() -> Response {
    reply(StatusCode::PAYLOAD_TOO_LARGE, json!({"error":"Request exceeds 16 MiB"}))
}

pub fn native_request(directory: PathBuf, database: PathBuf, path: &str, query: &str, method: &str, body: &[u8], defaults_context: Option<Value>) -> Response {
    native_request_viewer(directory, database, path, query, method, body, defaults_context, None)
}

pub fn native_request_viewer(directory: PathBuf, database: PathBuf, path: &str, query: &str, method: &str, body: &[u8], defaults_context: Option<Value>, redaction: Option<ViewerRedaction>) -> Response {
    if body.len() > 16 * 1024 * 1024 { return native_body_too_large() }
    let store = Store {
        directory,
        database,
        defaults_context,
        redaction,
    };
    let store = ReadContext::new(&store);
    let mut params = Params::new();
    for (key, value) in form_urlencoded::parse(query.as_bytes()).into_owned() {
        params.entry(key).or_insert(value);
    }
    if native_route(path, method).is_none() {
        return unavailable();
    }
    if diff_comments::matches(path, method) { return dispatch(&store,path,&params,method,body); }
    if path == "/api/mobile/inbox" { return mobile_inbox::read(&store); }
    if path == "/api/review/workspace" { return review_workspace::read(&store); }
    // A missing JSON file can still be a network thread. Its agent-bus
    // projection and projection health remain owned by TypeScript.
    let id = match path {
        "/api/mobile/history" => value(&params, "sessionKey")
            .trim()
            .strip_prefix("llm-chat:")
            .unwrap_or(""),
        "/api/v2/chat-history" => value(&params, "tabId"),
        "/api/orchestrator/composer-queue" => value(&params, "threadId"),
        _ => "",
    };
    if store.database().ok().is_some_and(|db| {
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM bot_network_threads WHERE thread_id = ?)",
            [id], |r| r.get::<_, bool>(0),
        ).unwrap_or(false)
    }) {
        return unavailable();
    }
    dispatch(&store, path, &params, method, body)
}

pub async fn run(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let option = |name| {
        arguments
            .windows(2)
            .find(|pair| pair[0] == name)
            .map(|pair| pair[1].clone())
    };
    let address: SocketAddr = option("--listen").ok_or("listener required")?.parse()?;
    if !address.ip().is_loopback() {
        return Err("loopback listener required".into());
    }
    let directory =
        PathBuf::from(option("--data-dir").ok_or("explicit profile directory required")?)
            .canonicalize()?;
    let database = directory.join("cortex-ide.db");
    let store = Store {
        directory,
        database,
        defaults_context: None,
        redaction: None,
    };
    store.token().map_err(|_| "existing credential required")?;
    let listener = TcpListener::bind(address).await?;
    println!(
        "{}",
        json!({"listening":listener.local_addr()?.to_string()})
    );
    let router = Router::new()
        .fallback(any(handle))
        .with_state(Arc::new(store));
    let parent_stdin = arguments
        .iter()
        .any(|argument| argument == "--exit-on-stdin-eof");
    let parent_exit = if parent_stdin {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        // A detached OS reader does not keep Tokio's blocking pool alive when
        // Ctrl-C wins while the owning parent's stdin pipe is still open.
        std::thread::spawn(move || {
            let mut input = std::io::stdin();
            let mut byte = [0];
            while matches!(input.read(&mut byte), Ok(count) if count != 0) {}
            let _ = sender.send(());
        });
        Some(receiver)
    } else {
        None
    };
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            if let Some(parent_exit) = parent_exit {
                tokio::select! {
                    _ = parent_exit => {},
                    _ = tokio::signal::ctrl_c() => {},
                }
                repository::shutdown();
            } else {
                let _ = tokio::signal::ctrl_c().await;
            }
        })
        .await?;
    Ok(())
}
