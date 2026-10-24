//! Opt-in persisted reads, with orchestration requests forwarded to their TS owner.
mod chat;
mod queue;

use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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
    owner: Option<SocketAddr>,
    client: reqwest::Client,
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
    let path = request.uri().path().to_owned();
    let method = request.method().as_str();
    let native_read = matches!(
        path.as_str(),
        "/api/mobile/orchestrator/threads"
            | "/api/mobile/history"
            | "/api/v2/chat-history"
            | "/api/orchestrator/state"
            | "/api/runtime/inventory"
            | "/api/orchestrator/composer-queue"
            | "/api/panel/ws-info"
            | "/api/orchestrator/review-state"
            | "/api/worktrees/diff"
    ) || (path.starts_with("/api/lanes/")
        && path.ends_with("/diff")
        && path.split('/').count() == 5);
    let native_write = (path == "/api/orchestrator/composer-queue"
        && matches!(method, "POST" | "PATCH" | "DELETE"))
        || (path == "/api/orchestrator/review" && method == "POST");
    if method != "GET" && !(store.owner.is_some() && native_write) {
        return reply(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({"error":"Read-only endpoint"}),
        );
    }
    if !native_read && !native_write {
        return reply(StatusCode::NOT_FOUND, json!({"error":"Not found"}));
    }
    let mut params = Params::new();
    for (key, value) in
        form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes()).into_owned()
    {
        // URLSearchParams.get uses the first occurrence, including for session keys.
        params.entry(key).or_insert(value);
    }
    let work = store.clone();
    // Reconciliation and live capability checks always run in their owner. A
    // saved-history projection may additionally request its lane/runtime overlay.
    if store.owner.is_some()
        && (native_write
            || matches!(
                path.as_str(),
                "/api/orchestrator/state"
                    | "/api/runtime/inventory"
                    | "/api/panel/ws-info"
                    | "/api/orchestrator/composer-queue"
                    | "/api/orchestrator/review-state"
                    | "/api/worktrees/diff"
            )
            || path.starts_with("/api/lanes/"))
    {
        return forward(&store, request).await;
    }
    let response = match tokio::task::spawn_blocking(move || dispatch(&work, &path, &params)).await
    {
        Ok(response) => response,
        Err(_) => unavailable(),
    };
    if response.status() == StatusCode::SERVICE_UNAVAILABLE && store.owner.is_some() {
        return forward(&store, request).await;
    }
    response
}

async fn forward(store: &Store, request: Request<Body>) -> Response {
    // A saved read can need a TS lane overlay, but a parsing failure must not
    // bypass the persisted reader's profile and 64 MiB input boundary.
    let mut params = Params::new();
    for (key, value) in
        form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes()).into_owned()
    {
        params.entry(key).or_insert(value);
    }
    let saved_id = match request.uri().path() {
        "/api/mobile/history" => value(&params, "sessionKey")
            .trim()
            .strip_prefix("llm-chat:"),
        "/api/v2/chat-history" => Some(value(&params, "tabId")),
        _ => None,
    };
    if saved_id.is_some_and(|id| store.history(id).is_err()) {
        return unavailable();
    }
    // Refuse cross-profile persisted roots before delegating to the writer.
    for name in ["cortex-ide.db", "orchestrator-state.json", "chat-history"] {
        let path = store.directory.join(name);
        if std::fs::symlink_metadata(&path).is_ok()
            && !path
                .canonicalize()
                .is_ok_and(|p| p.starts_with(&store.directory))
        {
            return unavailable();
        }
    }
    if let Ok(entries) = std::fs::read_dir(store.directory.join("chat-history")) {
        for entry in entries {
            let Ok(entry) = entry else {
                return unavailable();
            };
            if entry.file_type().is_ok_and(|kind| kind.is_symlink())
                && !entry
                    .path()
                    .canonicalize()
                    .is_ok_and(|p| p.starts_with(&store.directory))
            {
                return unavailable();
            }
        }
    }
    let Some(owner) = store.owner else {
        return unavailable();
    };
    let url = format!("http://{owner}{}", request.uri());
    let (parts, body) = request.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, RESPONSE_LIMIT).await else {
        return reply(
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({"error":"Request exceeds 16 MiB"}),
        );
    };
    let mut upstream = store.client.request(parts.method, url).header(
        "x-o8d-profile",
        format!(
            "{:x}",
            Sha256::digest(store.directory.to_string_lossy().as_bytes())
        ),
    );
    // Do not propagate client-supplied peer/profile/principal headers.
    for name in ["authorization", "content-type"] {
        if let Some(value) = parts.headers.get(name) {
            upstream = upstream.header(name, value);
        }
    }
    let Ok(mut response) = upstream.body(bytes).send().await else {
        return unavailable();
    };
    let status = response.status();
    let headers = response.headers().clone();
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= RESPONSE_LIMIT => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(Some(_)) => {
                return reply(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    json!({"error":"Response exceeds 16 MiB"}),
                )
            }
            Ok(None) => break,
            Err(_) => return unavailable(),
        }
    }
    let mut result = Response::new(Body::from(bytes));
    *result.status_mut() = status;
    for name in ["content-type", "cache-control"] {
        if let Some(value) = headers.get(name) {
            result.headers_mut().insert(name, value.clone());
        }
    }
    result
}
fn dispatch(store: &Store, path: &str, params: &Params) -> Response {
    match path {
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
    let owner = option("--owner-upstream")
        .map(|value| value.parse::<SocketAddr>())
        .transpose()?;
    if owner.is_some_and(|address| !address.ip().is_loopback() || address.port() == 0) {
        return Err("numeric loopback owner required".into());
    }
    let store = Store {
        directory,
        database,
        owner,
        client: reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(1))
            .timeout(std::time::Duration::from_secs(15))
            .build()?,
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
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
