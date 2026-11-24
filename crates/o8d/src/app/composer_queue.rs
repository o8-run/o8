//! Queue-specific producer RPC. Event and native-commit bounds stay separate.
use crate::http::composer_queue_owner::{Answer, Owner};
use serde_json::{json, Value};
use std::sync::Arc;
pub(super) const RPC_LIMIT: usize = 100 * 1024 * 1024;
/// The producer reader executes one request at a time, so its admitted pending
/// count is one (below the client's 32-call cap); it never spawns a request queue.
pub(super) async fn execute(
    owner: Option<Arc<Owner>>,
    epoch: &str,
    frame: &Value,
) -> (Value, Option<crate::http::commit_notice::CommitNotice>) {
    let response = |ok: bool, value: Value| {
        let mut response = json!({"v":1,"kind":"composer-queue-response","epoch":frame["epoch"],"requestId":frame["requestId"],"ok":ok});
        response[if ok { "result" } else { "error" }] = value;
        response
    };
    let error = |code: &str, message: &str| {
        (
            response(false, json!({"code":code,"message":message})),
            None,
        )
    };
    if frame["v"] != 1
        || frame["kind"] != "composer-queue-request"
        || !frame["requestId"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 256)
        || !frame["epoch"].is_string()
        || !frame["method"].is_string()
        || !frame["params"].is_object()
    {
        return error("invalid", "Invalid composer queue request.");
    }
    if frame["epoch"] != epoch {
        return error(
            "stale_epoch",
            "The composer queue executor changed. Reconnect before sending.",
        );
    }
    let Some(owner) = owner else {
        return error("unavailable", "The composer queue owner is unavailable.");
    };
    let method = frame["method"].as_str().unwrap().to_owned();
    let params = frame["params"].clone();
    // Mutators are not retried. A caller deadline or lost reply is an unknown
    // outcome and must use the fenced get/admit reconciliation contract.
    match tokio::task::spawn_blocking(move || owner.execute(&method, &params)).await {
        Ok(Ok(Answer { result, notice })) => (response(true, result), notice),
        Ok(Err(error)) => (response(false, error.wire()), None),
        Err(_) => error("unavailable", "The composer queue owner is unavailable."),
    }
}

/// Private extension selects the queue's bounded response writer. A successful
/// COMMIT must not become a replay because the receipt adds bytes to a 16 MiB
/// accepted payload. No public header can request this extension.
pub(super) use crate::http::composer_queue_owner::ResponseLimit;
fn response(status: axum::http::StatusCode, value: Value) -> axum::response::Response {
    use axum::response::IntoResponse;
    let mut answer = (status, axum::Json(value)).into_response();
    answer.extensions_mut().insert(ResponseLimit);
    answer
}
/// Only these narrow entry points bypass admission. Every other credential
/// class and producer-backed GET follows the existing Node admission path.
pub(super) async fn serve_http(
    socket: &mut tokio::net::TcpStream,
    header: &str,
    count: &super::request_counts::Count,
    global: &super::native_global::NativeGlobal,
    selection: &super::Selection,
) -> Result<Option<super::native::Outcome>, ()> {
    use axum::http::StatusCode;
    use tokio::io::AsyncReadExt;
    let mut parts = header.lines().next().ok_or(())?.split_whitespace();
    let method = parts.next().ok_or(())?;
    let request_target = parts.next().ok_or(())?;
    let (path, query) = request_target
        .split_once('?')
        .unwrap_or((request_target, ""));
    let internal = path == "/internal/composer-queue";
    let public = path == "/api/orchestrator/composer-queue"
        && std::env::var("O8_API_FRONT_DOOR").as_deref() == Ok("1")
        && std::env::var("O8D_NATIVE_OWNED").as_deref() == Ok("1")
        && crate::http::native_route(path, method).is_some();
    if !internal && !public {
        return Ok(None);
    }
    if public
        && (method == "GET" && selection.borrow().is_some()
            || !super::prompt_operator::eligible(socket, header, path))
    {
        return Ok(None);
    }
    if internal && !super::prompt_operator::internal_queue(socket, header) {
        return super::native::write_response(
            socket,
            response(StatusCode::UNAUTHORIZED, json!({"error":"Unauthorized"})),
            count,
        )
        .await
        .map(Some);
    }
    let mut length = None;
    for (key, value) in header.lines().skip(1).filter_map(|l| l.split_once(':')) {
        if key.eq_ignore_ascii_case("transfer-encoding") || key.eq_ignore_ascii_case("expect") {
            return if internal { Err(()) } else { Ok(None) };
        }
        if key.eq_ignore_ascii_case("content-length") {
            if length.is_some()
                || value.trim().is_empty()
                || !value.trim().bytes().all(|b| b.is_ascii_digit())
            {
                return Err(());
            }
            length = Some(value.trim().parse::<usize>().map_err(|_| ())?);
        }
    }
    let length = length.unwrap_or(0);
    if method == "GET" && length != 0 {
        return Ok(None);
    }
    // Visual receipts keep their existing Node owner.
    if public && method == "GET" && form_urlencoded::parse(query.as_bytes()).any(|(k, _)| k == "id")
    {
        return Ok(None);
    }
    socket
        .read_exact(&mut vec![0; header.len()])
        .await
        .map_err(|_| ())?;
    let limit = if internal {
        RPC_LIMIT
    } else {
        16 * 1024 * 1024
    };
    if length > limit {
        // Drain the one-byte boundary case before closing, so a valid client
        // receives 413 rather than a reset from unread request bytes.
        let drain = length.min(limit + 1);
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            tokio::io::copy(&mut socket.take(drain as u64), &mut tokio::io::sink()),
        )
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
        let error = if internal {
            "Request exceeds 100 MiB"
        } else {
            "Request exceeds 16 MiB"
        };
        return super::native::write_response(
            socket,
            response(StatusCode::PAYLOAD_TOO_LARGE, json!({"error":error})),
            count,
        )
        .await
        .map(Some);
    }
    let mut body = vec![0; length];
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        socket.read_exact(&mut body),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    let Some(owner) = global.composer_queue.clone() else {
        return super::native::write_response(socket,response(StatusCode::SERVICE_UNAVAILABLE,json!({"ok":false,"error":{"code":"unavailable","message":"The composer queue owner is unavailable."}})),count).await.map(Some);
    };
    let request = if method == "GET" {
        Ok(Value::Null)
    } else {
        serde_json::from_slice::<Value>(&body)
    };
    if public && request.is_err() {
        // Undici/V8 uses this exact message for an empty JSON document. Other
        // syntax diagnostics remain with its existing parser before any commit.
        if body.iter().all(|b| b" \t\r\n".contains(b)) {
            return super::native::write_response(
                socket,
                response(
                    StatusCode::BAD_REQUEST,
                    json!({"error":"Unexpected end of JSON input"}),
                ),
                count,
            )
            .await
            .map(Some);
        }
        return Ok(Some(super::native::Outcome::Replay(body)));
    }
    let mut answer = if internal {
        if method != "POST" {
            response(
                StatusCode::METHOD_NOT_ALLOWED,
                json!({"ok":false,"error":{"code":"invalid","message":"Invalid composer queue method."}}),
            )
        } else if let Ok(request) = request {
            let method = request["method"].as_str().unwrap_or("");
            if request["v"] != 1
                || !Owner::internal_method(method)
                || !request["params"].is_object()
            {
                response(
                    StatusCode::OK,
                    json!({"ok":false,"error":{"code":"invalid","message":"Invalid composer queue method."}}),
                )
            } else {
                let method = method.to_owned();
                let params = request["params"].clone();
                match tokio::task::spawn_blocking(move || owner.execute(&method, &params))
                    .await
                    .map_err(|_| ())?
                {
                    Ok(Answer { result, notice }) => {
                        let mut answer =
                            response(StatusCode::OK, json!({"ok":true,"result":result}));
                        if let Some(notice) = notice {
                            answer.extensions_mut().insert(notice);
                        }
                        answer
                    }
                    Err(error) => {
                        response(StatusCode::OK, json!({"ok":false,"error":error.wire()}))
                    }
                }
            }
        } else {
            response(
                StatusCode::OK,
                json!({"ok":false,"error":{"code":"invalid","message":"Invalid composer queue request."}}),
            )
        }
    } else {
        let method = method.to_owned();
        let query = query.to_owned();
        tokio::task::spawn_blocking(move || {
            crate::http::composer_queue_owner::public_request(&owner, &method, &query, request.ok())
        })
        .await
        .map_err(|_| ())?
    };
    if let Some(notice) = answer
        .extensions_mut()
        .remove::<crate::http::commit_notice::CommitNotice>()
    {
        global.committed(notice.0, selection, header).await;
        // A committed change is carried out by Node: start a parked one.
        #[cfg(unix)]
        super::wake::nudge(header, selection);
    }
    // A public precommit refusal may still need the original network/visual
    // route. Replay is safe only for the explicit unavailable response.
    if public && answer.status() == StatusCode::SERVICE_UNAVAILABLE {
        return Ok(Some(super::native::Outcome::Replay(body)));
    }
    super::native::write_response(socket, answer, count)
        .await
        .map(Some)
}
