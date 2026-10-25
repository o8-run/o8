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

#[cfg(test)]
mod provider_receipts {
    use super::*;

    #[test]
    fn receiver() {
        if let Ok(name) = std::env::var("O8_TEST_PROVIDER_RECEIPT_NAME") {
            println!(
                "provider-receipt: present={}",
                std::env::var_os(name).is_some()
            );
        }
    }

    fn receipt(name: &str) {
        let _lock = crate::DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let previous = std::env::var_os(name);
        std::env::set_var(name, "fixture-provider-marker");
        let binary = std::env::current_exe().unwrap();
        let filter = format!("{}::receiver", module_path!().split_once("::").unwrap().1);
        let mut names = crate::shell_env::AI_KEYS.to_vec();
        names.push("O8_MASTER_KEY");
        let mut results = Vec::new();
        for (broker, mut child) in [
            (true, server_command(&binary, &names)),
            (false, command(&binary)),
        ] {
            let output = child
                .args(["--exact", &filter, "--nocapture"])
                .env("O8_TEST_PROVIDER_RECEIPT_NAME", name)
                .output()
                .unwrap();
            results.push((
                broker,
                output.status.success(),
                String::from_utf8_lossy(&output.stdout).contains(if broker {
                    "provider-receipt: present=true"
                } else {
                    "provider-receipt: present=false"
                }),
            ));
        }
        if let Some(value) = previous {
            std::env::set_var(name, value);
        } else {
            std::env::remove_var(name);
        }
        assert!(
            results
                .iter()
                .all(|(_, success, expected)| *success && *expected),
            "provider name={name}, flags={results:?}"
        );
    }

    macro_rules! provider {
        ($test:ident, $name:literal) => {
            #[test]
            fn $test() {
                receipt($name);
            }
        };
    }
    provider!(xai, "XAI_API_KEY");
    provider!(openrouter, "OPENROUTER_API_KEY");
    provider!(openai, "OPENAI_API_KEY");
    provider!(anthropic, "ANTHROPIC_API_KEY");
    provider!(deepseek, "DEEPSEEK_API_KEY");
    provider!(gemini, "GEMINI_API_KEY");
    provider!(groq, "GROQ_API_KEY");
    provider!(elevenlabs, "ELEVENLABS_API_KEY");
    provider!(google_tts, "GOOGLE_TTS_API_KEY");
    provider!(google_ai_alias, "GOOGLE_AI_API_KEY");
    provider!(google_generative_alias, "GOOGLE_GENERATIVE_AI_API_KEY");
    provider!(google_alias, "GOOGLE_API_KEY");
    provider!(codex_alias, "CODEX_API_KEY");
    provider!(anthropic_alias, "ANTHROPIC_AUTH_TOKEN");
}
