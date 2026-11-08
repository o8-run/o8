//! Opt-in persisted reads for the native client. No upstream, migration or writer.
mod chat;
mod queue;
mod read_context;
mod repository;
mod thread_context;
mod thread_summary;

use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use read_context::ReadContext;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
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
fn problem(message: &str) -> Response {
    reply(StatusCode::BAD_REQUEST, json!({"error":message}))
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
    match tokio::task::spawn_blocking(move || dispatch(&ReadContext::new(&work), &path, &params))
        .await
    {
        Ok(response) => response,
        Err(_) => unavailable(),
    }
}
fn dispatch(store: &ReadContext<'_>, path: &str, params: &Params) -> Response {
    match path {
        "/api/panel/branches"
            if std::env::var("O8D_NATIVE_REPOSITORY_READS").as_deref() == Ok("1") =>
        {
            repository::read(path, params)
        }
        "/api/runtime/inventory" => unavailable(),
        "/api/mobile/orchestrator/threads" => match chat::threads(store, params) {
            Ok(v) => reply(StatusCode::OK, v),
            Err(_) => unavailable(),
        },
        "/api/mobile/history" => chat::transcript(store, params),
        "/api/v2/chat-history" => chat::context(store, params),
        "/api/orchestrator/composer-queue" => queue::read(store, params),
        "/api/orchestrator/state" => {
            // Reconciliation and live runtime evidence still belong to TypeScript.
            // Never invent an empty fleet when persisted lanes require that authority.
            let result = (|| {
                let db = store.database()?;
                let lanes: i64 = db
                    .query_row("SELECT COUNT(*) FROM lanes", [], |r| r.get(0))
                    .map_err(|_| ())?;
                let mission =
                    store.json(&store.directory.join("orchestrator-state.json"))?["mission"]
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
        "/api/panel/ws-info" => {
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
        _ => reply(StatusCode::NOT_FOUND, json!({"error":"Not found"})),
    }
}

/// Shared inventory for native admission; non-GET dispatch remains with TS.
pub fn is_session_read(path: &str) -> bool {
    matches!(
        path,
        "/api/mobile/orchestrator/threads"
            | "/api/mobile/history"
            | "/api/v2/chat-history"
            | "/api/orchestrator/composer-queue"
    )
}

/// Called only after the app transport's per-request TypeScript auth admission.
pub fn session_read(directory: PathBuf, database: PathBuf, path: &str, query: &str) -> Response {
    let store = Store {
        directory,
        database,
    };
    let store = ReadContext::new(&store);
    let mut params = Params::new();
    for (key, value) in form_urlencoded::parse(query.as_bytes()).into_owned() {
        params.entry(key).or_insert(value);
    }
    if !is_session_read(path) {
        return unavailable();
    }
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
            "SELECT EXISTS(SELECT 1 FROM bot_network_threads WHERE ? = '/api/mobile/orchestrator/threads' OR thread_id = ?)",
            [path, id], |r| r.get::<_, bool>(0),
        ).unwrap_or(false)
    }) {
        return unavailable();
    }
    dispatch(&store, path, &params)
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
