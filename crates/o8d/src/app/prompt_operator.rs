//! Native operator eligibility for saved prompts only; every refusal stays Node-owned.
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};
use subtle::ConstantTimeEq;
fn trim(s: &str) -> &str {
    s.trim_matches(|c| matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
fn read(path: &Path, limit: u64) -> Result<String, ()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| ())?;
        let before = file.metadata().map_err(|_| ())?;
        let stamp = |m: &std::fs::Metadata| {
            (
                m.dev(),
                m.ino(),
                m.len(),
                m.mtime(),
                m.mtime_nsec(),
                m.ctime(),
                m.ctime_nsec(),
            )
        };
        if !before.is_file() || before.len() > limit {
            return Err(());
        }
        let mut bytes = Vec::new();
        (&file)
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() as u64 > limit
            || stamp(&before) != stamp(&file.metadata().map_err(|_| ())?)
            || stamp(&before) != stamp(&std::fs::symlink_metadata(path).map_err(|_| ())?)
        {
            return Err(());
        }
        String::from_utf8(bytes).map_err(|_| ())
    }
    #[cfg(not(unix))]
    {
        let _ = (path, limit);
        Err(())
    }
}
pub(super) fn eligible(socket: &tokio::net::TcpStream, header: &str, path: &str) -> bool {
    // The window wire format is ASCII. Defer other header encodings to Node
    // rather than treating UTF-8 bytes as Node HTTP Latin-1 header characters.
    let method = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().next())
        .unwrap_or("");
    let target = path.strip_suffix("/use").unwrap_or(path);
    let use_route = target != path;
    if !header.is_ascii() {
        return false;
    }
    let single = target.strip_prefix("/api/prompt-library/").filter(|id| {
        !id.is_empty()
            && *id != "import"
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    });
    if !(if use_route {
        single.is_some() && method == "POST"
    } else if target == "/api/prompt-library" {
        matches!(method, "GET" | "POST")
    } else {
        single.is_some() && matches!(method, "GET" | "PATCH" | "DELETE")
    }) {
        return false;
    }
    // Remote/relay and unsupported boundary forms keep the existing admission.
    if !socket.peer_addr().is_ok_and(|a| a.ip().is_loopback()) {
        return false;
    }
    let mut headers = std::collections::HashMap::new();
    for (name, value) in header.lines().skip(1).filter_map(|s| s.split_once(':')) {
        let name = name.to_ascii_lowercase();
        if headers.insert(name, trim(value)).is_some() {
            return false;
        }
    }
    if headers.keys().any(|name| {
        name.starts_with("x-o8d-") || name.starts_with("x-o8-relay-") || name == "x-o8-client-addr"
    }) {
        return false;
    }
    let Some(host) = headers.get("host") else {
        return false;
    };
    let Ok(port) = socket.local_addr().map(|a| a.port()) else {
        return false;
    };
    if ![
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
        format!("tauri.localhost:{port}"),
        "tauri.localhost".to_owned(),
    ]
    .iter()
    .any(|s| s.eq_ignore_ascii_case(host))
    {
        return false;
    }
    // Exact native subset of browserWriteAllowed; unsupported forms use Node.
    if method != "GET" {
        match headers.get("origin").copied() {
            None if !headers.contains_key("sec-fetch-site")
                && !headers.contains_key("sec-fetch-dest")
                && !headers.get("user-agent").is_some_and(|s| {
                    s.get(..8)
                        .is_some_and(|p| p.eq_ignore_ascii_case("Mozilla/"))
                }) =>
            {
                ()
            }
            Some("tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost") => (),
            Some(origin) if origin == format!("http://{host}") => (),
            _ => return false,
        }
    }
    let Some(token) = headers
        .get("authorization")
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(trim)
    else {
        return false;
    };
    if token.is_empty()
        || ["o8br_", "o8ro_", "o8p_"]
            .iter()
            .any(|p| token.starts_with(p))
    {
        return false;
    }
    let Some(root) =
        std::env::var_os("O8D_SESSION_DATA_DIR").and_then(|p| std::fs::canonicalize(p).ok())
    else {
        return false;
    };
    let Ok(stored) = read(&root.join("ws-token"), 16384) else {
        return false;
    };
    let stored = trim(&stored);
    if !token.is_ascii()
        || !stored.is_ascii()
        || stored.chars().any(char::is_control)
        || stored.encode_utf16().count() < 16
        || !bool::from(token.as_bytes().ct_eq(stored.as_bytes()))
    {
        return false;
    }
    let spectators = root.join("broadcast-spectator-tokens");
    match std::fs::symlink_metadata(&spectators) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Ok(_) => {
            let Ok(hashes) = read(&spectators, 1024 * 1024) else {
                return false;
            };
            let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
            if hashes.lines().any(|line| trim(line) == hash) {
                return false;
            }
        }
        Err(_) => return false,
    }
    true
}
