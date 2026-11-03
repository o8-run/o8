//! Native saved reads after a per-request admission by the existing TS gates.
use crate::http;
use axum::{body::to_bytes, http::StatusCode};
use std::{path::PathBuf, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

pub(super) fn enabled() -> bool {
    std::env::var("O8D_NATIVE_SESSION_READS").as_deref() == Ok("1")
}

/// Returns false when the original streaming TS path must own the request.
pub(super) async fn serve(
    socket: &mut TcpStream,
    header: &str,
    upstream: &str,
    key: &str,
) -> Result<bool, ()> {
    if !enabled() {
        return Ok(false);
    }
    let mut line = header.lines().next().ok_or(())?.split_whitespace();
    if line.next() != Some("GET") {
        return Ok(false);
    }
    let target = line.next().ok_or(())?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if header
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .any(|(name, value)| {
            name.eq_ignore_ascii_case("transfer-encoding")
                || (name.eq_ignore_ascii_case("content-length") && value.trim() != "0")
        })
    {
        return Ok(false);
    }
    if !http::is_session_read(path) {
        return Ok(false);
    }
    // Admit the original path/method/headers through production middleware and
    // the queue's in-handler gate. Never cache principal or credential decisions.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| ())?;
    let mut request = client.get(format!("http://{upstream}{target}"));
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
    let admission = request
        .header("x-o8d-bridge", key)
        .header("x-o8d-peer", "unverified-proxy")
        .header("x-o8d-session-read", "authorize")
        .send()
        .await
        .map_err(|_| ())?;
    if admission.status() != StatusCode::NO_CONTENT {
        // Let the original handler return its exact auth/error response. An
        // unavailable gate never grants native access.
        return Ok(false);
    }
    let directory = PathBuf::from(std::env::var("O8D_SESSION_DATA_DIR").map_err(|_| ())?)
        .canonicalize()
        .map_err(|_| ())?;
    let database = std::env::var_os("O8D_SESSION_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| directory.join("cortex-ide.db"));
    let path = path.to_owned();
    let query = query.to_owned();
    let response =
        tokio::task::spawn_blocking(move || http::session_read(directory, database, &path, &query))
            .await
            .map_err(|_| ())?;
    // Runtime transcripts, lane overlays, network projections and dynamic steer
    // capabilities remain TS-owned until their readers are ported.
    if response.status() == StatusCode::SERVICE_UNAVAILABLE {
        return Ok(false);
    }
    // The classifier only peeked. Consume the header before closing the socket.
    socket
        .read_exact(&mut vec![0; header.len()])
        .await
        .map_err(|_| ())?;
    let status = response.status();
    let mut output = format!(
        "HTTP/1.1 {} {}\r\nConnection: close\r\nx-o8d-native-session-read: 1\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("Response")
    );
    for (name, value) in response.headers() {
        output.push_str(&format!("{name}: {}\r\n", value.to_str().map_err(|_| ())?));
    }
    let body = to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .map_err(|_| ())?;
    output.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
    socket.write_all(output.as_bytes()).await.map_err(|_| ())?;
    socket.write_all(&body).await.map_err(|_| ())?;
    socket.shutdown().await.map_err(|_| ())?;
    Ok(true)
}
