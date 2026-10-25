//! Native subprocesses have no API payer authority. Server/broker settings must
//! be forwarded explicitly; provider CLI launches are subscription-only here.
use std::ffi::OsStr;
use std::process::Command;

pub(crate) fn environment() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let names: Vec<String> = serde_json::from_str(include_str!(
        "../../src/lib/providers/ambient-environment-names.json"
    ))
    .expect("compiled child environment allowlist");
    names
        .into_iter()
        .filter_map(|name| std::env::var_os(&name).map(|value| (name.into(), value)))
        .collect()
}

pub(crate) fn command(binary: impl AsRef<OsStr>) -> Command {
    let mut child = Command::new(binary);
    child.env_clear().envs(environment());
    child
}

/// Trusted server processes own credential storage/direct API access. Only the
/// server bootstrap calls this with its finite service credential name list.
pub(crate) fn server_command(binary: impl AsRef<OsStr>, names: &[&str]) -> Command {
    let mut child = command(binary);
    for name in names {
        if let Some(value) = std::env::var_os(name) {
            child.env(name, value);
        }
    }
    child
}
