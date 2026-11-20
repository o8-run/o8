//! Route-scoped mobile gate. Authority is read fresh from the existing files;
//! unsupported credential classes retain the authenticated Node admission.
use super::prompt_operator::{read, trim};
use axum::{body::Body, http::StatusCode, response::Response};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path};
use subtle::ConstantTimeEq;

pub(super) enum Gate {
    Allow,
    Reply(Response),
    Proxy,
}
pub(super) fn matches(path: &str, method: &str) -> bool {
    matches!(
        (path, method),
        ("/api/mobile/diff-comment", "POST") | ("/api/mobile/diff-comments", "GET")
    )
}
fn reply(status: StatusCode, body: Value) -> Gate {
    let mut response = Response::new(Body::from(serde_json::to_vec(&body).unwrap()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    Gate::Reply(response)
}
fn forbidden(message: &str) -> Gate {
    reply(StatusCode::FORBIDDEN, json!({"error":message}))
}
fn storage() -> Gate {
    let Gate::Reply(mut response) = reply(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({"error":"Authentication storage unavailable","code":"auth_unavailable","retryable":true}),
    ) else {
        unreachable!()
    };
    response
        .headers_mut()
        .insert("retry-after", "2".parse().unwrap());
    Gate::Reply(response)
}
fn optional(root: &Path, name: &str, limit: u64) -> Result<Option<String>, ()> {
    let path = root.join(name);
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
        Ok(_) => read(&path, limit).map(Some),
    }
}
fn hash_line(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn allowed_host(host: &str, port: u16, lan: bool) -> bool {
    let host = host.to_ascii_lowercase();
    if host == "tauri.localhost" || host == format!("tauri.localhost:{port}") {
        return true;
    }
    for name in ["localhost", "127.0.0.1", "[::1]"] {
        if host == format!("{name}:{port}") || matches!(port, 80 | 443) && host == name {
            return true;
        }
    }
    if !lan {
        return false;
    }
    let bare = if let Some((address, suffix)) = host.rsplit_once(':') {
        if suffix != port.to_string() {
            return false;
        }
        address
    } else if matches!(port, 80 | 443) {
        host.as_str()
    } else {
        return false;
    };
    let parts: Vec<_> = bare.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|s| {
            !s.is_empty()
                && !(s.len() > 1 && s.starts_with('0'))
                && s.bytes().all(|b| b.is_ascii_digit())
                && s.parse::<u8>().is_ok()
        })
}
fn origin_allowed(method: &str, headers: &HashMap<String, &str>, host: &str) -> bool {
    if method == "GET" {
        return true;
    }
    match headers.get("origin").copied() {
        None => {
            !headers.contains_key("sec-fetch-site")
                && !headers.contains_key("sec-fetch-dest")
                && !headers.get("user-agent").is_some_and(|s| {
                    s.get(..8)
                        .is_some_and(|s| s.eq_ignore_ascii_case("Mozilla/"))
                })
        }
        Some("tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost") => true,
        Some(origin) => {
            let (Ok(actual), Ok(expected)) = (
                url::Url::parse(origin),
                url::Url::parse(&format!("http://{host}")),
            ) else {
                return false;
            };
            origin == actual.origin().ascii_serialization() && actual.origin() == expected.origin()
        }
    }
}
pub(super) fn check(header: &str, port: u16) -> Gate {
    let Some(root) =
        std::env::var_os("O8D_SESSION_DATA_DIR").and_then(|p| std::fs::canonicalize(p).ok())
    else {
        return Gate::Proxy;
    };
    let lan = match std::env::var("O8_LAN_ACCESS") {
        Ok(value) => matches!(
            trim(&value).to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(std::env::VarError::NotPresent) => {
            optional(&root, "phone-network", 32)
                .ok()
                .flatten()
                .as_deref()
                == Some("on\n")
        }
        Err(_) => return Gate::Proxy,
    };
    evaluate(&root, header, port, lan)
}
fn evaluate(root: &Path, header: &str, port: u16, lan: bool) -> Gate {
    if !header.is_ascii() {
        return Gate::Proxy;
    }
    let Some(header) = header.strip_suffix("\r\n\r\n") else {
        return Gate::Proxy;
    };
    let mut lines = header.split("\r\n");
    let request: Vec<_> = lines.next().unwrap_or("").split(' ').collect();
    if request.len() != 3
        || !matches!(request[2], "HTTP/1.0" | "HTTP/1.1")
        || !request[1].starts_with('/')
    {
        return Gate::Proxy;
    }
    let mut headers = HashMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Gate::Proxy;
        };
        if name.is_empty()
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || value.bytes().any(|b| b.is_ascii_control() && b != b'\t')
        {
            return Gate::Proxy;
        }
        let name = name.to_ascii_lowercase();
        if name.starts_with("x-o8d-") || headers.insert(name, trim(value)).is_some() {
            return Gate::Proxy;
        }
    }
    let Some(host) = headers.get("host").copied() else {
        return Gate::Proxy;
    };
    if !allowed_host(host, port, lan) {
        return reply(
            StatusCode::MISDIRECTED_REQUEST,
            json!({"error":"Misdirected Request"}),
        );
    }
    if !origin_allowed(request[0], &headers, host) {
        return forbidden("Origin is not allowed");
    }
    let token = headers
        .get("authorization")
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(trim)
        .unwrap_or("");
    // Their signed grants retain their current Node classification. No native
    // grant is inferred from a brand, and none can become a device/operator.
    if token.starts_with("o8br_") || token.starts_with("o8p_") {
        return Gate::Proxy;
    }
    if token.starts_with("o8ro_") {
        return forbidden("Read-only worker has no API capability.");
    }
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    let spectators = match optional(root, "broadcast-spectator-tokens", 1024 * 1024) {
        Ok(v) => v,
        Err(()) => return Gate::Proxy,
    };
    if !token.is_empty() && spectators.is_some_and(|s| s.lines().any(|line| trim(line) == hash)) {
        return forbidden("Spectator token is not authorized for this endpoint.");
    }
    let operator = match optional(root, "ws-token", 16384) {
        Ok(Some(v)) => v,
        Ok(None) => return Gate::Proxy,
        Err(()) => return Gate::Proxy,
    };
    let operator = trim(&operator);
    if operator.encode_utf16().count() < 16
        || !operator.is_ascii()
        || operator.chars().any(char::is_control)
    {
        return Gate::Proxy;
    }
    if !token.is_empty() && bool::from(token.as_bytes().ct_eq(operator.as_bytes())) {
        return Gate::Allow;
    }
    let worker = match optional(root, "worker-token", 16384) {
        Ok(v) => v,
        Err(()) => return Gate::Proxy,
    };
    let packets = match optional(root, "worker-packet-token-hashes", 1024 * 1024) {
        Ok(v) => v,
        Err(()) => return Gate::Proxy,
    };
    if !token.is_empty()
        && (worker.is_some_and(|s| {
            trim(&s).encode_utf16().count() >= 16
                && bool::from(token.as_bytes().ct_eq(trim(&s).as_bytes()))
        }) || packets
            .is_some_and(|s| s.replace("\r\n", "\n").split('\n').any(|line| line == hash)))
    {
        return forbidden("Worker token is not authorized for this endpoint.");
    }
    let projection = match optional(root, "mobile-device-tokens", 1024 * 1024) {
        Ok(v) => v.unwrap_or_default(),
        Err(()) => return storage(),
    };
    let mut active = false;
    let mut revoked = false;
    for line in projection.split('\n').filter(|line| !line.is_empty()) {
        if hash_line(line) {
            active |= !token.is_empty() && line == hash;
        } else if let Some(value) = line.strip_prefix("revoked:").filter(|v| hash_line(v)) {
            revoked |= !token.is_empty() && value == hash;
        } else {
            return storage();
        }
    }
    if active {
        return Gate::Allow;
    }
    if revoked {
        return reply(
            StatusCode::UNAUTHORIZED,
            json!({"error":"Unauthorized","code":"device_revoked"}),
        );
    }
    reply(
        StatusCode::UNAUTHORIZED,
        json!({"error":"Unauthorized","detail":"This endpoint is restricted to local o8 clients. Requests from other origins must present a valid bearer token."}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_and_browser_rules_match_the_existing_boundary() {
        for host in [
            "localhost:8123",
            "127.0.0.1:8123",
            "[::1]:8123",
            "tauri.localhost",
        ] {
            assert!(allowed_host(host, 8123, false));
        }
        assert!(!allowed_host("192.168.1.2:8123", 8123, false));
        assert!(allowed_host("192.168.1.2:8123", 8123, true));
        assert!(!allowed_host("192.168.01.2:8123", 8123, true));
        assert!(!allowed_host("localhost:08123", 8123, false));
        assert!(!allowed_host("evil.invalid:8123", 8123, true));
        let mut h = HashMap::new();
        assert!(origin_allowed("POST", &h, "127.0.0.1:8123"));
        h.insert("origin".into(), "http://127.0.0.1:8123/");
        assert!(!origin_allowed("POST", &h, "127.0.0.1:8123"));
        h.insert("origin".into(), "http://127.0.0.1:8123");
        assert!(origin_allowed("POST", &h, "127.0.0.1:8123"));
    }
    #[test]
    fn projection_rotation_worker_precedence_and_missing_authority_fail_closed() {
        let root = std::env::temp_dir().join(format!("o8-diff-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let operator = "isolated-operator-credential";
        let device = "isolated-device-credential";
        let hash = format!("{:x}", Sha256::digest(device.as_bytes()));
        std::fs::write(root.join("ws-token"), operator).unwrap();
        std::fs::write(root.join("mobile-device-tokens"), format!("{hash}\n")).unwrap();
        let request = format!("POST /api/mobile/diff-comment HTTP/1.1\r\nHost: 127.0.0.1:8123\r\nAuthorization: Bearer {device}\r\n\r\n");
        assert!(matches!(
            evaluate(&root, &request, 8123, false),
            Gate::Allow
        ));
        std::fs::write(root.join("worker-token"), device).unwrap();
        assert!(
            matches!(evaluate(&root,&request,8123,false),Gate::Reply(r) if r.status()==StatusCode::FORBIDDEN)
        );
        std::fs::remove_file(root.join("worker-token")).unwrap();
        std::fs::write(
            root.join("mobile-device-tokens"),
            format!("revoked:{hash}\n"),
        )
        .unwrap();
        assert!(
            matches!(evaluate(&root,&request,8123,false),Gate::Reply(r) if r.status()==StatusCode::UNAUTHORIZED)
        );
        std::fs::write(root.join("mobile-device-tokens"), "unavailable\n").unwrap();
        assert!(
            matches!(evaluate(&root,&request,8123,false),Gate::Reply(r) if r.status()==StatusCode::SERVICE_UNAVAILABLE)
        );
        std::fs::remove_file(root.join("ws-token")).unwrap();
        assert!(matches!(
            evaluate(&root, &request, 8123, false),
            Gate::Proxy
        ));
        std::fs::remove_dir_all(root).unwrap();
    }
}
