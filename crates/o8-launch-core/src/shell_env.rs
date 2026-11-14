//! One login-shell probe per boot, not three.
//!
//! Finder-launched apps inherit a minimal PATH (`/usr/bin:/bin`), so o8 asks a
//! login shell where the user's real `node`, PATH, and AI provider keys live.
//! Sourcing a login shell is expensive — measured at ~0.96s on the operator's
//! machine, and it scales with how much the user has piled into their profile
//! (nvm, pyenv, rbenv, conda...). The boot path used to pay that cost THREE
//! times, serially, before the Next server was even spawned:
//!
//!   run_node_preflight()                    → `node --version`      ~0.49s
//!   augment_process_path_from_login_shell() → `zsh -l -c` for PATH  ~0.96s
//!   load_ai_keys_from_login_shell()         → `zsh -l -c` for keys  ~0.96s
//!                                              ^ re-sources the exact same rc
//!                                                files the previous line just
//!                                                sourced. Pure duplicate work.
//!
//! This module collapses that to ONE `zsh -l -c` invocation that emits PATH,
//! the node path, and the keys in a single payload, plus a cache for the node
//! ABI check so the repeated `node --version` spawn disappears entirely.
//!
//! ## Secrets
//!
//! API keys are NEVER written to disk. They live only in this process's memory
//! and in the environment of the children we spawn. Only the non-secret half of
//! the probe (the node binary path and its verified major version) is cached.

use std::path::Path;
use std::process::Command;
use std::time::UNIX_EPOCH;

use crate::no_window::NoWindow;

/// AI provider keys forwarded from the user's login shell to the sidecar
/// children. A Finder launch doesn't read `~/.zshenv`, so without this the
/// Gemini/Anthropic/OpenAI-backed features are dead in the installed app
/// even though the user has the keys in their terminal (#935).
pub const AI_KEYS: &[&str] = &[
    "GOOGLE_AI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
    // Read-only token for the founder usage-analytics dashboard (epic #1249).
    // Only present in the founder's login shell — a normal user's shell has
    // none, so nothing is forwarded and the dashboard stays hidden.
    "O8_ANALYTICS_TOKEN",
];

/// Sentinel prefixes so PATH/node lines can't collide with a key name.
const PATH_MARKER: &str = "__O8_PATH=";
const NODE_MARKER: &str = "__O8_NODE=";

/// Everything a single login-shell probe yields.
#[derive(Debug, Default, Clone)]
pub struct LoginShellEnv {
    /// The user's real PATH as a login shell sees it. Empty when every shell
    /// probe failed (caller falls back to the well-known CLI dirs).
    pub path: String,
    /// `command -v node` from the login shell. May be absent.
    pub node: Option<String>,
    /// (KEY, VALUE) pairs for whichever AI keys the shell actually exports.
    /// Never persisted — secrets stay in memory.
    pub keys: Vec<(String, String)>,
}

/// Run ONE login shell (zsh → bash → sh) and read PATH, node, and the AI keys
/// out of it in a single invocation.
///
/// Absent vars print empty and are skipped, so a user with no keys just gets an
/// empty `keys` vec. The `:;`-safe `${VAR:-}` expansion means a missing var
/// never makes the shell exit non-zero.
pub fn probe_login_shell() -> LoginShellEnv {
    let mut script = String::new();
    script.push_str("printf '__O8_PATH=%s\\n' \"$PATH\"; ");
    script.push_str("printf '__O8_NODE=%s\\n' \"$(command -v node 2>/dev/null || true)\"; ");
    for key in AI_KEYS {
        script.push_str(&format!(
            "printf '%s=%s\\n' {key} \"${{{key}:-}}\"; ",
            key = key
        ));
    }

    for shell in ["zsh", "bash", "sh"] {
        // `.no_window()` matters here even though these are POSIX shells: a
        // Windows box with Git Bash installed DOES resolve `sh`, and a console
        // window the user can click into would suspend the probe mid-boot.
        let Ok(out) = Command::new(shell)
            .args(["-l", "-c", &script])
            .no_window()
            .output()
        else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        let env = parse_probe(&String::from_utf8_lossy(&out.stdout));
        // A shell that produced no PATH told us nothing — try the next one.
        if !env.path.is_empty() {
            log::info!(
                "[shell-env] probed {} once: PATH={} entries, node={}, {} AI key(s)",
                shell,
                env.path.split(':').count(),
                env.node.as_deref().unwrap_or("<none>"),
                env.keys.len()
            );
            return env;
        }
    }

    log::warn!("[shell-env] no login shell answered; falling back to the minimal Finder PATH");
    LoginShellEnv::default()
}

/// Split the probe's stdout back into PATH / node / keys.
fn parse_probe(stdout: &str) -> LoginShellEnv {
    let mut env = LoginShellEnv::default();
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix(PATH_MARKER) {
            env.path = path.trim().to_string();
        } else if let Some(node) = line.strip_prefix(NODE_MARKER) {
            let node = node.trim();
            if !node.is_empty() && Path::new(node).exists() {
                env.node = Some(node.to_string());
            }
        } else if let Some(eq) = line.find('=') {
            let (k, v) = line.split_at(eq);
            let v = &v[1..]; // strip the '='
            if !v.is_empty() && AI_KEYS.contains(&k) {
                env.keys.push((k.to_string(), v.to_string()));
            }
        }
    }
    env
}

// ─────────────────────────── node ABI check cache ───────────────────────────
//
// `check_node_version()` execs `node --version` — ~0.49s on the operator's box,
// and it runs on every single launch to re-derive an answer that only changes
// when the binary itself changes. Cache it against the binary's identity
// (path + mtime + size) so a node upgrade busts the entry but a plain relaunch
// is free.

const NODE_CACHE_FILE: &str = "node-abi-cache";

/// `<path>\t<mtime_secs>\t<size>\t<major>\t<raw_version>`
fn node_cache_path() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    Some(format!("{}/.o8/{}", home, NODE_CACHE_FILE))
}

/// Identity of a node binary: (mtime, size). Cheap — two fields off one stat.
fn node_stamp(node_bin: &str) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(node_bin).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some((mtime, meta.len()))
}

/// Read a cached `(major, raw)` for this exact binary, if the stamp still matches.
fn cached_node_version(node_bin: &str) -> Option<(u32, String)> {
    let (mtime, size) = node_stamp(node_bin)?;
    let contents = std::fs::read_to_string(node_cache_path()?).ok()?;
    for line in contents.lines() {
        let mut parts = line.split('\t');
        let path = parts.next()?;
        if path != node_bin {
            continue;
        }
        let cached_mtime: u64 = parts.next()?.parse().ok()?;
        let cached_size: u64 = parts.next()?.parse().ok()?;
        if cached_mtime != mtime || cached_size != size {
            return None; // binary changed — re-verify
        }
        let major: u32 = parts.next()?.parse().ok()?;
        let raw = parts.next()?.to_string();
        return Some((major, raw));
    }
    None
}

/// Persist a verified `(major, raw)` for this binary. Best-effort; a write
/// failure just means we re-exec `node --version` next boot.
fn cache_node_version(node_bin: &str, major: u32, raw: &str) {
    let Some((mtime, size)) = node_stamp(node_bin) else {
        return;
    };
    let Some(cache) = node_cache_path() else {
        return;
    };
    // Keep entries for other binaries (nvm users switch back and forth), drop
    // any stale entry for this one.
    let mut lines: Vec<String> = std::fs::read_to_string(&cache)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.starts_with(&format!("{}\t", node_bin)))
        .map(str::to_string)
        .collect();
    lines.push(format!("{}\t{}\t{}\t{}\t{}", node_bin, mtime, size, major, raw));
    // Bound it — a runaway cache file helps nobody.
    if lines.len() > 16 {
        let excess = lines.len() - 16;
        lines.drain(0..excess);
    }
    let _ = std::fs::write(cache, lines.join("\n"));
}

/// `node --version` for `node_bin`, served from cache when the binary is
/// unchanged since we last checked it. Returns `(major, raw_version)`.
///
/// The ABI pin this protects (#1032: better-sqlite3 is compiled against Node
/// 22's NODE_MODULE_VERSION) is preserved exactly — the cache is keyed on the
/// binary's mtime+size, so swapping node versions invalidates the entry and we
/// re-exec. We never trust a cached answer for a binary that changed.
pub fn check_node_version_cached(node_bin: &str) -> Option<(u32, String)> {
    if let Some(hit) = cached_node_version(node_bin) {
        return Some(hit);
    }
    let out = Command::new(node_bin)
        .arg("--version")
        .no_window()
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let major: u32 = raw
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()?;
    cache_node_version(node_bin, major, &raw);
    Some((major, raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_path_node_and_keys() {
        let stdout = "__O8_PATH=/usr/local/bin:/usr/bin\n\
                      __O8_NODE=/definitely/not/a/real/node\n\
                      GEMINI_API_KEY=abc123\n\
                      OPENAI_API_KEY=\n\
                      NOT_A_KNOWN_KEY=leakme\n";
        let env = parse_probe(stdout);
        assert_eq!(env.path, "/usr/local/bin:/usr/bin");
        // The node path doesn't exist on disk, so it's rejected.
        assert_eq!(env.node, None);
        // Empty values are skipped; unknown keys are never picked up.
        assert_eq!(env.keys, vec![("GEMINI_API_KEY".into(), "abc123".into())]);
    }

    #[test]
    fn key_values_may_contain_equals_signs() {
        let stdout = "__O8_PATH=/bin\nANTHROPIC_API_KEY=sk-ant-a=b=c\n";
        let env = parse_probe(stdout);
        assert_eq!(
            env.keys,
            vec![("ANTHROPIC_API_KEY".into(), "sk-ant-a=b=c".into())]
        );
    }

    #[test]
    fn empty_stdout_yields_empty_env() {
        let env = parse_probe("");
        assert!(env.path.is_empty());
        assert!(env.node.is_none());
        assert!(env.keys.is_empty());
    }

    #[test]
    fn node_version_check_matches_the_real_binary() {
        // Whatever node ran the test suite's toolchain — just prove the parse
        // path works end to end and that a second call is served from cache.
        if let Ok(out) = Command::new("node").arg("--version").output() {
            if out.status.success() {
                let node = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let expected_major: u32 = node
                    .trim_start_matches('v')
                    .split('.')
                    .next()
                    .unwrap()
                    .parse()
                    .unwrap();
                if let Ok(which) = Command::new("sh").args(["-c", "command -v node"]).output() {
                    let bin = String::from_utf8_lossy(&which.stdout).trim().to_string();
                    if !bin.is_empty() {
                        let (major, _) = check_node_version_cached(&bin).unwrap();
                        assert_eq!(major, expected_major);
                        // Second call: same answer, now from the cache.
                        let (major2, _) = check_node_version_cached(&bin).unwrap();
                        assert_eq!(major2, expected_major);
                    }
                }
            }
        }
    }
}
