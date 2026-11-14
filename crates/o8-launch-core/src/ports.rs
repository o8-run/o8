pub const PROD_API_DEFAULT_PORT: u16 = 47100;
pub const PROD_WS_DEFAULT_PORT: u16 = 47105;
pub const PROD_API_PORT_RANGE: std::ops::Range<u16> = 47100..47105;
pub const PROD_WS_PORT_RANGE: std::ops::Range<u16> = 47105..47110;

pub fn bundled_sidecar_port_available(port: u16) -> bool {
    if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
        return false;
    }
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Returns the first port in the range that the bundled sidecar can claim.
/// `skip` lets the caller avoid picking the same port for API and WS.
pub fn find_free_port(range: std::ops::Range<u16>, skip: Option<u16>) -> Option<u16> {
    for port in range {
        if Some(port) == skip {
            continue;
        }
        if bundled_sidecar_port_available(port) {
            return Some(port);
        }
    }
    None
}

pub fn bind_ephemeral_port(skip: Option<u16>) -> u16 {
    for _ in 0..16 {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", 0)) {
            if let Ok(addr) = listener.local_addr() {
                let port = addr.port();
                drop(listener);
                if Some(port) != skip && bundled_sidecar_port_available(port) {
                    return port;
                }
            }
        }
    }
    0
}

/// Bind host for the bundled Next server (and, via the inherited
/// `O8_LAN_ACCESS`, the ws-server — see src/lib/panel/listen-host.ts).
/// Loopback by default: every desktop caller uses 127.0.0.1, and a wildcard
/// bind exposes the API to the whole LAN/VPN. `O8_LAN_ACCESS=1` opts in to
/// 0.0.0.0 so a phone can reach this machine directly for mobile pairing.
pub fn sidecar_listen_host() -> &'static str {
    listen_host_for(std::env::var("O8_LAN_ACCESS").ok().as_deref())
}

pub fn listen_host_for(lan_access: Option<&str>) -> &'static str {
    match lan_access
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("1" | "true" | "yes" | "on") => "0.0.0.0",
        _ => "127.0.0.1",
    }
}
