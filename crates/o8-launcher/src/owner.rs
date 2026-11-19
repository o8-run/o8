//! Front-door owner command. Node is an attachable producer, never this process's parent.
use super::Config;
use std::{path::PathBuf, process::Command};

pub(super) fn binary(config: &Config) -> Result<PathBuf, String> {
    let explicit = std::env::var_os("O8D_BINARY").map(PathBuf::from);
    if let Some(path) = explicit {
        if !path.is_absolute() && !path.to_string_lossy().contains(['/', '\\']) {
            return Err("O8D_BINARY must be an explicit executable path".into());
        }
        // Node's old resolver runs from server_dir and resolves explicit paths.
        let path = if path.is_absolute() {
            path
        } else {
            config.server_dir.join(path)
        };
        return path
            .is_file()
            .then_some(path)
            .ok_or_else(|| "Explicit o8d binary unavailable".into());
    }
    let sibling = std::env::current_exe()
        .map_err(|_| "Install unavailable")?
        .with_file_name("o8d");
    [config.server_dir.join("o8d"), sibling]
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| "Bundled o8d unavailable".into())
}

pub(super) fn command(config: &Config, boot: &str, instance: &str) -> Result<Command, String> {
    let mut command = Command::new(binary(config)?);
    // Keep provider/worker credentials out of the native owner. Profile/token
    // authority is read fresh from the existing files, never provisioned here.
    command.env_clear();
    for name in [
        "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TMP", "TEMP",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let host = o8_launch_core::ports::listen_host_in(
        std::env::var("O8_LAN_ACCESS").ok().as_deref(),
        &config.data_dir,
    );
    command
        .args([
            "--experimental-ws",
            "--listen",
            &format!("{host}:{}", config.api_port),
            "--producer-socket",
        ])
        .arg(&config.producer_socket)
        .env("O8D_BRIDGE_KEY", &config.producer_key)
        .env("O8_API_FRONT_DOOR", "1")
        .env("O8D_NATIVE_OWNED", "1")
        .env("O8D_SERVER_VERSION", &config.version)
        .env("O8_BOOT_ID", boot)
        .env("O8_INSTANCE_ID", instance)
        .env("O8D_SESSION_DATA_DIR", &config.data_dir)
        .env(
            "O8D_REQUEST_COUNTS_PATH",
            config.data_dir.join("o8d-request-counts.jsonl"),
        );
    if let Some(value) = std::env::var_os("CORTEX_IDE_DB_PATH") {
        command.env("O8D_SESSION_DB_PATH", value);
    }
    // Preserve the old explicit opt-in; do not enable dormant readers globally.
    let reads = std::env::var("O8D_NATIVE_SESSION_READS")
        .map(|v| v == "1")
        .unwrap_or_else(|_| std::env::var("O8_NEXT_O8D").as_deref() == Ok("1"));
    if reads {
        command.env("O8D_NATIVE_SESSION_READS", "1");
    }
    Ok(command)
}
