//! Saved reads: native prompt operator gate; other reads retain TS admission.
use crate::http;
use axum::{body::to_bytes, http::StatusCode};
use std::{path::PathBuf, sync::OnceLock, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

pub(super) fn enabled() -> bool {
    std::env::var("O8D_NATIVE_SESSION_READS").as_deref() == Ok("1")
}

/// One pooled client for the private admission backhaul. A client built per
/// read opened a new loopback connection each time, about 2 ms per read.
/// Each request still carries the bridge key and is admitted on its own.
fn admission_client() -> Result<&'static reqwest::Client, ()> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        // Node's default keep-alive timeout is 5 s; drop idle sockets before
        // the backend does, so a reused socket is never one it is closing.
        .pool_idle_timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| ())?;
    Ok(CLIENT.get_or_init(|| client))
}

pub(super) enum Outcome {
    Proxy,
    // Admission succeeded, but Rust deferred after the bounded body was read.
    // Replay it once through the original TS handler instead of losing bytes.
    Replay(Vec<u8>),
    Served,
}

const BODY_LIMIT: usize = 16 * 1024 * 1024;

/// Keep unsupported framing on the original streaming path without consuming it.
pub(super) async fn serve(
    socket: &mut TcpStream,
    header: &str,
    upstream: Option<&str>,
    key: &str,
    startup_port_info: Option<&serde_json::Value>,
    count: &super::request_counts::Count,
    global: &super::native_global::NativeGlobal,
    selection: &super::Selection,
) -> Result<Outcome, ()> {
    if !enabled() && std::env::var("O8D_NATIVE_OWNED").as_deref() != Ok("1") {
        return Ok(Outcome::Proxy);
    }
    let mut line = header.lines().next().ok_or(())?.split_whitespace();
    let method = line.next().ok_or(())?;
    let target = line.next().ok_or(())?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let Some(route) = http::native_route(path, method) else { return Ok(Outcome::Proxy); };
    if !enabled() && !(route["owned"] == true && std::env::var("O8D_NATIVE_OWNED").as_deref() == Ok("1")) { return Ok(Outcome::Proxy); }
    let viewer = route["redaction"] == "viewer";
    let composer_queue = route["admission"] == "composer-queue";
    let thread_list = route["composition"] == "mobile-threads/1";
    let body_grant = viewer || composer_queue || thread_list;
    let mut length = None;
    for (name, value) in header
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
    {
        // Chunked/expect/ambiguous framing stays with the TS streaming parser.
        if name.eq_ignore_ascii_case("transfer-encoding") || name.eq_ignore_ascii_case("expect") {
            return Ok(Outcome::Proxy);
        }
        if name.eq_ignore_ascii_case("content-length") {
            let value = value.trim();
            if length.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Ok(Outcome::Proxy);
            }
            let Ok(value) = value.parse::<usize>() else {
                return Ok(Outcome::Proxy);
            };
            length = Some(value);
        }
    }
    let length = length.unwrap_or(0);
    if method == "GET" && length != 0 {
        return Ok(Outcome::Proxy);
    }
    let diff_comment = super::diff_comment_auth::matches(path, method);
    let mut native_diff_comment = false;
    if diff_comment {
        // Classic mode retains its original Node owner. Product requests can
        // use only the route-scoped gate or this request's Node admission.
        if std::env::var("O8_API_FRONT_DOOR").as_deref() != Ok("1") { return Ok(Outcome::Proxy); }
        match super::diff_comment_auth::check(header, socket.local_addr().map_err(|_|())?.port()) {
            super::diff_comment_auth::Gate::Allow => native_diff_comment = true,
            super::diff_comment_auth::Gate::Reply(response) => return write_response(socket,response,count).await,
            super::diff_comment_auth::Gate::Proxy => (),
        }
    }
    let native_operator = std::env::var("O8_API_FRONT_DOOR").as_deref() == Ok("1")
        && std::env::var("O8D_NATIVE_OWNED").as_deref() == Ok("1")
        && super::prompt_operator::eligible(socket, header, path);
    // This read's non-operator principals retain the original Node handler,
    // including its packet-to-thread check. Never accept an operator-read
    // marker from the Node defaults snapshot or from a request header.
    if path == "/api/orchestrator/session-rules" && method == "GET" && !native_operator {
        return Ok(Outcome::Proxy);
    }
    let (mut defaults_context, redaction) = if native_operator || native_diff_comment {
        let context = if native_diff_comment {
            Some(serde_json::json!({"diffCommentAuthority":true}))
        } else if method != "GET" {
            Some(serde_json::json!({"promptWriteAuthority":true}))
        } else if path == "/api/orchestrator/session-rules" {
            Some(serde_json::json!({"sessionRuleReadAuthority":true}))
        } else {
            None
        };
        (context, None)
    } else {
    let Some(upstream) = upstream else { return Ok(Outcome::Proxy); };
    // Admit the original path/method/headers through production middleware and
    // the queue's in-handler gate. Never cache principal or credential decisions.
    let mut request = admission_client()?.request(
        method.parse().map_err(|_| ())?,
        format!("http://{upstream}{target}"),
    );
    for (name, value) in header
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
    {
        let lower = name.to_ascii_lowercase();
        if lower.starts_with("x-o8d-")
            || [
                "connection",
                "content-length",
                "transfer-encoding",
                "upgrade",
                "expect",
            ]
            .contains(&lower.as_str())
        {
            continue;
        }
        request = request.header(name, value.trim());
    }
    if viewer { request = request.header("x-o8d-redaction", "viewer/1"); }
    if composer_queue { request = request.header("x-o8d-composer-queue", "capabilities/1"); }
    let Ok(mut admission) = request
        .header("x-o8d-bridge", key)
        .header("x-o8d-peer", "unverified-proxy")
        .header("x-o8d-session-read", "authorize")
        .send()
        .await
    else {
        // A pooled socket the backend closed as this request went out fails
        // the send. The original handler still owns the request, as it does
        // for any admission that does not return the expected grant status.
        return Ok(Outcome::Proxy);
    };
    if admission.status() != if body_grant { StatusCode::OK } else { StatusCode::NO_CONTENT } {
        // Let the original handler return its exact auth/error response. An
        // unavailable gate never grants native access.
        return Ok(Outcome::Proxy);
    }
    // Only the authenticated private admission response provides this context.
    // It contains paths and booleans, never provider key values.
    let mut redaction = None;
    let defaults_context = if body_grant {
        let mut bytes = Vec::new();
        loop {
            match admission.chunk().await {
                Ok(Some(chunk)) if bytes.len() + chunk.len() <= 1024 * 1024 => bytes.extend_from_slice(&chunk),
                Ok(None) => break,
                _ => return Ok(Outcome::Proxy),
            }
        }
        let Ok(grant) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return Ok(Outcome::Proxy); };
        if grant["version"].as_u64() != Some(1) || !grant["defaultsContext"].is_object() { return Ok(Outcome::Proxy); }
        if viewer {
            let Some(policy) = http::ViewerRedaction::from_grant(&grant["redaction"]) else { return Ok(Outcome::Proxy); };
            redaction = Some(policy);
        }
        if composer_queue && !http::composer_queue_grant_valid(&grant["defaultsContext"]["composerQueue"]) { return Ok(Outcome::Proxy); }
        Some(grant["defaultsContext"].clone())
    } else {
        admission.headers().get("x-o8d-defaults-context")
            .and_then(|v| v.to_str().ok()).filter(|raw| raw.len() <= 4096)
            .and_then(|raw| {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD.decode(raw).ok()?;
                serde_json::from_slice(&bytes).ok()
            })
    };
        (defaults_context, redaction)
    };
    if let Some(snapshot) = startup_port_info.filter(|_| matches!(path, "/api/panel/ws-info" | "/api/setup/identity")) {
        let context = defaults_context.get_or_insert_with(|| serde_json::json!({}));
        let Some(context) = context.as_object_mut() else { return Ok(Outcome::Proxy); };
        context.insert("nativeStartupPortInfo".into(), snapshot.clone());
    }
    // Only after admission consume bytes. A refusal never gets native access.
    socket
        .read_exact(&mut vec![0; header.len()])
        .await
        .map_err(|_| ())?;
    if length > BODY_LIMIT {
        return write_response(socket, http::native_body_too_large(), count).await;
    }
    let mut body = vec![0; length];
    tokio::time::timeout(Duration::from_secs(10), socket.read_exact(&mut body))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    let directory = PathBuf::from(std::env::var("O8D_SESSION_DATA_DIR").map_err(|_| ())?)
        .canonicalize()
        .map_err(|_| ())?;
    let database = std::env::var_os("O8D_SESSION_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| directory.join("cortex-ide.db"));
    let path = path.to_owned();
    let query = query.to_owned();
    let method = method.to_owned();
    let replay = body.clone();
    let mut response = tokio::task::spawn_blocking(move || {
        http::native_request_viewer(directory, database, &path, &query, &method, &body, defaults_context, redaction)
    })
    .await
    .map_err(|_| ())?;

    if let Some(notice) = response.extensions_mut().remove::<http::commit_notice::CommitNotice>() {
        // COMMIT is terminal even when delivery fails. Never replay a receipt.
        global.committed(notice.0, selection, header).await;
    }
    // Unsupported inputs and runtime-owned cases replay through the original
    // handler. Dynamic capabilities are trusted only from this request's grant.
    if response.status() == StatusCode::SERVICE_UNAVAILABLE {
        return Ok(Outcome::Replay(replay));
    }
    let response = if path_for_completion(target) && response.headers().contains_key("x-o8d-directives-timing") {
        // After a receipt may have committed, never replay and double-record it.
        // A backhaul transport failure ends this request; retries are fresh GETs.
        let Some(upstream) = upstream else { return Ok(Outcome::Replay(replay)); };
        complete_directives(target, header, upstream, key, response).await?
    } else { response };
    let response = if thread_list && response.headers().contains_key("x-o8d-thread-pieces") {
        let Some(upstream) = upstream else { return Ok(Outcome::Replay(replay)); };
        match compose_threads(target, header, upstream, key, response).await {
            Ok(response) => response,
            Err(()) => return Ok(Outcome::Replay(replay)),
        }
    } else {
        response
    };
    write_response(socket, response, count).await
}

fn path_for_completion(target: &str) -> bool {
    target.split('?').next() == Some("/api/cortex/directives")
}
async fn complete_directives(
    target: &str,
    header: &str,
    upstream: &str,
    key: &str,
    response: axum::response::Response,
) -> Result<axum::response::Response, ()> {
    let duration: f64 = response
        .headers()
        .get("x-o8d-directives-timing")
        .ok_or(())?
        .to_str()
        .map_err(|_| ())?
        .parse()
        .map_err(|_| ())?;
    let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .map_err(|_| ())?;
    let body: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
    let payload =
        serde_json::to_vec(&serde_json::json!({"version":1,"durationMs":duration,"body":body}))
            .map_err(|_| ())?;
    if payload.len() > 8 * 1024 * 1024 {
        return Err(());
    }
    let mut request = admission_client()?.post(format!("http://{upstream}{target}"));
    for (name, value) in header.lines().skip(1).filter_map(|s| s.split_once(':')) {
        let lower = name.to_ascii_lowercase();
        if !lower.starts_with("x-o8d-")
            && ![
                "connection",
                "content-length",
                "content-type",
                "transfer-encoding",
                "upgrade",
                "expect",
            ]
            .contains(&lower.as_str())
        {
            request = request.header(name, value.trim());
        }
    }
    let mut result = request
        .header("x-o8d-bridge", key)
        .header("x-o8d-peer", "unverified-proxy")
        .header("x-o8d-session-read", "complete-directives/1")
        .header("content-type", "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|_| ())?;
    if result.status() != StatusCode::OK && !result.headers().contains_key("x-o8d-local-stage") {
        return Err(());
    }
    let mut response = axum::response::Response::builder().status(result.status());
    for name in ["content-type", "cache-control", "x-o8d-local-stage"] {
        if let Some(value) = result.headers().get(name) {
            response = response.header(name, value);
        }
    }
    let mut bytes = Vec::new();
    loop {
        match result.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 16 * 1024 * 1024 => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return Err(()),
        }
    }
    response.body(axum::body::Body::from(bytes)).map_err(|_| ())
}

/// One route-specific composition hop on the existing authenticated backhaul.
/// No public API, new client, policy cache or Node local-stage recomputation.
async fn compose_threads(
    target: &str,
    header: &str,
    upstream: &str,
    key: &str,
    response: axum::response::Response,
) -> Result<axum::response::Response, ()> {
    let body = to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .map_err(|_| ())?;
    let mut request = admission_client()?.post(format!("http://{upstream}{target}"));
    for (name, value) in header
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
    {
        let lower = name.to_ascii_lowercase();
        if lower.starts_with("x-o8d-")
            || [
                "connection",
                "content-length",
                "transfer-encoding",
                "upgrade",
                "expect",
                "content-type",
            ]
            .contains(&lower.as_str())
        {
            continue;
        }
        request = request.header(name, value.trim());
    }
    let mut composed = request
        .header("x-o8d-bridge", key)
        .header("x-o8d-peer", "unverified-proxy")
        .header("x-o8d-session-read", "compose-threads/1")
        .header("content-type", "application/json")
        .timeout(Duration::from_secs(60))
        .body(body)
        .send()
        .await
        .map_err(|_| ())?;
    if composed.status() != StatusCode::OK {
        return Err(());
    }
    let mut response = axum::response::Response::builder().status(composed.status());
    for (name, value) in composed.headers() {
        if [
            "connection",
            "content-length",
            "transfer-encoding",
            "keep-alive",
            "upgrade",
        ]
        .contains(&name.as_str())
        {
            continue;
        }
        response = response.header(name, value);
    }
    let mut body = Vec::new();
    loop {
        match composed.chunk().await {
            Ok(Some(chunk)) if body.len() + chunk.len() <= 16 * 1024 * 1024 => {
                body.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return Err(()),
        }
    }
    response
        .header("x-o8d-local-stage", "threads/1")
        .body(axum::body::Body::from(body))
        .map_err(|_| ())
}

pub(super) async fn write_response(
    socket: &mut TcpStream,
    response: axum::response::Response,
    count: &super::request_counts::Count,
) -> Result<Outcome, ()> {
    let status = response.status();
    let mut output = format!(
        "HTTP/1.1 {} {}\r\nConnection: close\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("Response")
    );
    if !response.headers().contains_key("x-o8d-local-stage") {
        output.push_str("x-o8d-native: 1\r\nx-o8d-native-session-read: 1\r\n");
    }
    for (name, value) in response.headers() {
        // The socket writer computes framing from the final body. Byte viewers
        // already carry Content-Length; never emit a duplicate framing header.
        if name == axum::http::header::CONTENT_LENGTH || name.as_str() == "x-o8d-directives-timing" { continue; }
        output.push_str(&format!("{name}: {}\r\n", value.to_str().map_err(|_| ())?));
    }
    let body = to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .map_err(|_| ())?;
    output.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
    socket.write_all(output.as_bytes()).await.map_err(|_| ())?;
    socket.write_all(&body).await.map_err(|_| ())?;
    socket.shutdown().await.map_err(|_| ())?;
    count.finish(Some(status.as_u16())).await;
    Ok(Outcome::Served)
}

/// Existing static backhaul compatibility; the public native gate already
/// verified this operator credential. Delivery never authorizes a write.
pub(super) async fn publish_legacy_notice(producer: &super::Producer, notice: serde_json::Value, header: &str) -> Result<(), ()> {
    let bearer = header.lines().skip(1).filter_map(|line| line.split_once(':'))
        .find(|(name,_)| name.eq_ignore_ascii_case("authorization")).map(|(_,v)| v.trim()).ok_or(())?;
    let response = admission_client()?.post(format!("http://{}/internal/realtime", producer.upstream))
        .header("authorization", bearer).header("x-o8d-bridge", &producer.bridge_key)
        .header("x-o8d-peer", "127.0.0.1").timeout(Duration::from_millis(250))
        .json(&notice).send().await.map_err(|_| ())?;
    if response.status().is_success() { Ok(()) } else { Err(()) }
}
