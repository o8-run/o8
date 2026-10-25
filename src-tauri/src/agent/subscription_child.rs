//! Native planner seats have subscription authority only. API credentials must
//! be resolved by a payer-aware server launch, never by ambient inheritance.
use std::process::{Command, Stdio};

fn command(
    binary: &str,
    path: &str,
    args: impl IntoIterator<Item = impl AsRef<std::ffi::OsStr>>,
) -> Command {
    let mut child = crate::child_environment::command(binary);
    child
        .args(args)
        .current_dir(std::env::temp_dir())
        .env("PATH", path)
        .env("FORCE_COLOR", "0")
        .env("NO_COLOR", "1")
        .env("O8_MANAGED_SESSION", "1");
    child
}

pub(crate) fn claude(binary: &str, path: &str, args: &[&str]) -> Command {
    let mut child = command(binary, path, args);
    child
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    child
}

pub(crate) fn codex_exec(binary: &str, path: &str, args: &[String]) -> Command {
    command(binary, path, args)
}

pub(crate) fn codex_app_server(binary: &str, path: &str, args: &[String]) -> Command {
    let mut child = command(binary, path, args);
    child
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    child
}

pub(crate) fn opencode(binary: &str, path: &str, args: &[String]) -> Command {
    command(binary, path, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    // This test executable is the fake CLI; it prints presence flags only.
    #[test]
    fn fake_cli() {
        if std::env::var_os("O8_MANAGED_SESSION").is_none() {
            return;
        }
        let denied = [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "OPENAI_API_KEY",
            "OPENROUTER_API_KEY",
            "GEMINI_API_KEY",
            "API_KEY",
            "O8_MASTER_KEY",
            "NODE_OPTIONS",
            "BASH_ENV",
            "O8_PAYER_UNAPPROVED",
        ];
        let safe = denied.iter().all(|name| std::env::var_os(name).is_none());
        let login = [
            "HOME",
            "PATH",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "OPENCODE_CONFIG_DIR",
        ]
        .iter()
        .all(|name| std::env::var_os(name).is_some());
        println!("payer-receipt: denied={safe} login={login}");
    }

    #[test]
    fn fake_server() {
        if std::env::var_os("O8_MANAGED_SESSION").is_none() {
            return;
        }
        let broker = ["ANTHROPIC_API_KEY", "O8_MASTER_KEY"]
            .iter()
            .all(|name| std::env::var_os(name).is_some());
        let limited = [
            "ANTHROPIC_AUTH_TOKEN",
            "NODE_OPTIONS",
            "BASH_ENV",
            "O8_PAYER_UNAPPROVED",
        ]
        .iter()
        .all(|name| std::env::var_os(name).is_none());
        println!("broker-receipt: credentials={broker} limited={limited}");
    }

    #[test]
    fn all_native_subscription_builders_deny_ambient_credentials() {
        let _lock = crate::DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        // The entire test runs in a disposable process; fake values never reach
        // a provider executable and assertions do not contain their values.
        let names = [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "OPENAI_API_KEY",
            "OPENROUTER_API_KEY",
            "GEMINI_API_KEY",
            "API_KEY",
            "O8_MASTER_KEY",
            "NODE_OPTIONS",
            "BASH_ENV",
            "O8_PAYER_UNAPPROVED",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "OPENCODE_CONFIG_DIR",
        ];
        let previous: Vec<_> = names
            .iter()
            .map(|name| (*name, std::env::var_os(name)))
            .collect();
        for name in names {
            std::env::set_var(name, "fixture-marker");
        }
        let binary = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let path = std::env::var("PATH").unwrap_or_default();
        let test_name = format!("{}::fake_cli", module_path!().split_once("::").unwrap().1);
        let args = ["--exact", &test_name, "--nocapture"];
        let strings = args.map(String::from);
        let mut generic = crate::child_environment::command(&binary);
        generic.args(args).env("O8_MANAGED_SESSION", "1");
        let builders = [
            ("native helper", generic),
            ("claude warm", claude(&binary, &path, &args)),
            ("codex exec", codex_exec(&binary, &path, &strings)),
            (
                "codex app-server",
                codex_app_server(&binary, &path, &strings),
            ),
            ("opencode", opencode(&binary, &path, &strings)),
        ];
        let mut receipts = Vec::new();
        for (name, mut child) in builders {
            let output = child.output().unwrap();
            receipts.push((
                name,
                output.status.success(),
                String::from_utf8_lossy(&output.stdout)
                    .contains("payer-receipt: denied=true login=true"),
            ));
        }
        let server_test_name = format!(
            "{}::fake_server",
            module_path!().split_once("::").unwrap().1
        );
        let output = crate::child_environment::server_command(
            &binary,
            &["ANTHROPIC_API_KEY", "O8_MASTER_KEY"],
        )
        .args(["--exact", &server_test_name, "--nocapture"])
        .env("O8_MANAGED_SESSION", "1")
        .output()
        .unwrap();
        receipts.push((
            "trusted server",
            output.status.success(),
            String::from_utf8_lossy(&output.stdout)
                .contains("broker-receipt: credentials=true limited=true"),
        ));
        for (name, value) in previous {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
        assert!(
            receipts.iter().all(|(_, success, safe)| *success && *safe),
            "native payer flags: {receipts:?}"
        );
    }
}
