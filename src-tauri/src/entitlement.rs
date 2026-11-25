//! Plan-token (EdDSA license JWT) + managed-inference proxy routing.
//!
//! When the user has NO local provider key but DOES have an active o8 plan, the
//! Rust voice surface (Symon agent, Ask, dictation polish, Whisper STT) routes
//! through the o8 managed-inference proxy instead of failing. The proxy meters
//! the call server-side against the plan's daily cap and bills OUR funded key —
//! "you pay o8 only when o8 spends for you."
//!
//! Resolution order mirrors the TS `inference-route.ts`:
//!   local key  → direct (founder / BYOK; unchanged)
//!   plan token → proxy  (hosted `/v1/*` with the JWT as Bearer)
//!   neither    → None   (caller surfaces "add a key / sign in")
//!
//! The plan token is the `licenseKey` field of `~/.o8/entitlement.json`, written
//! by the TS entitlement layer (`src/lib/entitlement/`). Read-only here.

use std::path::PathBuf;

/// Default hosted o8 API. Overridable via
/// `O8_PROXY_URL` (matches the TS resolver default in `inference-route.ts`).
const DEFAULT_O8_API_BASE_URL: &str = "https://api.o8.run";

/// Canonical o8 data dir (`~/.o8`, overridable). Mirrors `stt::keys::o8_data_dir`
/// — kept local so this module stays dependency-free.
fn o8_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("O8_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(dir) = std::env::var("CORTEX_IDE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".o8")
}

/// Base URL of the managed-inference proxy, trailing slashes trimmed.
pub fn proxy_base_url() -> String {
    let raw = std::env::var("O8_PROXY_URL").unwrap_or_default();
    let base = if raw.trim().is_empty() {
        DEFAULT_O8_API_BASE_URL
    } else {
        raw.trim()
    };
    base.trim_end_matches('/').to_string()
}

/// True when the dev "View as Free" switch (#1517) is downclamping this machine
/// to the free experience. Mirrors the TS `dev-override.ts` file: the view-as
/// switch only ever writes a DOWNGRADE, and the only plan Q previews is `free`,
/// so a `{ "plan": "free" }` override forces the free voice path. A missing file
/// (or any non-free override plan) leaves the token path unchanged. Never panics.
fn dev_override_forces_free() -> bool {
    let path = o8_data_dir().join("dev-plan-override");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    value.get("plan").and_then(|p| p.as_str()) == Some("free")
}

/// The plan-token bearer — the raw EdDSA JWT from `~/.o8/entitlement.json`
/// (`licenseKey`). Returns None unless it looks like a compact JWT (3
/// dot-separated segments); the proxy makes the real validity call.
///
/// When "View as Free" is active we return None so the managed-proxy voice paths
/// (Symon / Ask / dictation polish / Whisper STT) simulate the free experience.
/// The license FILE is never modified — clearing the override restores the perk.
pub fn read_license_token() -> Option<String> {
    if dev_override_forces_free() {
        return None;
    }
    let path = o8_data_dir().join("entitlement.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let token = value.get("licenseKey")?.as_str()?.trim().to_string();
    if token.is_empty() || token.split('.').count() != 3 {
        return None;
    }
    Some(token)
}

/// The effective plan string from `~/.o8/entitlement.json` (`plan` field), or
/// None when absent/invalid. Read-only; never panics. Honors the "View as Free"
/// dev override for parity with the TS entitlement resolver.
pub fn read_plan() -> Option<String> {
    if dev_override_forces_free() {
        return Some("free".to_string());
    }
    let path = o8_data_dir().join("entitlement.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let plan = value.get("plan")?.as_str()?.trim().to_string();
    if plan.is_empty() {
        return None;
    }
    Some(plan)
}

/// Where a Gemini `generateContent` call should go.
pub enum GeminiTarget {
    /// Direct Google API — authenticate in a header so diagnostics never carry
    /// the provider key as part of a URL.
    Direct { url: String, api_key: String },
    /// Managed proxy — Bearer plan token; the caller MUST add a top-level
    /// `model` field to the JSON body (Google's model lives in the URL we own).
    Proxy { url: String, token: String },
}

/// Who pays for a voice call (#3583): a paid plan first, then the user's own
/// key, then a free-plan token. A free plan never outranks the user's key.
#[derive(Debug, PartialEq, Eq)]
enum Payer {
    Plan(String),
    Key(String),
}

fn choose_payer(paid_token: Option<String>, key: Option<String>, any_token: Option<String>) -> Option<Payer> {
    paid_token
        .map(Payer::Plan)
        .or_else(|| key.map(Payer::Key))
        .or_else(|| any_token.map(Payer::Plan))
}

/// The license token, only when the effective plan is paid.
fn paid_plan_token() -> Option<String> {
    match read_plan() {
        Some(plan) if plan != "free" => read_license_token(),
        _ => None,
    }
}

/// Resolve a Gemini `generateContent` route: paid plan → proxy; else local key
/// → direct; else free-plan token → proxy; else None.
pub fn resolve_gemini(model: &str) -> Option<GeminiTarget> {
    let paid = paid_plan_token();
    let key = if paid.is_some() { None } else { crate::stt::keys::get_gemini_key() };
    match choose_payer(paid, key, read_license_token())? {
        Payer::Key(key) => Some(GeminiTarget::Direct {
            url: format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"),
            api_key: key,
        }),
        Payer::Plan(token) => Some(GeminiTarget::Proxy {
            url: format!("{}/v1/gemini", proxy_base_url()),
            token,
        }),
    }
}

/// A resolved Bearer-auth HTTP target (OpenRouter audio / transcribe).
pub struct BearerTarget {
    pub url: String,
    pub bearer: String,
    pub managed: bool,
}

/// Resolve the Whisper transcription route: paid plan → proxy `/v1/transcribe`;
/// else local OpenRouter key → direct; else free-plan token → proxy; else None.
/// Body + headers are identical either way — only the URL + bearer change.
pub fn resolve_transcribe() -> Option<BearerTarget> {
    let paid = paid_plan_token();
    let key = if paid.is_some() { None } else { crate::stt::keys::get_openrouter_key() };
    match choose_payer(paid, key, read_license_token())? {
        Payer::Key(key) => Some(BearerTarget {
            url: "https://openrouter.ai/api/v1/audio/transcriptions".to_string(),
            bearer: key,
            managed: false,
        }),
        Payer::Plan(token) => Some(BearerTarget {
            url: format!("{}/v1/transcribe", proxy_base_url()),
            bearer: token,
            managed: true,
        }),
    }
}

#[cfg(test)]
mod payer_tests {
    use super::{choose_payer, Payer};

    fn some(value: &str) -> Option<String> {
        Some(value.to_string())
    }

    #[test]
    fn a_paid_plan_pays_before_the_users_key() {
        assert_eq!(choose_payer(some("paid"), some("key"), some("paid")), Some(Payer::Plan("paid".into())));
    }

    #[test]
    fn the_users_key_outranks_a_free_plan_token() {
        assert_eq!(choose_payer(None, some("key"), some("free")), Some(Payer::Key("key".into())));
        assert_eq!(choose_payer(None, None, some("free")), Some(Payer::Plan("free".into())));
        assert_eq!(choose_payer(None, None, None), None);
    }
}
