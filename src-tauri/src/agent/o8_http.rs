//! Symon agent → o8 loopback HTTP client (Tier-2 transport).
//!
//! Symon is a third client of o8's own Next backend — the SAME routes the
//! operator MCP wraps and the desktop UI calls — reached over `127.0.0.1`. No
//! orchestration logic is duplicated here: the bridge tools (`tools/o8_bridge`)
//! read o8 state and create gated missions through this client; o8's DB stays
//! the single source of truth.
//!
//! Port + token resolve exactly like the tray's `http_get_local` in lib.rs:
//! `O8_API_PORT` env first (set in-process by the sidecar), then `~/.o8/api-port`,
//! default 3001. We send the `~/.o8/ws-token` as a Bearer header so the request
//! passes `src/middleware.ts` even if loopback-origin detection doesn't fire.

use serde_json::Value;
use std::time::{Duration, Instant};

const TIMEOUT_SECS: u64 = 20;

/// Resolve the API port: env first, then `~/.o8/api-port`, default 3001.
fn api_port() -> u16 {
    if let Ok(p) = std::env::var("O8_API_PORT") {
        if let Ok(parsed) = p.parse() {
            return parsed;
        }
    }
    let path = super::agent_data_dir().join("api-port");
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(parsed) = raw.trim().parse() {
            return parsed;
        }
    }
    3001
}

/// The cross-origin auth token written by the sidecar (empty string if absent).
pub(crate) fn ws_token() -> String {
    let path = super::agent_data_dir().join("ws-token");
    std::fs::read_to_string(&path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn base() -> String {
    format!("http://127.0.0.1:{}", api_port())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("reqwest build failed: {e}"))
}

/// Attach the Bearer token when present so the middleware gate passes.
fn with_auth(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    let token = ws_token();
    if token.is_empty() {
        req
    } else {
        req.bearer_auth(token)
    }
}

/// GET a loopback path, parsing the JSON body.
pub async fn get_json(path: &str) -> Result<Value, String> {
    get_json_timeout(path, TIMEOUT_SECS).await
}

/// GET with a custom timeout for bounded verification probes.
pub async fn get_json_timeout(path: &str, timeout_secs: u64) -> Result<Value, String> {
    read_json(path, get_response_timeout(path, timeout_secs).await?).await
}

/// GET with the existing loopback authorization, retaining the HTTP status.
pub(crate) async fn get_response_timeout(
    path: &str,
    timeout_secs: u64,
) -> Result<reqwest::Response, String> {
    let url = format!("{}{}", base(), path);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("reqwest build failed: {e}"))?;
    with_auth(client.get(&url))
        .send()
        .await
        .map_err(|e| transport_error("GET", path, timeout_secs, &e))
}

/// POST a JSON body to a loopback path, parsing the JSON response.
pub async fn post_json(path: &str, body: Value) -> Result<Value, String> {
    post_json_timeout(path, body, TIMEOUT_SECS).await
}

fn receipt_in_progress(status: reqwest::StatusCode, payload: &Value) -> bool {
    let receipt = payload.get("result").unwrap_or(payload);
    status == reqwest::StatusCode::ACCEPTED
        || receipt.get("inProgress").and_then(Value::as_bool) == Some(true)
        || receipt.get("status").and_then(Value::as_str) == Some("in_progress")
}

/// Replay one exact body-bound mutation until o8 returns its terminal receipt.
/// Transport loss and HTTP 202 never mint a second mutation id.
pub async fn post_correlated_json(path: &str, body: Value) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(5 * 60);
    let mut last_transport_error: Option<String>;
    loop {
        let url = format!("{}{}", base(), path);
        match with_auth(client()?.post(&url).json(&body)).send().await {
            Ok(resp) => {
                let status = resp.status();
                match resp.text().await {
                    Err(error) => {
                        last_transport_error = Some(format!("o8 {path} read failed: {error}"));
                    }
                    Ok(text) => match serde_json::from_str::<Value>(&text) {
                        Err(error) => {
                            last_transport_error = Some(format!(
                                "o8 {path} returned an incomplete JSON receipt: {error}"
                            ));
                        }
                        Ok(payload) => {
                            if !status.is_success() {
                                let snippet = crate::utf8_head(&text, 300);
                                return Err(format!("o8 {path} error ({status}): {snippet}"));
                            }
                            if !receipt_in_progress(status, &payload) {
                                return Ok(payload);
                            }
                            last_transport_error = None;
                        }
                    },
                }
            }
            Err(error) => {
                last_transport_error = Some(transport_error("POST", path, TIMEOUT_SECS, &error));
            }
        }
        if Instant::now() >= deadline {
            return Err(last_transport_error.unwrap_or_else(|| {
                format!("o8 {path} is still running after 300s; reuse the same mutation id")
            }));
        }
        tokio::time::sleep(Duration::from_millis(750)).await;
    }
}

/// POST with a custom timeout for slow endpoints — the Brain's
/// `/api/cortex/ask/answer` synthesizes with an LLM and regularly exceeds the
/// default 20s (measured 24s on a trivial question; the MCP `cortex_ask`
/// twin uses a 90s override for the same reason).
pub async fn post_json_timeout(path: &str, body: Value, timeout_secs: u64) -> Result<Value, String> {
    let url = format!("{}{}", base(), path);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("reqwest build failed: {e}"))?;
    let resp = with_auth(client.post(&url).json(&body))
        .send()
        .await
        .map_err(|e| transport_error("POST", path, timeout_secs, &e))?;
    read_json(path, resp).await
}

fn transport_error(method: &str, path: &str, timeout_secs: u64, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        format!("o8 {method} {path} timed out after {timeout_secs}s")
    } else {
        format!("o8 {method} {path} failed: {error}")
    }
}

pub fn is_timeout_error(message: &str) -> bool {
    message.contains(" timed out after ")
}

/// PATCH a JSON body to a loopback path, parsing the JSON response.
pub async fn patch_json(path: &str, body: Value) -> Result<Value, String> {
    let url = format!("{}{}", base(), path);
    let resp = with_auth(client()?.patch(&url).json(&body))
        .send()
        .await
        .map_err(|e| format!("o8 PATCH {path} failed: {e}"))?;
    read_json(path, resp).await
}

/// DELETE a loopback path, parsing the JSON response.
pub async fn delete_json(path: &str) -> Result<Value, String> {
    let url = format!("{}{}", base(), path);
    let resp = with_auth(client()?.delete(&url))
        .send()
        .await
        .map_err(|e| format!("o8 DELETE {path} failed: {e}"))?;
    read_json(path, resp).await
}

async fn read_json(path: &str, resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("o8 {path} read failed: {e}"))?;
    if !status.is_success() {
        let snippet = crate::utf8_head(&text, 300);
        return Err(format!("o8 {path} error ({status}): {snippet}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("o8 {path} returned bad JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{is_timeout_error, receipt_in_progress};
    use serde_json::json;

    #[test]
    fn timeout_classifier_only_accepts_the_transport_timeout_marker() {
        assert!(is_timeout_error(
            "o8 POST /api/canvas/intent timed out after 15s"
        ));
        assert!(!is_timeout_error(
            "o8 POST /api/canvas/intent failed: connection refused"
        ));
    }

    #[test]
    fn correlated_receipt_classifier_requires_unfinished_truth() {
        assert!(receipt_in_progress(
            reqwest::StatusCode::ACCEPTED,
            &json!({ "ok": true })
        ));
        assert!(receipt_in_progress(
            reqwest::StatusCode::OK,
            &json!({ "result": { "inProgress": true } })
        ));
        assert!(!receipt_in_progress(
            reqwest::StatusCode::OK,
            &json!({ "ok": true, "status": "queued" })
        ));
    }
}
