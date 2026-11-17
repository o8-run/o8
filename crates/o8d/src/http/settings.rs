//! Startup reads only. TypeScript owns credential/identity creation and the port resolver.
use super::{reply, unavailable, ReadContext};
use axum::{
    http::{HeaderValue, StatusCode},
    response::Response,
};
use serde_json::{json, Value};
use std::{
    net::{Ipv4Addr, SocketAddrV4, TcpStream},
    path::Path,
    time::Duration,
};

struct PortSnapshot {
    api_port: Value,
    ws_port: Value,
    source: String,
    api_mtime_ns: Option<String>,
    ws_mtime_ns: Option<String>,
}

// Node statSync({ bigint: true }).mtimeNs, including sub-millisecond changes.
// Unsupported hosts defer to TS; do not replace this with a rounded timestamp.
#[cfg(unix)]
fn mtime_ns(path: &Path) -> Result<Option<String>, ()> {
    use std::os::unix::fs::MetadataExt;
    match std::fs::metadata(path) {
        Ok(stat) => Ok(Some(
            (i128::from(stat.mtime()) * 1_000_000_000 + i128::from(stat.mtime_nsec())).to_string(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}
#[cfg(not(unix))]
fn mtime_ns(_path: &Path) -> Result<Option<String>, ()> {
    Err(())
}

fn ports(store: &ReadContext<'_>) -> Result<PortSnapshot, ()> {
    let raw: Value = serde_json::from_str(&std::env::var("O8D_STARTUP_PORT_INFO").map_err(|_| ())?)
        .map_err(|_| ())?;
    let stamp = |name: &str| match raw.get(name) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(()),
    };
    let snapshot = PortSnapshot {
        api_port: raw.get("apiPort").ok_or(())?.clone(),
        ws_port: raw.get("wsPort").ok_or(())?.clone(),
        source: raw
            .get("source")
            .and_then(Value::as_str)
            .ok_or(())?
            .to_owned(),
        api_mtime_ns: stamp("apiMtimeNs")?,
        ws_mtime_ns: stamp("wsMtimeNs")?,
    };
    if !snapshot.api_port.is_number() || !snapshot.ws_port.is_number() {
        return Err(());
    }
    match snapshot.source.as_str() {
        // Env/dev-URL resolution never touches the resolver's file cache.
        "env" => {}
        "file" if snapshot.api_mtime_ns.is_some() => {
            // TS caches BOTH ports by api-port mtime only. A new ws-port must
            // not change identity's cached wsPort. ws-info rereads it separately.
            if mtime_ns(&store.directory.join("api-port"))? != snapshot.api_mtime_ns {
                return Err(());
            }
        }
        "file" | "default" => {
            // No persistent TS cache in these cases. Any file change needs the
            // resolver owner; a launch snapshot cannot infer its new answer.
            if mtime_ns(&store.directory.join("api-port"))? != snapshot.api_mtime_ns
                || mtime_ns(&store.directory.join("ws-port"))? != snapshot.ws_mtime_ns
            {
                return Err(());
            }
        }
        _ => return Err(()),
    }
    Ok(snapshot)
}

// Match ECMAScript trim (Rust trim differs for U+0085 and U+FEFF).
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| {
        matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}'
        | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}'
        | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

// Match parseInt(text.trim(), 10)'s numeric prefix, including + and -.
fn file_port(store: &ReadContext<'_>) -> Result<Option<u16>, ()> {
    let path = store.directory.join("ws-port");
    match std::fs::metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
        Ok(_) => {}
    }
    // Unsupported encoding, outside-profile symlinks or size defer rather than
    // silently omitting a candidate that TypeScript might select.
    let bytes = store.file(&path, 4096)?;
    let text = String::from_utf8(bytes).map_err(|_| ())?;
    let text = js_trim(&text);
    if text.starts_with('-') {
        return Ok(None);
    }
    let text = text.strip_prefix('+').unwrap_or(text);
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    Ok(digits.parse::<u16>().ok().filter(|port| *port > 0))
}

fn alive(port: u16) -> bool {
    // Dispatch already runs on spawn_blocking. Drop closes a successful probe.
    TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
        Duration::from_millis(300),
    )
    .is_ok()
}

fn response(body: Value, identity: bool) -> Response {
    let mut response = reply(StatusCode::OK, body);
    // The shared history helper's cache policy differs from both TS handlers.
    response.headers_mut().remove("cache-control");
    if identity {
        response
            .headers_mut()
            .insert("cache-control", HeaderValue::from_static("no-store"));
        response
            .headers_mut()
            .insert("access-control-allow-origin", HeaderValue::from_static("*"));
    }
    response
}

pub(super) fn ws_info(store: &ReadContext<'_>) -> Response {
    let result = (|| {
        let resolved = ports(store)?
            .ws_port
            .as_u64()
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port > 0)
            .ok_or(())?;
        // TS accepts >=16 UTF-16 code units. Missing/invalid/oversized credentials
        // defer, including WS_TOKEN-only cases. Rust never generates credentials.
        let token = String::from_utf8(store.file(&store.directory.join("ws-token"), 4096)?)
            .map_err(|_| ())?;
        let token = js_trim(&token);
        if token.encode_utf16().count() < 16 {
            return Err(());
        }
        let mut selected = resolved;
        if let Some(file) = file_port(store)? {
            if alive(file) {
                selected = file;
            } else if file != resolved {
                let _ = alive(resolved);
            }
        } else {
            let _ = alive(resolved);
        }
        // If neither answers, TS reports resolved anyway. Duplicate candidates
        // receive a single probe. A live file always outranks a live env port.
        Ok(json!({"wsPort": selected, "wsToken": token}))
    })();
    match result {
        Ok(body) => response(body, false),
        Err(()) => unavailable(),
    }
}

fn id(store: &ReadContext<'_>, env_name: &str, file_name: &str) -> Result<String, ()> {
    if let Ok(value) = std::env::var(env_name) {
        let value = js_trim(&value);
        if !value.is_empty() {
            return Ok(value.to_owned());
        }
    }
    let bytes = store.file(&store.directory.join(file_name), 4096)?;
    let value = String::from_utf8(bytes).map_err(|_| ())?;
    let value = js_trim(&value);
    if value.is_empty() {
        return Err(());
    }
    Ok(value.to_owned())
}

pub(super) fn identity(store: &ReadContext<'_>) -> Response {
    let result = (|| {
        let ports = ports(store)?;
        let instance = id(store, "O8_INSTANCE_ID", "instance-id")?;
        let boot = id(store, "O8_BOOT_ID", "boot-id")?;
        let version = std::env::var("O8D_SERVER_VERSION").map_err(|_| ())?;
        if version.is_empty() {
            return Err(());
        }
        Ok(
            json!({"product": "o8", "instanceId": instance, "bootId": boot,
            "apiPort": ports.api_port, "wsPort": ports.ws_port, "version": version}),
        )
    })();
    // Includes missing IDs, E2EE-derived ID creation and cached random fallback
    // after failed writes. None may be synthesized by the Rust reader.
    match result {
        Ok(body) => response(body, true),
        Err(()) => unavailable(),
    }
}
