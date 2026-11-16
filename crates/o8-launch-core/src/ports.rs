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

/// The phone access setting controls LAN binding, with an explicit environment
/// override taking precedence. Network requests still require authentication.
pub fn sidecar_listen_host() -> &'static str {
    let dir = std::env::var_os("O8_DATA_DIR")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("CORTEX_IDE_DATA_DIR").filter(|value| !value.is_empty()))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(
                std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .unwrap_or_default(),
            )
            .join(".o8")
        });
    listen_host_in(std::env::var("O8_LAN_ACCESS").ok().as_deref(), &dir)
}

pub fn listen_host_in(env: Option<&str>, data_dir: &std::path::Path) -> &'static str {
    let saved = std::fs::read_to_string(data_dir.join("phone-network")).ok();
    if lan_access_enabled(env, saved.as_deref()) {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    }
}

pub fn lan_access_enabled(env: Option<&str>, saved: Option<&str>) -> bool {
    match env {
        Some(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        None => saved == Some("on\n"),
    }
}

pub fn listen_host_for(lan_access: Option<&str>) -> &'static str {
    if lan_access_enabled(lan_access, None) {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    }
}

#[cfg(test)]
mod lan_tests {
    use super::*;
    #[test]
    fn phone_network_shared_fixtures_drive_launcher_bind_host() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/lan-access/cases.json"
        ))
        .unwrap();
        let dir = std::env::temp_dir().join(format!("o8-lan-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        for case in fixtures.as_array().unwrap() {
            let file = dir.join("phone-network");
            let _ = std::fs::remove_file(&file);
            if let Some(value) = case["file"].as_str() {
                std::fs::write(&file, value).unwrap();
            }
            let host = listen_host_in(case["env"].as_str(), &dir);
            assert_eq!(
                host,
                if case["enabled"] == true {
                    "0.0.0.0"
                } else {
                    "127.0.0.1"
                },
                "{}",
                case["name"]
            );
        }
        std::fs::remove_file(dir.join("phone-network")).unwrap();
        std::fs::create_dir(dir.join("phone-network")).unwrap();
        assert_eq!(listen_host_in(None, &dir), "127.0.0.1");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
